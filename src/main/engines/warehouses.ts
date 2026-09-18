import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  ObjectInfo,
  QueryInput,
  QueryResult,
  ResultColumn,
  ResultSet,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import type { TrinoProgress } from '../../shared/trino'
import { sqlSafety } from '../../shared/sql'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import {
  CloudHttpError,
  CloudJson,
  exact,
  list,
  record,
  string,
  type JsonEndpoint,
  type JsonRecord,
} from './cloud-json'

type Engine = 'snowflake' | 'databricks'
interface Operation {
  requestId: string
  submissionId: string
  nativeId?: string
  controller: AbortController
  cancelled: boolean
  progress: TrinoProgress
  stopping?: Promise<void>
  done?: Promise<void>
}
interface Live {
  profile: ConnectionProfile
  http: JsonEndpoint
  status: ConnectionStatus
  active: Map<string, Operation>
  progress: Map<string, TrinoProgress>
}
const identifier = (engine: Engine, value: string) => {
  if (!value || /[\r\n\0]/.test(value))
    throw new Error('Invalid empty or control-bearing warehouse identifier.')
  const q = engine === 'snowflake' ? '"' : '`'
  return q + value.replaceAll(q, q + q) + q
}
const literal = (value: string) => {
  if (/[\r\n\0\\]/.test(value))
    throw new Error('This catalog filter requires an identifier without control characters or backslashes.')
  return "'" + value.replaceAll("'", "''") + "'"
}
const nativeId = (value: unknown) => {
  const id = string(value)
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid warehouse statement identifier.')
  return id
}
const index = (value: unknown) => {
  const text = exact(value)
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000)
    throw new Error('Warehouse page index exceeds the supported bound.')
  return n
}
export function warehouseRows(engine: Engine, value: unknown, columns: ResultColumn[]): Cell[][] {
  return list(value || []).map((raw) => {
    const row = list(raw)
    if (row.length !== columns.length) throw new Error('Warehouse row shape differs from its metadata.')
    return row.map((cell, ordinal) => {
      if (cell === null) return null
      const text = string(cell),
        type = columns[ordinal].type.toLowerCase()
      if (type === 'boolean') {
        if (!['true', 'false'].includes(text)) throw new Error('Invalid warehouse boolean representation.')
        return text === 'true'
      }
      if (engine === 'snowflake' && type === 'binary') {
        if (!/^(?:[a-fA-F0-9]{2})*$/.test(text)) throw new Error('Invalid Snowflake binary encoding.')
        return { type: 'binary', base64: Buffer.from(text, 'hex').toString('base64') }
      }
      // Databricks INLINE complex/binary fields retain the documented provider text and native type.
      // Do not infer or decode undocumented encodings without real-service evidence.
      return text
    })
  })
}

/** Separate native REST statement lifecycles. Shared code covers only bounded transport and local ownership. */
export class WarehouseService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  constructor(
    readonly engine: Engine,
    private endpoint: (profile: ConnectionProfile, token: string) => JsonEndpoint = (profile, token) =>
      new CloudJson(
        profile.host,
        token,
        profile.queryTimeout,
        profile.engine === 'snowflake'
          ? { 'X-Snowflake-Authorization-Token-Type': profile.warehouse.snowflakeTokenType }
          : {},
        profile.tls.ca || undefined,
        profile.engine === 'snowflake',
      ),
  ) {}
  private live(id: string): Live {
    const live = this.connections.get(id)
    if (!live) throw new Error(`Connect explicitly to ${this.engine}.`)
    return live
  }
  status(id: string): ConnectionStatus {
    return structuredClone(
      this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' },
    )
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    let http: JsonEndpoint | undefined
    try {
      if (
        profile.engine !== this.engine ||
        profile.port !== 443 ||
        !profile.tls.enabled ||
        !profile.tls.rejectUnauthorized ||
        profile.ssh.enabled
      )
        throw new Error(
          'Use the selected native warehouse endpoint on port443 with verified TLS; SSH is unavailable.',
        )
      const allowed =
        this.engine === 'snowflake'
          ? /^[a-z0-9][a-z0-9.-]*\.snowflakecomputing\.com$/i.test(profile.host)
          : /^[a-z0-9][a-z0-9.-]*\.(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/i.test(
              profile.host,
            )
      if (!allowed)
        throw new Error(
          'The host is not a supported official account/workspace endpoint. Private aliases and arbitrary proxies are not enabled.',
        )
      if (!profile.warehouse.warehouse)
        throw new Error('Select an explicit warehouse name or SQL warehouse ID.')
      if (!secrets.password)
        throw new Error(
          'Enter a scoped provider access token. Ambient credentials and automatic login are disabled.',
        )
      http = this.endpoint(profile, secrets.password)
      const live: Live = {
        profile: structuredClone(profile),
        http,
        status: { state: 'connecting' },
        active: new Map(),
        progress: new Map(),
      }
      this.connections.set(profile.id, live)
      if (this.engine === 'databricks') {
        const warehouse = await http.request(
          'GET',
          '/api/2.0/sql/warehouses/' + nativeId(profile.warehouse.warehouse),
        )
        if (warehouse.id !== profile.warehouse.warehouse || typeof warehouse.state !== 'string')
          throw new Error('The Databricks endpoint did not identify the selected SQL warehouse.')
        live.status = {
          state: 'connected',
          version: 'Databricks SQL REST (server build not reported)',
          transport: `Verified TLS · supplied token · warehouse ${warehouse.state} · no provisioning`,
          checkedAt: new Date().toISOString(),
        }
      } else {
        const version = await this.read(live, undefined, 'SELECT CURRENT_VERSION()', 1)
        if (!/^\d+\.\d+/.test(String(version.rows[0]?.[0])))
          throw new Error('The Snowflake endpoint did not report a recognizable server release.')
        live.status = {
          state: 'connected',
          version: `Snowflake ${String(version.rows[0][0]).slice(0, 100)}`,
          transport: `Verified TLS · ${profile.warehouse.snowflakeTokenType} · explicitly selected warehouse`,
          checkedAt: new Date().toISOString(),
        }
      }
      return structuredClone(live.status)
    } catch (error) {
      http?.close()
      this.connections.delete(profile.id)
      const status: ConnectionStatus = {
        state: error instanceof CloudHttpError && error.status === 401 ? 'authentication-failed' : 'failed',
        error: error instanceof Error ? error.message : 'Warehouse connection failed.',
        checkedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  private async stop(live: Live, op: Operation): Promise<void> {
    if (op.stopping) return op.stopping
    op.cancelled = true
    op.controller.abort()
    op.progress.cancellation = 'requested'
    op.stopping = (async () => {
      try {
        if (!op.nativeId) throw new Error('No native statement identity was acknowledged.')
        await live.http.request(
          'POST',
          this.engine === 'snowflake'
            ? `/api/v2/statements/${op.nativeId}/cancel`
            : `/api/2.0/sql/statements/${op.nativeId}/cancel`,
          {},
          AbortSignal.timeout(5000),
        )
        op.progress.cancellation = 'acknowledged'
      } catch {
        op.progress.cancellation = 'unconfirmed'
      }
    })()
    return op.stopping
  }
  private async pages(
    live: Live,
    op: Operation,
    sql: string,
    database: string | undefined,
    sink: { columns(value: ResultColumn[]): Promise<void>; row(value: Cell[]): Promise<boolean | void> },
  ): Promise<void> {
    const p = live.profile,
      snow = this.engine === 'snowflake'
    let body: JsonRecord
    if (snow)
      body = await live.http.request(
        'POST',
        `/api/v2/statements?async=true&nullable=true&requestId=${op.submissionId}`,
        {
          statement: sql,
          timeout: Math.max(1, Math.ceil(p.queryTimeout / 1000)),
          warehouse: p.warehouse.warehouse,
          ...(p.warehouse.role ? { role: p.warehouse.role } : {}),
          ...(database ? { database } : {}),
          ...(p.schema ? { schema: p.schema } : {}),
          parameters: {
            MULTI_STATEMENT_COUNT: '1',
            CLIENT_RESULT_CHUNK_SIZE: 16,
            BINARY_OUTPUT_FORMAT: 'HEX',
            DATE_OUTPUT_FORMAT: 'YYYY-MM-DD',
            TIME_OUTPUT_FORMAT: 'HH24:MI:SS.FF9',
            TIMESTAMP_NTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9',
            TIMESTAMP_LTZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
            TIMESTAMP_TZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
            TIMEZONE: 'UTC',
          },
        },
        op.controller.signal,
      )
    else {
      // Never call start/create warehouse. A stopped warehouse requires the user to manage its lifecycle separately.
      const warehouse = await live.http.request(
        'GET',
        '/api/2.0/sql/warehouses/' + nativeId(p.warehouse.warehouse),
        undefined,
        op.controller.signal,
      )
      if (warehouse.state !== 'RUNNING')
        throw new Error(
          'The selected Databricks SQL warehouse is not RUNNING. Harbor will not start or provision compute.',
        )
      body = await live.http.request(
        'POST',
        '/api/2.0/sql/statements',
        {
          warehouse_id: p.warehouse.warehouse,
          statement: sql,
          ...(database ? { catalog: database } : {}),
          ...(p.schema ? { schema: p.schema } : {}),
          wait_timeout: '0s',
          on_wait_timeout: 'CONTINUE',
          disposition: 'INLINE',
          format: 'JSON_ARRAY',
          byte_limit: 16 * 1024 * 1024,
        },
        op.controller.signal,
      )
    }
    op.nativeId = nativeId(snow ? body.statementHandle : body.statement_id)
    op.progress.queryId = op.nativeId
    for (;;) {
      if (snow) {
        if (body.resultSetMetaData) break
        if (!['333333', '333334'].includes(String(body.code || '')))
          throw new Error(
            'Snowflake statement failed or returned an unsupported status. Provider messages are omitted.',
          )
        op.progress.phase = 'RUNNING'
      } else {
        const status = record(body.status),
          phase = string(status.state)
        op.progress.phase = phase
        if (phase === 'SUCCEEDED') break
        if (!['PENDING', 'RUNNING'].includes(phase))
          throw new Error(
            `Databricks statement ${['FAILED', 'CANCELED', 'CLOSED'].includes(phase) ? phase : 'failed'}. Provider details are omitted.`,
          )
      }
      await delay(500, undefined, { signal: op.controller.signal })
      body = await live.http.request(
        'GET',
        snow ? `/api/v2/statements/${op.nativeId}` : `/api/2.0/sql/statements/${op.nativeId}`,
        undefined,
        op.controller.signal,
      )
    }
    let columns: ResultColumn[], first: unknown, pages: number | undefined, next: number | undefined
    if (snow) {
      const metadata = record(body.resultSetMetaData)
      columns = list(metadata.rowType).map((value) => {
        const column = record(value),
          type = string(column.type).toLowerCase()
        return {
          name: string(column.name),
          type: type === 'fixed' ? `fixed(${exact(column.precision)},${exact(column.scale)})` : type,
        }
      })
      pages = list(metadata.partitionInfo || [{}]).length
      first = body.data
      if (pages > 100000) throw new Error('Snowflake result partition count exceeds the supported bound.')
    } else {
      // Successful commands such as DDL may have no result manifest. A missing
      // manifest on a result-bearing response remains invalid, not an empty set.
      if (body.manifest === undefined && body.result === undefined) {
        await sink.columns([])
        op.progress.phase = 'SUCCEEDED'
        return
      }
      const manifest = record(body.manifest)
      if (manifest.truncated === true)
        throw new Error(
          'Databricks INLINE result exceeded the explicit16MiB limit. No partial result is represented as complete; narrow the query.',
        )
      columns = list(record(manifest.schema).columns).map((value) => {
        const column = record(value)
        return { name: string(column.name), type: string(column.type_text || column.type_name) }
      })
      const result = body.result ? record(body.result) : {}
      if (result.external_links)
        throw new Error('External result links are not enabled. No token was sent to storage.')
      first = result.data_array
      next = result.next_chunk_index === undefined ? undefined : index(result.next_chunk_index)
    }
    if (columns.length > 2000) throw new Error('Warehouse result exceeds2,000columns.')
    await sink.columns(columns)
    const deliver = async (rows: unknown) => {
      for (const row of warehouseRows(this.engine, rows, columns)) {
        op.progress.rowsReceived++
        if ((await sink.row(row)) === false) return false
      }
      op.progress.pages++
      return true
    }
    if (!(await deliver(first))) {
      op.progress.phase = 'LOADED LIMIT REACHED'
      return
    }
    if (snow)
      for (let page = 1; page < pages!; page++) {
        const part = await live.http.request(
          'GET',
          `/api/v2/statements/${op.nativeId}?partition=${page}`,
          undefined,
          op.controller.signal,
        )
        if (!(await deliver(part.data))) {
          op.progress.phase = 'LOADED LIMIT REACHED'
          return
        }
      }
    else {
      const visited = new Set<number>([0])
      while (next !== undefined) {
        if (visited.has(next)) throw new Error('Databricks result cursor repeated; no replay was attempted.')
        visited.add(next)
        const part = await live.http.request(
          'GET',
          `/api/2.0/sql/statements/${op.nativeId}/result/chunks/${next}`,
          undefined,
          op.controller.signal,
        )
        if (part.external_links) throw new Error('External result transfer is not enabled.')
        if (!(await deliver(part.data_array))) {
          op.progress.phase = 'LOADED LIMIT REACHED'
          return
        }
        next = part.next_chunk_index === undefined ? undefined : index(part.next_chunk_index)
      }
    }
    op.progress.phase = 'SUCCEEDED'
  }
  private async run(
    live: Live,
    sql: string,
    database: string | undefined,
    sessionId: string,
    requestId: string,
    sink: { columns(value: ResultColumn[]): Promise<void>; row(value: Cell[]): Promise<boolean | void> },
    signal?: AbortSignal,
  ): Promise<void> {
    const safety = sqlSafety(sql, this.engine)
    if (safety.statementCount !== 1 || safety.controlsTransaction)
      throw new Error('Run one warehouse SQL statement without raw transactions or session changes.')
    if (live.profile.readOnly && !safety.readOnly)
      throw new Error('The warehouse profile is read-only. No statement was submitted.')
    if (live.active.has(sessionId) || live.active.size >= 4)
      throw new Error('This warehouse tab is active or the four-operation profile limit is reached.')
    if (signal?.aborted) throw new Error('Warehouse operation cancelled before dispatch.')
    const started = performance.now(),
      op: Operation = {
        requestId,
        submissionId: randomUUID(),
        controller: new AbortController(),
        cancelled: false,
        progress: {
          requestId,
          phase: 'SUBMITTING',
          pages: 0,
          rowsReceived: 0,
          elapsedMs: 0,
          cancellation: 'none',
        },
      }
    live.active.set(sessionId, op)
    let release!: () => void
    op.done = new Promise<void>((resolve) => {
      release = resolve
    })
    const abort = () => {
        void this.stop(live, op)
      },
      timer = setTimeout(abort, live.profile.queryTimeout)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.pages(live, op, sql, database, sink)
    } catch (error) {
      await this.stop(live, op)
      op.progress.phase = 'INTERRUPTED / CHECK OUTCOME'
      live.status = {
        ...live.status,
        state: error instanceof CloudHttpError && error.status === 401 ? 'authentication-failed' : 'degraded',
        checkedAt: new Date().toISOString(),
      }
      throw new Error(
        `${error instanceof Error ? error.message : 'Warehouse operation failed.'} Native statement: ${op.nativeId || 'not acknowledged'}; submission: ${op.submissionId}; cancellation ${op.progress.cancellation}. Writes and charges may have completed. No retry occurred.`,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      op.progress.elapsedMs = Math.round(performance.now() - started)
      live.progress.set(sessionId + '/' + requestId, structuredClone(op.progress))
      while (live.progress.size > 50) live.progress.delete(live.progress.keys().next().value!)
      live.active.delete(sessionId)
      release()
    }
  }
  private async read(
    live: Live,
    database: string | undefined,
    sql: string,
    limit = 5000,
  ): Promise<ResultSet> {
    const set: ResultSet = { columns: [], rows: [], command: 'QUERY', affectedRows: 0, truncated: false }
    let bytes = 0
    await this.run(live, sql, database, randomUUID(), randomUUID(), {
      columns: async (columns) => {
        set.columns = columns
      },
      row: async (row) => {
        const size = Buffer.byteLength(JSON.stringify(row))
        if (set.rows.length >= limit || bytes + size > 8 * 1024 * 1024) {
          set.truncated = true
          return false
        }
        set.rows.push(row)
        bytes += size
      },
    })
    set.affectedRows = set.rows.length
    return set
  }
  async listDatabases(id: string): Promise<string[]> {
    const live = this.live(id),
      set = await this.read(live, undefined, this.engine === 'snowflake' ? 'SHOW DATABASES' : 'SHOW CATALOGS')
    if (set.truncated) throw new Error('Catalog listing exceeded its bound.')
    const ordinal =
      this.engine === 'snowflake'
        ? set.columns.findIndex((column) => column.name.toLowerCase() === 'name')
        : 0
    if (ordinal < 0) throw new Error('Native catalog name metadata is missing.')
    return set.rows.map((row) => string(row[ordinal]))
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId),
      database = input.database || live.profile.database
    if (!database) throw new Error('Select a database or catalog explicitly.')
    const schema = input.schema || live.profile.schema
    const set = await this.read(
      live,
      database,
      `SELECT table_schema,table_name,table_type FROM ${identifier(this.engine, database)}.information_schema.tables${schema ? ' WHERE table_schema=' + literal(schema) : ''} ORDER BY table_schema,table_name LIMIT 5001`,
      5001,
    )
    if (set.truncated || set.rows.length > 5000)
      throw new Error('More than5,000objects are visible. Choose one preferred schema.')
    return set.rows.map((row) => ({
      database,
      schema: string(row[0]),
      name: string(row[1]),
      kind: String(row[2]).includes('VIEW') ? 'view' : 'table',
    }))
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const live = this.live(input.connectionId),
      database = input.database || live.profile.database
    if (!database) throw new Error('Select a database/catalog.')
    const set = await this.read(
      live,
      database,
      `SELECT column_name,data_type,is_nullable,column_default FROM ${identifier(this.engine, database)}.information_schema.columns WHERE table_schema=${literal(input.schema)} AND table_name=${literal(input.table)} ORDER BY ordinal_position`,
      2000,
    )
    if (set.truncated || !set.rows.length)
      throw new Error('Column metadata is unavailable or exceeds its bound.')
    return {
      columns: set.rows.map((row) => ({
        name: string(row[0]),
        type: string(row[1]),
        nullable: row[2] === 'YES',
        primaryKey: false,
        defaultValue: row[3] === null ? null : string(row[3]),
      })),
      indexes: [],
      constraints: [],
      foreignKeys: [],
      ddl: '-- This adapter exposes native column metadata. Executable DDL is not inferred.',
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId)
    if (input.confirm !== live.profile.name)
      throw new Error(
        'Review the warehouse, target and potential compute charges; type the exact profile name.',
      )
    if (input.parameters?.length)
      throw new Error(
        'Native parameter binding is not advertised for this warehouse adapter; values were not interpolated.',
      )
    const started = performance.now(),
      set: ResultSet = {
        columns: [],
        rows: [],
        affectedRows: 0,
        command: 'WAREHOUSE STATEMENT',
        truncated: false,
      }
    let bytes = 0
    await this.run(
      live,
      input.sql,
      input.database || live.profile.database || undefined,
      input.sessionId,
      input.requestId,
      {
        columns: async (columns) => {
          set.columns = columns
        },
        row: async (row) => {
          const size = Buffer.byteLength(JSON.stringify(row))
          if (set.rows.length >= input.maxRows || bytes + size > 8 * 1024 * 1024) {
            set.truncated = true
            return false
          }
          set.rows.push(row)
          bytes += size
        },
      },
    )
    return {
      requestId: input.requestId,
      sets: [set],
      durationMs: Math.round(performance.now() - started),
      transaction: 'idle',
      messages: [
        `Warehouse: ${live.profile.warehouse.warehouse}. Native statement result includes any DML count rows; no affected-row count was inferred.`,
        this.engine === 'databricks'
          ? 'INLINE result transfer is capped at16MiB (server hard maximum25MiB); external storage links are never followed.'
          : 'Direct Snowflake result partitions are bounded per transfer; exact values retain server type metadata.',
        'Row limits do not limit compute costs. No interactive transactions, row editing or uncertain-write replay.',
      ],
    }
  }
  async table(input: TableInput): Promise<QueryResult> {
    void input
    throw new Error(
      'Warehouse rows require explicit job/cost review. Open the generated query draft before execution.',
    )
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    if (this.engine !== 'snowflake')
      throw new Error('Databricks INLINE is bounded; full streaming export is not advertised.')
    if (input.parameters?.length || !sqlSafety(input.sql, this.engine).readOnly)
      throw new Error('Snowflake full export requires one unparameterized read-only statement.')
    const live = this.live(input.connectionId)
    await this.run(
      live,
      input.sql,
      input.database || live.profile.database || undefined,
      randomUUID(),
      randomUUID(),
      { columns: sink.onColumns, row: sink.onRow },
      sink.signal,
    )
  }
  progress(input: { connectionId: string; sessionId: string; requestId: string }): TrinoProgress | null {
    const live = this.live(input.connectionId),
      op = live.active.get(input.sessionId)
    return structuredClone(
      op?.requestId === input.requestId
        ? op.progress
        : live.progress.get(input.sessionId + '/' + input.requestId) || null,
    )
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const live = this.live(input.connectionId),
      op = live.active.get(input.sessionId)
    if (!op || op.requestId !== input.requestId)
      return { requested: false, message: 'This exact warehouse statement is no longer active.' }
    await this.stop(live, op)
    return {
      requested: true,
      message: `Cancellation ${op.progress.cancellation}; completed writes and billing are not reversed.`,
    }
  }
  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: 'idle'
    connected: boolean
    running: boolean
  } {
    const live = this.connections.get(input.connectionId)
    return {
      state: 'idle',
      connected: live?.status.state === 'connected',
      running: !!live?.active.has(input.sessionId),
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connections.get(input.connectionId),
      op = live?.active.get(input.sessionId)
    if (live && op) {
      await this.stop(live, op)
      await op.done
    }
  }
  async disconnect(id: string): Promise<void> {
    const live = this.connections.get(id)
    if (live) {
      await Promise.allSettled(
        [...live.active.values()].map(async (op) => {
          await this.stop(live, op)
          await op.done
        }),
      )
      live.http.close()
      this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
