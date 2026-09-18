import neo4j, {
  type Driver,
  type Session,
  type Transaction,
  type Result,
  type Record as NeoRecord,
  type ResultSummary,
} from 'neo4j-driver'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  neoQuerySchema,
  neoNextSchema,
  neoConfirmation,
  type NeoQueryInput,
  type NeoNextInput,
  type NeoPage,
} from '../../shared/neo4j'
import { openTransport, type Transport } from './transport'
import { cypherQuery, neoParameters, NeoValues, NeoInputError } from './neo4j-values'
interface Running {
  driver: Driver
  session: Session
  transaction: Transaction
  result: Result
  iterator: AsyncIterator<NeoRecord, ResultSummary>
  columns: string[]
  token?: string
  requestId: string
  database: string
  mode: 'read' | 'mutation'
  pageSize: number
  rows: number
  bytes: number
  started: number
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
  closed: boolean
  committing: boolean
  stopped: Promise<never>
  stop: (message: string) => void
  cleanup?: Promise<void>
}
interface Live {
  profile: ConnectionProfile
  driver: Driver
  factory: () => Driver
  transport: Transport
  directory?: string
  status: ConnectionStatus
  sessions: Map<string, Running>
}
function guarded<T>(running: Running, operation: Promise<T>): Promise<T> {
  return Promise.race([operation, running.stopped])
}
async function boundedCleanup(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
function message(error: unknown, uncertain = false) {
  if (error instanceof NeoInputError)
    return (
      error.message +
      (uncertain ? ' The mutation outcome is unconfirmed; inspect the database before retrying.' : '')
    )
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^Neo\.[A-Za-z0-9_.]{1,120}$/.test(error.code)
      ? error.code
      : 'connection_or_query_failure'
  return `Neo4j operation failed (${code}). Review Cypher, parameter types, permissions and connectivity. ${uncertain ? 'The transaction outcome is uncertain; inspect the database before starting another mutation. ' : ''}No query or mutation was replayed.`
}
export class Neo4jService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'neo4j') throw new NeoInputError('Use the Neo4j adapter.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id),
      started = performance.now()
    let driver: Driver | undefined, transport: Transport | undefined, directory: string | undefined
    try {
      if (!profile.username || !secrets.password)
        throw new NeoInputError('Enter the Neo4j username and password.')
      if (!profile.database || profile.database.toLowerCase() === 'system')
        throw new NeoInputError(
          'Choose an explicit user database, normally neo4j. The system database is excluded.',
        )
      if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
        throw new NeoInputError('Neo4j TLS requires certificate and hostname verification.')
      if (profile.ssh.enabled && profile.tls.enabled)
        throw new NeoInputError(
          'Combined SSH and Neo4j TLS is not supported because the original hostname must remain verifiable.',
        )
      if (profile.tls.cert || profile.tls.keyPath)
        throw new NeoInputError('Neo4j client certificate authentication is not enabled in this adapter.')
      transport = await openTransport(profile, secrets)
      let trustedCertificates: string[] | undefined
      if (profile.tls.enabled && profile.tls.ca) {
        directory = await mkdtemp(join(tmpdir(), 'harbor-neo4j-ca-'))
        const path = join(directory, 'ca.pem')
        await writeFile(path, profile.tls.ca, { mode: 0o600 })
        trustedCertificates = [path]
      }
      const uri = `bolt://${transport.host.includes(':') ? '[' + transport.host + ']' : transport.host}:${transport.port}`
      const factory = () =>
        neo4j.driver(uri, neo4j.auth.basic(profile.username, secrets.password!), {
          encrypted: profile.tls.enabled,
          trust: trustedCertificates
            ? 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES'
            : 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES',
          trustedCertificates,
          maxConnectionPoolSize: 1,
          fetchSize: 1,
          maxTransactionRetryTime: 0,
          disableAutoCommitRetries: true,
          disableLosslessIntegers: false,
          connectionTimeout: profile.connectTimeout,
          connectionAcquisitionTimeout: profile.connectTimeout,
          telemetryDisabled: true,
          userAgent: 'Harbor-DB',
        })
      driver = factory()
      const info = await driver.getServerInfo({ database: profile.database })
      if (!info.agent || !/^Neo4j\/5\.26\./.test(info.agent))
        throw new NeoInputError(
          'This adapter targets verified Neo4j 5.26.x Bolt semantics; choose a supported server version.',
        )
      if (this.generations.get(profile.id) !== generation) {
        await driver.close()
        await transport.close()
        if (directory) await rm(directory, { recursive: true, force: true })
        return { state: 'disconnected' }
      }
      const status: ConnectionStatus = {
        state: 'connected',
        version: info.agent.replace('/', ' '),
        durationMs: Math.round(performance.now() - started),
        transport: `${profile.ssh.enabled ? 'Verified SSH + ' : ''}${profile.tls.enabled ? 'Verified TLS Bolt' : 'Bolt'}`,
        lastConnectedAt: new Date().toISOString(),
      }
      this.connections.set(profile.id, {
        profile,
        driver,
        factory,
        transport,
        directory,
        status,
        sessions: new Map(),
      })
      return status
    } catch (error) {
      await driver?.close().catch(() => {})
      await transport?.close()
      if (directory) await rm(directory, { recursive: true, force: true })
      const status: ConnectionStatus = { state: 'failed', error: message(error) }
      if (this.generations.get(profile.id) === generation) this.states.set(profile.id, status)
      return status
    }
  }
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live) throw new NeoInputError('Connect to Neo4j before running this operation.')
    return live
  }
  async databases(id: string): Promise<string[]> {
    const live = this.live(id),
      session = live.driver.session({
        database: 'system',
        defaultAccessMode: neo4j.session.READ,
        fetchSize: 100,
        disableAutoCommitRetries: true,
      })
    try {
      const result = await session.run(
        "SHOW DATABASES YIELD name WHERE name <> 'system' RETURN name LIMIT 101",
        {},
        { timeout: live.profile.queryTimeout },
      )
      if (result.records.length > 100)
        throw new NeoInputError('More than 100 databases are visible. Enter an exact database instead.')
      return result.records.map((row) => String(row.get('name')))
    } catch (error) {
      throw new Error(message(error))
    } finally {
      await session.close()
    }
  }
  async query(raw: NeoQueryInput): Promise<NeoPage> {
    const input = neoQuerySchema.parse(raw),
      live = this.live(input.connectionId)
    if (input.database.toLowerCase() === 'system')
      throw new NeoInputError('The system database is excluded from graph queries.')
    if (live.sessions.has(input.sessionId))
      throw new NeoInputError('Close the current cursor before running a new query in this tab.')
    if (live.sessions.size >= 2)
      throw new NeoInputError('Two Neo4j cursors are already open. Close one before starting another.')
    if (
      input.mode === 'mutation' &&
      (live.profile.readOnly || input.confirm !== neoConfirmation(input.connectionId, input.database))
    )
      throw new NeoInputError('Mutations require a writable profile and exact reviewed target confirmation.')
    const cypher = cypherQuery(input.cypher, input.mode),
      parameters = neoParameters(input.parameters),
      driver = live.factory(),
      session = driver.session({
        database: input.database,
        defaultAccessMode: input.mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE,
        fetchSize: 1,
        disableAutoCommitRetries: true,
      }),
      transaction = session.beginTransaction({ timeout: Math.min(live.profile.queryTimeout, 60000) })
    const result = transaction.run(cypher, parameters)
    let stop!: (message: string) => void
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = (message) => reject(new NeoInputError(message))
    })
    void stopped.catch(() => {})
    const running: Running = {
      stopped,
      stop,
      driver,
      session,
      transaction,
      result,
      iterator: result[Symbol.asyncIterator](),
      columns: [],
      requestId: input.requestId,
      database: input.database,
      mode: input.mode,
      pageSize: input.pageSize,
      rows: 0,
      bytes: 0,
      started: performance.now(),
      busy: true,
      closed: false,
      committing: false,
    }
    live.sessions.set(input.sessionId, running)
    running.timer = setTimeout(
      () => {
        if (!running.closed) {
          running.stop(
            'Neo4j execution reached its deadline. The dedicated connection was closed; no work was replayed.',
          )
          void this.finish(live, input.sessionId, running)
        }
      },
      Math.min(live.profile.queryTimeout, 60000),
    )
    running.timer.unref()
    try {
      running.columns = await guarded(running, result.keys())
      if (running.columns.length > 200) throw new NeoInputError('Project at most 200 columns.')
      return await this.page(live, input.sessionId, running)
    } catch (error) {
      return await this.failed(live, input.sessionId, running, error)
    }
  }
  async next(raw: NeoNextInput): Promise<NeoPage> {
    const input = neoNextSchema.parse(raw),
      live = this.live(input.connectionId),
      running = live.sessions.get(input.sessionId)
    if (!running || running.closed || running.token !== input.cursor)
      throw new NeoInputError(
        'The Neo4j cursor expired, closed or belongs to another tab. Run again explicitly.',
      )
    if (running.busy) throw new NeoInputError('Wait for the current page before requesting another.')
    running.busy = true
    running.token = undefined
    running.requestId = input.requestId
    try {
      return await this.page(live, input.sessionId, running)
    } catch (error) {
      return await this.failed(live, input.sessionId, running, error)
    }
  }
  private async page(live: Live, sessionId: string, running: Running): Promise<NeoPage> {
    const values = new NeoValues(),
      rows: NeoPage['rows'] = [],
      maximum = running.mode === 'mutation' ? 500 : running.pageSize
    let summary: ResultSummary | undefined
    while (rows.length < maximum) {
      if (running.closed)
        throw new NeoInputError(
          'This Neo4j query was cancelled or reached its deadline. No work was replayed.',
        )
      const item = await guarded(running, running.iterator.next())
      if (item.done) {
        summary = item.value
        break
      }
      const row = Array.from(item.value.values()).map((value) => values.cell(value))
      running.bytes += Buffer.byteLength(JSON.stringify(row))
      running.rows++
      if (running.bytes > 8 * 1024 * 1024 || running.rows > 1000)
        throw new NeoInputError(
          'This query reached the 1,000 row / 8 MiB execution bound. Narrow the query; any uncommitted mutation is stopped.',
        )
      rows.push(row)
    }
    if (!summary) {
      const peek = await guarded(
        running,
        (running.iterator as ReturnType<Result[typeof Symbol.asyncIterator]>).peek(),
      )
      if (peek.done) summary = peek.value
    }
    if (running.closed) throw new NeoInputError('This Neo4j query was cancelled or reached its deadline.')
    let counters: Record<string, number> | undefined
    if (summary) {
      if (running.mode === 'mutation') {
        running.committing = true
        await guarded(running, running.transaction.commit())
        counters = summary.counters.updates()
      } else await guarded(running, running.transaction.rollback())
      await this.finish(live, sessionId, running)
    } else if (running.mode === 'mutation')
      throw new NeoInputError(
        'Mutation returned more than 500 rows. Reduce its returned projection; it was not committed.',
      )
    else {
      running.token = randomUUID()
      running.busy = false
    }
    return {
      database: running.database,
      columns: running.columns,
      rows,
      cursor: running.token,
      nodes: [...values.nodes.values()],
      relationships: [...values.relationships.values()],
      graphTruncated: values.truncated,
      durationMs: Math.round(performance.now() - running.started),
      rowsRead: running.rows,
      mutationAcknowledged: running.mode === 'mutation',
      counters,
      warning:
        'Pages continue one execution without rerunning Cypher. Read-committed isolation is not a snapshot. Cursors expire at the configured deadline (maximum 60 seconds). Graph display is limited to 200 nodes and 400 relationships per page.',
    }
  }
  private async failed(live: Live, sessionId: string, running: Running, error: unknown): Promise<never> {
    let rolledBack = false
    if (running.mode === 'mutation' && !running.committing && !running.closed)
      rolledBack = await boundedCleanup(
        (async () => {
          // Explicitly discard the asynchronous stream before rollback. The driver can
          // otherwise wait for a paused consumer forever when many records remain.
          await running.iterator.return?.()
          await running.transaction.rollback()
        })(),
        3000,
      )
    await this.finish(live, sessionId, running)
    const uncertain = running.mode === 'mutation' && !rolledBack
    throw new Error(
      message(error, uncertain) +
        (rolledBack && running.mode === 'mutation' ? ' The native transaction was rolled back.' : ''),
    )
  }
  private async finish(live: Live, sessionId: string, running: Running) {
    if (running.cleanup) return running.cleanup
    running.closed = true
    if (running.timer) clearTimeout(running.timer)
    if (live.sessions.get(sessionId) === running) live.sessions.delete(sessionId)
    running.cleanup = (async () => {
      // Driver.close closes this execution's actual sockets, including acquired ones.
      // A paused SDK iterator may leave session cleanup pending after transport closure.
      await boundedCleanup(running.driver.close(), 1000)
      await boundedCleanup(running.session.close(), 1000)
    })()
    return running.cleanup
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const live = this.live(input.connectionId),
      running = live.sessions.get(input.sessionId)
    if (!running || running.requestId !== input.requestId)
      return { requested: false, message: 'No matching Neo4j request is running.' }
    if (running.committing)
      return {
        requested: false,
        message:
          'Commit was dispatched. Wait for its outcome and inspect the database if acknowledgment is lost.',
      }
    running.stop(
      'Neo4j query cancelled. The dedicated connection was closed; server cleanup is not acknowledged.',
    )
    await this.finish(live, input.sessionId, running)
    return {
      requested: true,
      message:
        'The dedicated query connection was closed. Server cleanup is not acknowledged; no work will be replayed.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }) {
    const live = this.connections.get(input.connectionId),
      running = live?.sessions.get(input.sessionId)
    if (live && running) {
      if (running.committing)
        throw new NeoInputError('Wait for the dispatched commit outcome before closing this session.')
      running.stop('Neo4j cursor closed. Run again explicitly; no work was replayed.')
      await this.finish(live, input.sessionId, running)
    }
  }
  async disconnect(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (live) {
      await Promise.all(
        [...live.sessions.entries()].map(([session, running]) => {
          running.stop('Neo4j disconnected. A dispatched commit may be uncertain; no work was replayed.')
          return this.finish(live, session, running)
        }),
      )
      await live.driver.close()
      await live.transport.close()
      if (live.directory) await rm(live.directory, { recursive: true, force: true })
    }
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
