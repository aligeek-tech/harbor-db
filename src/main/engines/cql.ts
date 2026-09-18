import cassandra from 'cassandra-driver'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  cqlExecuteSchema,
  cqlNextSchema,
  cqlConfirmation,
  type CqlExecute,
  type CqlTable,
  type CqlPage,
} from '../../shared/cql'
import { openTransport, type Transport } from './transport'
import { cqlBridge, type CqlBridge } from './cql-transport'
import { CqlInputError, cqlParameters, cqlCell } from './cql-values'
import { guardCql } from './cql-guard'
interface Bundle {
  client: cassandra.Client
  bridge: CqlBridge
}
interface Cursor {
  session: string
  input: CqlExecute
  state: string
  identity: string
  rows: number
  bytes: number
  pages: number
  expires: number
}
interface Running {
  request: string
  bundle?: Bundle
  cancelled: boolean
  submitted: boolean
  stop: (message: string) => void
  stopped: Promise<never>
}
interface Live {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  status: ConnectionStatus
  active: Map<string, Running>
  cursors: Map<string, Cursor>
}
const retry = new cassandra.policies.retry.FallthroughRetryPolicy()
function errorText(error: unknown, uncertain = false): Error {
  // Protocol rejections before execution are definitive. Timeouts, failures and
  // unknown response codes retain the uncertain-outcome boundary.
  const rejected =
    error instanceof cassandra.errors.ResponseError &&
    [0x0100, 0x1000, 0x2000, 0x2100, 0x2200, 0x2300, 0x2400, 0x2500].includes(error.code)
  const suffix =
    uncertain && !rejected
      ? ' The submitted mutation outcome is uncertain; inspect the exact primary key before retrying.'
      : ''
  if (error instanceof CqlInputError) return new CqlInputError(error.message + suffix)
  const code =
    error instanceof cassandra.errors.ResponseError
      ? `native code ${error.code}`
      : 'connection_or_query_failure'
  return new CqlInputError(
    `CQL operation failed (${code}). Check the reviewed query, typed values, consistency, privileges and connectivity.${suffix} No transport or timeout failure was retried.`,
  )
}
async function dispose(bundle: Bundle | undefined) {
  if (!bundle) return
  await bundle.bridge.close()
  void bundle.client.shutdown().catch(() => {})
}
export class CqlService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }
  }
  private async bundle(live: Live): Promise<Bundle> {
    const bridge = await cqlBridge(live.profile, live.transport)
    try {
      const client = new cassandra.Client({
        contactPoints: ['127.0.0.1'],
        localDataCenter: live.profile.cql.dataCenter,
        protocolOptions: { port: bridge.port, maxVersion: 4, maxSchemaAgreementWaitSeconds: 0 },
        authProvider: new cassandra.auth.PlainTextAuthProvider(live.profile.username, live.secrets.password!),
        isMetadataSyncEnabled: false,
        prepareOnAllHosts: false,
        rePrepareOnUp: false,
        maxPrepared: 100,
        monitorReporting: { enabled: false },
        encoding: { map: Map, set: Set },
        pooling: {
          coreConnectionsPerHost: {
            [cassandra.types.distance.local]: 1,
            [cassandra.types.distance.remote]: 0,
          },
          maxRequestsPerConnection: 4,
          warmup: false,
        },
        socketOptions: {
          connectTimeout: live.profile.connectTimeout,
          readTimeout: Math.min(live.profile.queryTimeout, 60000),
          defunctReadTimeoutThreshold: 0,
        },
        policies: {
          loadBalancing: new cassandra.policies.loadBalancing.AllowListPolicy(
            new cassandra.policies.loadBalancing.DCAwareRoundRobinPolicy(live.profile.cql.dataCenter),
            ['127.0.0.1:' + bridge.port],
          ),
          retry,
          speculativeExecution: new cassandra.policies.speculativeExecution.NoSpeculativeExecutionPolicy(),
        },
        queryOptions: {
          prepare: true,
          autoPage: false,
          fetchSize: 100,
          isIdempotent: false,
          retry,
          consistency: cassandra.types.consistencies.localOne,
        },
      })
      return { client, bridge }
    } catch (error) {
      await bridge.close()
      throw error
    }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'cassandra') throw new CqlInputError('Use a Cassandra profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id),
      started = performance.now()
    let transport: Transport | undefined
    try {
      if (!profile.username || !secrets.password)
        throw new CqlInputError('Explicit Cassandra username and password are required.')
      if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
        throw new CqlInputError('CQL TLS requires certificate and hostname verification.')
      transport = await openTransport(profile, secrets)
      const live: Live = {
        profile,
        secrets,
        transport,
        status: { state: 'connecting' },
        active: new Map(),
        cursors: new Map(),
      }
      await this.operation(live, randomUUID(), randomUUID(), async (run, client) => {
        const result = await this.call(run, () =>
            client.execute('SELECT release_version, cluster_name, data_center FROM system.local', [], {
              prepare: false,
              fetchSize: 1,
            }),
          ),
          row = result.first()
        if (!row || !/^5\.0\./.test(String(row.release_version)))
          throw new CqlInputError(
            'This Cassandra adapter targets verified Apache Cassandra 5.0.x semantics. Scylla requires separate product validation.',
          )
        if (row.data_center !== profile.cql.dataCenter)
          throw new CqlInputError(
            'The configured local data center differs from the selected Cassandra endpoint.',
          )
        live.status = {
          state: 'connected',
          version: 'Apache Cassandra ' + row.release_version,
          durationMs: Math.round(performance.now() - started),
          transport: `Single endpoint · ${profile.ssh.enabled ? 'verified SSH + ' : ''}${profile.tls.enabled ? 'verified TLS' : 'CQL v4'}`,
          lastConnectedAt: new Date().toISOString(),
        }
        return undefined
      })
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      this.connections.set(profile.id, live)
      return live.status
    } catch (error) {
      await transport?.close()
      const status: ConnectionStatus = { state: 'failed', error: errorText(error).message }
      if (this.generations.get(profile.id) === generation) this.states.set(profile.id, status)
      return status
    }
  }
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live) throw new CqlInputError('Connect to Cassandra first.')
    for (const [id, cursor] of live.cursors) if (cursor.expires < Date.now()) live.cursors.delete(id)
    return live
  }
  private async call<T>(run: Running, work: () => Promise<T>): Promise<T> {
    if (run.cancelled)
      throw new CqlInputError('CQL request stopped locally. Server completion is not acknowledged.')
    return Promise.race([work(), run.stopped])
  }
  private async operation<T>(
    live: Live,
    session: string,
    request: string,
    work: (run: Running, client: cassandra.Client) => Promise<T>,
  ): Promise<T> {
    if (live.active.size >= 2)
      throw new CqlInputError('Two CQL requests are already active. Wait before retrying.')
    if (live.active.has(session)) throw new CqlInputError('Wait for the request in this workspace.')
    let stop!: (message: string) => void
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = (message) => reject(new CqlInputError(message))
    })
    void stopped.catch(() => {})
    const run: Running = { request, cancelled: false, submitted: false, stop, stopped }
    live.active.set(session, run)
    const timer = setTimeout(
      () => {
        run.cancelled = true
        run.stop('CQL deadline reached. Local sockets are closed; server completion is not acknowledged.')
        void dispose(run.bundle)
      },
      Math.min(live.profile.queryTimeout, 60000),
    )
    try {
      run.bundle = await this.bundle(live)
      if (run.cancelled) throw new CqlInputError('CQL request stopped before connection.')
      await this.call(run, () => run.bundle!.client.connect())
      return await work(run, run.bundle.client)
    } catch (error) {
      throw errorText(error, run.submitted)
    } finally {
      clearTimeout(timer)
      await dispose(run.bundle)
      if (live.active.get(session) === run) live.active.delete(session)
    }
  }
  private keyspace(name: string) {
    if (!name || name.toLowerCase().startsWith('system'))
      throw new CqlInputError('Choose an explicit user keyspace. System keyspaces are excluded.')
  }
  async keyspaces(id: string) {
    const live = this.live(id)
    return this.operation(live, randomUUID(), randomUUID(), async (run, client) => {
      const result = await this.call(run, () =>
        client.execute('SELECT keyspace_name FROM system_schema.keyspaces LIMIT 101', [], {
          prepare: false,
          fetchSize: 101,
        }),
      )
      if (result.rows.length > 100 || result.pageState)
        throw new CqlInputError('More than 100 keyspaces are visible. Enter an exact keyspace.')
      return result.rows
        .map((row) => String(row.keyspace_name))
        .filter((name) => !name.toLowerCase().startsWith('system'))
    })
  }
  async tables(input: { connectionId: string; keyspace: string }) {
    this.keyspace(input.keyspace)
    const live = this.live(input.connectionId)
    return this.operation(live, randomUUID(), randomUUID(), async (run, client) => {
      const result = await this.call(run, () =>
        client.execute(
          'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? LIMIT 101',
          [input.keyspace],
          { fetchSize: 101 },
        ),
      )
      if (result.rows.length > 100 || result.pageState)
        throw new CqlInputError('More than 100 tables are visible. Enter an exact table.')
      return result.rows.map((row) => String(row.table_name))
    })
  }
  private async metadata(
    run: Running,
    client: cassandra.Client,
    keyspace: string,
    name: string,
  ): Promise<CqlTable> {
    this.keyspace(keyspace)
    const table = (
      await this.call(run, () =>
        client.execute('SELECT id FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?', [
          keyspace,
          name,
        ]),
      )
    ).first()
    if (!table) throw new CqlInputError('The selected CQL table does not exist or is not visible.')
    const result = await this.call(run, () =>
      client.execute(
        'SELECT column_name, type, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ? LIMIT 201',
        [keyspace, name],
        { fetchSize: 201 },
      ),
    )
    if (result.rows.length > 200 || result.pageState)
      throw new CqlInputError('CQL tables with more than 200 columns are excluded from this workspace.')
    const columns = result.rows.map((row) => ({
        name: String(row.column_name),
        type: String(row.type),
        kind: String(row.kind),
        position: Number(row.position),
      })),
      keys = (kind: string) =>
        columns
          .filter((column) => column.kind === kind)
          .sort((a, b) => a.position - b.position)
          .map((column) => column.name)
    return {
      id: String(table.id),
      keyspace,
      name,
      columns,
      partition: keys('partition_key'),
      clustering: keys('clustering'),
    }
  }
  async structure(input: { connectionId: string; keyspace: string; table: string }) {
    const live = this.live(input.connectionId)
    return this.operation(live, randomUUID(), randomUUID(), (run, client) =>
      this.metadata(run, client, input.keyspace, input.table),
    )
  }
  async execute(raw: CqlExecute): Promise<CqlPage> {
    const input = cqlExecuteSchema.parse(raw),
      live = this.live(input.connectionId)
    this.keyspace(input.keyspace)
    if (
      input.mode === 'mutation' &&
      (live.profile.readOnly ||
        input.confirm !== cqlConfirmation(input.connectionId, input.keyspace, input.table))
    )
      throw new CqlInputError('Mutation requires a writable profile and exact keyspace/table confirmation.')
    if ([...live.cursors.values()].some((cursor) => cursor.session === input.sessionId))
      throw new CqlInputError('Close the current CQL cursor before running another statement.')
    if (live.cursors.size + live.active.size >= 20)
      throw new CqlInputError('Close an existing CQL cursor before starting another.')
    return this.operation(live, input.sessionId, input.requestId, async (run, client) => {
      const table = await this.metadata(run, client, input.keyspace, input.table)
      return this.page(
        live,
        run,
        client,
        {
          session: input.sessionId,
          input,
          state: '',
          identity: table.id,
          rows: 0,
          bytes: 0,
          pages: 0,
          expires: Date.now() + 600000,
        },
        table,
      )
    })
  }
  async next(raw: Parameters<import('../../shared/cql').CqlAPI['cqlNext']>[0]) {
    const input = cqlNextSchema.parse(raw),
      live = this.live(input.connectionId),
      cursor = live.cursors.get(input.cursor)
    if (!cursor || cursor.session !== input.sessionId)
      throw new CqlInputError('CQL cursor expired, closed or belongs to another workspace.')
    live.cursors.delete(input.cursor)
    return this.operation(live, input.sessionId, input.requestId, async (run, client) => {
      const table = await this.metadata(run, client, cursor.input.keyspace, cursor.input.table)
      if (table.id !== cursor.identity)
        throw new CqlInputError('The CQL table was recreated. Start a new reviewed query.')
      return this.page(live, run, client, cursor, table)
    })
  }
  private async page(
    live: Live,
    run: Running,
    client: cassandra.Client,
    cursor: Cursor,
    table: CqlTable,
  ): Promise<CqlPage> {
    const input = cursor.input,
      query = guardCql(input, table),
      parameters = cqlParameters(input.parameters)
    run.submitted = query.mutation
    const result = await this.call(run, () =>
      client.execute(query.cql, parameters, {
        prepare: true,
        autoPage: false,
        isIdempotent: false,
        retry,
        fetchSize: Math.min(input.pageSize, 1000 - cursor.rows),
        pageState: cursor.state || undefined,
        consistency: cassandra.types.consistencies[input.consistency],
        serialConsistency: cassandra.types.consistencies.localSerial,
      }),
    )
    run.submitted = false
    const columns = result.columns.map((column) => ({
        name: column.name,
        type:
          table.columns.find((field) => field.name === column.name)?.type ||
          Object.entries(cassandra.types.dataTypes).find(([, value]) => value === column.type.code)?.[0] ||
          'native',
      })),
      rows = result.rows.map((row) => columns.map((column) => cqlCell(row.get(column.name))))
    cursor.rows += rows.length
    cursor.bytes += Buffer.byteLength(JSON.stringify(rows))
    cursor.pages++
    if (cursor.rows > 1000 || cursor.bytes > 8 * 1024 * 1024)
      throw new CqlInputError(
        'CQL traversal reached its 1,000 row / 8 MiB bound. Narrow the projection or partition.',
      )
    let token: string | undefined
    if (!query.mutation && result.pageState && cursor.rows < 1000 && cursor.pages < 10) {
      if (result.pageState.length > 131072) throw new CqlInputError('CQL paging state exceeds its bound.')
      token = randomUUID()
      cursor.state = result.pageState
      live.cursors.set(token, cursor)
    }
    const applied = query.mutation ? result.wasApplied() : undefined
    if (query.mutation) live.cursors.clear()
    return {
      keyspace: table.keyspace,
      table: table.name,
      columns,
      rows,
      cursor: token,
      rowsRead: cursor.rows,
      consistency: input.consistency,
      acknowledged: query.mutation,
      applied,
      warning: `Native CQL has no relational transaction/rollback here. Pages are not a snapshot. LIMIT/fetch size does not make unrestricted filtering cheap. ${result.pageState && !token ? 'Traversal stopped at the configured row/page bound. ' : ''}${query.mutation ? (applied ? 'Conditional mutation applied and acknowledged.' : 'Native conditional mutation was not applied; review current values.') : ''}`,
    }
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const live = this.live(input.connectionId),
      run = live.active.get(input.sessionId)
    if (!run || run.request !== input.requestId)
      return { requested: false, message: 'No matching CQL request is active.' }
    run.cancelled = true
    run.stop('CQL request cancelled locally. Server completion or rollback is not acknowledged.')
    await dispose(run.bundle)
    return {
      requested: true,
      message:
        'Dedicated local sockets closed. A submitted mutation may be uncertain; inspect the exact key before retrying.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }) {
    const live = this.connections.get(input.connectionId)
    if (!live) return
    const run = live.active.get(input.sessionId)
    if (run) await this.cancel({ ...input, requestId: run.request })
    for (const [key, cursor] of live.cursors) if (cursor.session === input.sessionId) live.cursors.delete(key)
  }
  async disconnect(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (live) {
      for (const run of live.active.values()) {
        run.cancelled = true
        run.stop('CQL disconnected. Server completion is not acknowledged.')
        await dispose(run.bundle)
      }
      live.cursors.clear()
      await live.transport.close()
    }
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
