import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { createClient, ClickHouseLogLevel, type ClickHouseClient } from '@clickhouse/client'
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
import {
  clickhouseLiteral,
  clickhouseParameters,
  clickhouseQuote,
  clickhouseReadQuery,
} from '../../shared/clickhouse'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import { openTransport, type Transport } from './transport'
import { clickhouseRows, validateClickhouseImport } from './clickhouse-values'
import { importTargetConfirmation, type ImportTarget } from '../../shared/imports'
import { ImportBatchError, type ImportWriter } from '../persistence/import-writer'
import type {
  ObjectInspection,
  ObjectInspectionInput,
  ExplainInput,
  ExplainResult,
} from '../../shared/inspection'

export const CLICKHOUSE_EXPORT_CONSISTENCY =
  'One fresh read-only ClickHouse query, with native per-table read snapshots. There is no multi-table transactional snapshot or access to uncommitted tab transactions. Results may reflect engine-specific merges or remote-table behavior.'
interface Active {
  id: string
  controller: AbortController
  database: string
  cancelled: boolean
  confirmed?: boolean
  killing?: Promise<void>
}
interface Live {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  clients: Map<string, ClickHouseClient>
  active: Map<string, Active>
  sessions: Map<string, string>
  status: ConnectionStatus
  closed: boolean
  restrictedReadOnly: boolean
}
function message(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (code === '164')
    return 'ClickHouse server settings prohibit a required client setting. Use a server read-only settings profile with standard TSV formatting, or ask the administrator to review the setting constraints.'
  if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code)
  )
    return 'ClickHouse TLS validation failed. Verify the original hostname, trusted CA chain, and certificate validity.'
  if (code === '516') return 'ClickHouse authentication failed. Check the username and stored password.'
  if (code === '497')
    return 'ClickHouse denied this operation. Check grants for the selected database and system metadata.'
  if (code === '81') return 'The selected ClickHouse database does not exist or is not visible.'
  if (code === '159') return 'ClickHouse exceeded the query timeout. No query was replayed.'
  if (code === '394') return 'ClickHouse cancelled the query.'
  if (code)
    return `ClickHouse operation failed (code ${/^[A-Z0-9_]+$/.test(code) ? code : 'unknown'}). Check query syntax, types, permissions, and connection settings.`
  return 'ClickHouse operation failed or its response was interrupted. No query was replayed.'
}
function records(set: ResultSet): Record<string, Cell>[] {
  return set.rows.map((row) =>
    Object.fromEntries(set.columns.map((column, index) => [column.name, row[index]])),
  )
}
function selectedDatabase(live: Live, database?: string): string {
  const value = database || live.profile.database || 'default'
  if (value.includes('\0')) throw new Error('Invalid ClickHouse database.')
  return value
}
export class ClickhouseService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  exportConsistency(): string {
    return CLICKHOUSE_EXPORT_CONSISTENCY
  }
  private connection(id: string): Live {
    const live = this.connections.get(id)
    if (!live || live.closed)
      throw new Error('ClickHouse is disconnected. Connect explicitly before continuing.')
    return live
  }
  private client(live: Live, database?: string): ClickHouseClient {
    const name = selectedDatabase(live, database),
      existing = live.clients.get(name)
    if (existing) return existing
    if (live.clients.size >= 32)
      throw new Error('Close the connection before browsing more than 32 ClickHouse databases.')
    const host = live.transport.host.includes(':') ? `[${live.transport.host}]` : live.transport.host
    const agent = live.profile.tls.enabled
      ? new https.Agent({ ...live.transport.tls, keepAlive: true, maxSockets: 8 })
      : new http.Agent({ keepAlive: true, maxSockets: 8 })
    const client = createClient({
      url: `${live.profile.tls.enabled ? 'https' : 'http'}://${host}:${live.transport.port}`,
      username: live.profile.username || 'default',
      password: live.secrets.password || '',
      database: name,
      http_agent: agent,
      request_timeout: Math.max(live.profile.queryTimeout, live.profile.connectTimeout),
      log: { level: ClickHouseLogLevel.OFF },
      application: 'Harbor DB',
    })
    live.clients.set(name, client)
    return client
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'clickhouse') throw new Error('Use the matching engine adapter for this profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    this.states.set(profile.id, { state: 'connecting' })
    const started = performance.now()
    let live: Live | undefined
    try {
      const transport = await openTransport(profile, secrets)
      live = {
        profile,
        secrets,
        transport,
        clients: new Map(),
        active: new Map(),
        sessions: new Map(),
        closed: false,
        restrictedReadOnly: false,
        status: { state: 'connecting' },
      }
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      this.connections.set(profile.id, live)
      const bootstrap = await this.client(live).query({
        query:
          "SELECT version() AS version,getSetting('readonly') AS readonly,getSetting('output_format_tsv_crlf_end_of_line') AS crlf,getSetting('format_tsv_null_representation') AS null_token,getSetting('extremes') AS extremes",
        format: 'JSONEachRow',
        abort_signal: AbortSignal.timeout(profile.connectTimeout),
      })
      const settings = (
        await bootstrap.json<{
          version: string
          readonly: number
          crlf: number
          null_token: string
          extremes: number
        }>()
      )[0]
      live.restrictedReadOnly = Number(settings.readonly) === 1
      if (
        live.restrictedReadOnly &&
        (Number(settings.crlf) !== 0 || settings.null_token !== '\\N' || Number(settings.extremes) !== 0)
      )
        throw new Error(
          'Harbor ClickHouse requires TSV CRLF disabled, the standard NULL token, and extremes disabled in this read-only server settings profile.',
        )
      const version = settings.version
      const match = /^(\d+)\.(\d+)\./.exec(String(version))
      if (!match || Number(match[1]) * 100 + Number(match[2]) < 2511)
        throw new Error(
          'Harbor ClickHouse streaming requires ClickHouse 25.11 or newer for unambiguous late-error framing.',
        )
      if (live.closed || this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      live.status = {
        state: 'connected',
        version: `ClickHouse ${version}`,
        durationMs: Math.round(performance.now() - started),
        lastConnectedAt: new Date().toISOString(),
        transport: `${profile.ssh.enabled ? 'SSH tunnel + ' : ''}${profile.tls.enabled ? 'HTTPS' : 'HTTP'}`,
      }
      this.states.set(profile.id, live.status)
      return live.status
    } catch (error) {
      const stale = this.generations.get(profile.id) !== generation
      if (live && this.connections.get(profile.id) === live) await this.disconnect(profile.id)
      if (stale) return { state: 'disconnected' }
      const status: ConnectionStatus = {
        state: 'failed',
        error:
          error instanceof Error && /^(Harbor )?ClickHouse /.test(error.message)
            ? error.message
            : message(error),
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private async kill(live: Live, active: Active): Promise<void> {
    if (active.killing) return active.killing
    active.cancelled = true
    active.killing = (async () => {
      try {
        await this.client(live, active.database).command({
          query: 'KILL QUERY WHERE query_id = {id:String} SYNC',
          query_params: { id: active.id },
          clickhouse_settings: live.restrictedReadOnly ? {} : { readonly: '1', max_execution_time: 5 },
          abort_signal: AbortSignal.timeout(6000),
        })
        active.confirmed = true
      } finally {
        active.controller.abort()
      }
    })()
    return active.killing
  }
  private async run(
    live: Live,
    database: string | undefined,
    sql: string,
    parameters: Record<string, unknown>,
    slot: string,
    onColumns: (columns: ResultColumn[]) => Promise<void>,
    onRow: (row: Cell[]) => Promise<boolean | void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (live.active.has(slot)) throw new Error('This ClickHouse session is already running a request.')
    const active: Active = {
      id: randomUUID(),
      controller: new AbortController(),
      database: selectedDatabase(live, database),
      cancelled: false,
    }
    live.active.set(slot, active)
    let timeout = false,
      limited = false,
      sinkFailure = false
    const abort = () => {
      void this.kill(live, active).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timeout = true
      abort()
    }, live.profile.queryTimeout)
    try {
      if (signal?.aborted) throw new Error('The ClickHouse operation was cancelled before dispatch.')
      // exec() in the pinned client does not implement use_multipart_params.
      // Use the documented HTTP multipart form directly so private values never enter URLs.
      const boundary = 'harbor-' + randomUUID(),
        parts: string[] = []
      const part = (name: string, value: string) =>
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      part('query', sql + '\nFORMAT TabSeparatedWithNamesAndTypes')
      for (const [name, value] of Object.entries(parameters)) {
        const escaped =
          value === null
            ? '\\N'
            : typeof value === 'boolean'
              ? value
                ? '1'
                : '0'
              : String(value)
                  .replace(/\\/g, '\\\\')
                  .replace(/\t/g, '\\t')
                  .replace(/\n/g, '\\n')
                  .replace(/\r/g, '\\r')
                  .replace(/'/g, "\\'")
        part('param_' + name, escaped)
      }
      parts.push(`--${boundary}--\r\n`)
      const result = await this.client(live, database).exec({
        query: '',
        values: Readable.from(parts),
        http_headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        query_id: active.id,
        abort_signal: active.controller.signal,
        clickhouse_settings: live.restrictedReadOnly
          ? {}
          : {
              readonly: '1',
              max_execution_time: Math.max(0.1, live.profile.queryTimeout / 1000),
              output_format_tsv_crlf_end_of_line: 0,
              format_tsv_null_representation: '\\N',
              extremes: 0,
              max_block_size: '8192',
              output_format_parallel_formatting: 0,
            },
      })
      try {
        for await (const item of clickhouseRows(result.stream)) {
          if ('columns' in item) {
            try {
              await onColumns(item.columns)
            } catch (error) {
              sinkFailure = true
              throw error
            }
          } else if (
            (await (async () => {
              try {
                return await onRow(item.row)
              } catch (error) {
                sinkFailure = true
                throw error
              }
            })()) === false
          ) {
            limited = true
            await this.kill(live, active).catch(() => {})
            break
          }
        }
      } finally {
        result.stream.destroy()
      }
      if (active.cancelled && !limited)
        throw new Error(timeout ? 'ClickHouse exceeded the query timeout.' : 'ClickHouse query cancelled.')
    } catch (error) {
      if (limited) return
      if (active.cancelled) await active.killing?.catch(() => {})
      if (active.cancelled)
        throw new Error(
          timeout
            ? 'ClickHouse exceeded the query timeout. No query was replayed.'
            : active.confirmed
              ? 'ClickHouse query cancelled.'
              : 'ClickHouse client request cancelled; server cancellation was not confirmed.',
        )
      await this.kill(live, active).catch(() => {})
      if (sinkFailure) throw error
      if (
        error instanceof Error &&
        /^A ClickHouse row|^ClickHouse (interrupted|returned)|^Invalid ClickHouse|^Incomplete ClickHouse/.test(
          error.message,
        )
      )
        throw error
      throw new Error(message(error))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await active.killing?.catch(() => {})
      live.active.delete(slot)
    }
  }
  private async read(
    live: Live,
    database: string | undefined,
    sql: string,
    parameters: Record<string, unknown> = {},
    maxRows = 5000,
  ): Promise<ResultSet> {
    const set: ResultSet = { columns: [], rows: [], affectedRows: 0, command: 'SELECT', truncated: false }
    let bytes = 0
    await this.run(
      live,
      database,
      sql,
      parameters,
      `_metadata:${randomUUID()}`,
      async (columns) => {
        set.columns = columns
      },
      async (row) => {
        bytes += Buffer.byteLength(JSON.stringify(row))
        if (set.rows.length >= maxRows || bytes > 8 * 1024 * 1024) {
          set.truncated = true
          return false
        }
        set.rows.push(row)
      },
    )
    return set
  }
  async listDatabases(id: string): Promise<string[]> {
    const set = await this.read(
      this.connection(id),
      undefined,
      'SELECT name FROM system.databases ORDER BY name',
    )
    if (set.truncated) throw new Error('ClickHouse database catalog exceeded the display limit.')
    return set.rows.map((row) => String(row[0]))
  }
  async listObjects(input: { connectionId: string; database?: string }): Promise<ObjectInfo[]> {
    const live = this.connection(input.connectionId),
      database = selectedDatabase(live, input.database)
    const set = await this.read(
      live,
      database,
      'SELECT name,engine,total_rows FROM system.tables WHERE database={db:String} ORDER BY name',
      { db: database },
    )
    if (set.truncated) throw new Error('ClickHouse object catalog exceeded the display limit.')
    return records(set).map((row) => ({
      name: String(row.name),
      schema: database,
      database,
      kind:
        row.engine === 'MaterializedView' ? 'materialized view' : row.engine === 'View' ? 'view' : 'table',
      estimatedRows: row.total_rows === null ? undefined : String(row.total_rows),
    }))
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const live = this.connection(input.connectionId),
      database = input.schema || selectedDatabase(live, input.database),
      params = { db: database, table: input.table }
    const columns = records(
      await this.read(
        live,
        input.database,
        'SELECT name,type,default_kind,default_expression,is_in_primary_key FROM system.columns WHERE database={db:String} AND table={table:String} ORDER BY position',
        params,
      ),
    )
    if (!columns.length)
      throw new Error('The ClickHouse table is unavailable or its columns are not visible.')
    const tables = records(
      await this.read(
        live,
        input.database,
        'SELECT engine,create_table_query,sorting_key,primary_key,partition_key,sampling_key FROM system.tables WHERE database={db:String} AND name={table:String}',
        params,
      ),
    )
    if (!tables.length) throw new Error('ClickHouse table metadata is unavailable.')
    return {
      columns: columns.map((row) => ({
        name: String(row.name),
        type: String(row.type),
        nullable: /Nullable\(/.test(String(row.type)),
        defaultValue: row.default_kind
          ? String(row.default_kind) + ' ' + String(row.default_expression)
          : null,
        primaryKey: false,
      })),
      indexes: [
        { name: 'Sorting key', definition: String(tables[0].sorting_key) },
        { name: 'Primary index (not unique)', definition: String(tables[0].primary_key) },
        { name: 'Partition key', definition: String(tables[0].partition_key) },
        { name: 'Sampling key', definition: String(tables[0].sampling_key) },
      ].filter((item) => item.definition),
      constraints: [],
      foreignKeys: [],
      ddl: String(tables[0].create_table_query),
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.connection(input.connectionId)
    if (!input.sessionId || input.sessionId.startsWith('_'))
      throw new Error('Invalid ClickHouse session identifier.')
    const database = selectedDatabase(live, input.database),
      bound = live.sessions.get(input.sessionId)
    if (bound && bound !== database) throw new Error('This tab belongs to another database. Open a new tab.')
    if (!bound && live.sessions.size >= 32)
      throw new Error('Close unused ClickHouse tabs before opening more.')
    live.sessions.set(input.sessionId, database)
    const sql = clickhouseReadQuery(input.sql),
      parameters = clickhouseParameters(input.parameters),
      started = performance.now(),
      set: ResultSet = { columns: [], rows: [], affectedRows: 0, command: 'SELECT', truncated: false }
    let bytes = 0
    try {
      await this.run(
        live,
        database,
        sql,
        parameters,
        input.sessionId,
        async (columns) => {
          set.columns = columns
        },
        async (row) => {
          bytes += Buffer.byteLength(JSON.stringify(row))
          if (set.rows.length >= input.maxRows || bytes > 8 * 1024 * 1024) {
            set.truncated = true
            return false
          }
          set.rows.push(row)
        },
      )
    } catch (error) {
      if (
        error instanceof Error &&
        /^ClickHouse (query cancelled|client request cancelled)/.test(error.message)
      )
        return {
          requestId: input.requestId,
          sets: [],
          durationMs: Math.round(performance.now() - started),
          messages: [error.message + ' Partial rows were discarded.'],
          transaction: 'idle',
          cancelled: true,
        }
      throw error
    }
    return {
      requestId: input.requestId,
      sets: [set],
      durationMs: Math.round(performance.now() - started),
      messages: [
        'ClickHouse queries are independent requests; transactions and unique row edits are unavailable.',
      ],
      transaction: 'idle',
    }
  }
  async table(input: TableInput): Promise<QueryResult> {
    const structure = await this.structure(input),
      columns = new Map(structure.columns.map((column) => [column.name, column])),
      params: Record<string, unknown> = {},
      parameterCells: Cell[] = []
    const conditions = input.filters?.conditions ?? (input.filter ? [input.filter] : []),
      match = input.filters?.match ?? 'all'
    const expressions = conditions.map((condition, index) => {
      const column = columns.get(condition.column)
      if (!column) throw new Error('The ClickHouse filter column no longer exists.')
      const name = clickhouseQuote(column.name)
      if (condition.operator === 'is null') return `isNull(${name})`
      if (condition.operator === 'is not null') return `isNotNull(${name})`
      const key = `filter${index}`
      params[key] = condition.value
      parameterCells.push(condition.value)
      if (condition.operator === 'contains') return `positionUTF8(toString(${name}),{${key}:String})>0`
      const operator = { equals: '=', 'not equals': '!=', 'greater than': '>', 'less than': '<' }[
        condition.operator
      ]
      return `${name} ${operator} accurateCast({${key}:String},${clickhouseLiteral(column.type)})`
    })
    const sorts = input.sorts ?? (input.sort ? [{ column: input.sort, direction: input.direction }] : [])
    const order = sorts
      .map((sort) => {
        if (!columns.has(sort.column)) throw new Error('The ClickHouse sort column no longer exists.')
        return clickhouseQuote(sort.column) + ' ' + (sort.direction === 'desc' ? 'DESC' : 'ASC')
      })
      .join(',')
    const database = input.schema || selectedDatabase(this.connection(input.connectionId), input.database)
    const sql = `SELECT * FROM ${clickhouseQuote(database)}.${clickhouseQuote(input.table)}${expressions.length ? ' WHERE ' + expressions.map((value) => '(' + value + ')').join(match === 'any' ? ' OR ' : ' AND ') : ''}${order ? ' ORDER BY ' + order : ''} LIMIT ${input.limit} OFFSET ${input.offset}`
    const result = await this.execute({
      connectionId: input.connectionId,
      database: input.database,
      sessionId: input.sessionId,
      requestId: randomUUID(),
      sql,
      maxRows: input.limit,
      privateSession: false,
      parameters: Object.entries(params).map(([name, value]) => ({
        name,
        type: 'text',
        secret: false,
        value: String(value),
      })),
    })
    result.messages.push(
      'ClickHouse sorting and primary keys are not unique constraints. Offset pages can move when parts merge or concurrent writes occur.',
    )
    result.tableQuery = {
      sql,
      parameters: parameterCells,
      editorSql: sql.replace(/\{(filter\d+):String\}/g, (_all, key) =>
        clickhouseLiteral(String(params[key])),
      ),
    }
    return result
  }
  async inspectObject(input: ObjectInspectionInput): Promise<ObjectInspection> {
    if (input.kind !== 'table' && input.kind !== 'view')
      throw new Error('ClickHouse inspection currently supports tables and views.')
    const live = this.connection(input.connectionId),
      database = input.schema || selectedDatabase(live, input.database)
    const rows = records(
      await this.read(
        live,
        input.database,
        'SELECT engine,total_rows,total_bytes,partition_key,sorting_key,primary_key,sampling_key FROM system.tables WHERE database={db:String} AND name={table:String}',
        { db: database, table: input.name },
      ),
    )
    if (!rows.length) throw new Error('The ClickHouse object is unavailable.')
    const structure = await this.structure({ ...input, table: input.name })
    const details: ResultSet[] = [],
      warnings = [
        'ClickHouse primary/sorting keys do not enforce uniqueness. Materialized views and background merges have engine-specific behavior.',
      ]
    for (const [name, sql] of [
      [
        'Active parts and partitions',
        'SELECT partition,name,rows,bytes_on_disk,modification_time FROM system.parts WHERE database={db:String} AND table={table:String} AND active ORDER BY partition,name LIMIT 201',
      ],
      [
        'Pending mutations',
        'SELECT mutation_id,command,create_time,parts_to_do,is_done FROM system.mutations WHERE database={db:String} AND table={table:String} AND NOT is_done ORDER BY create_time DESC LIMIT 201',
      ],
    ]) {
      try {
        const set = await this.read(live, input.database, sql, { db: database, table: input.name }, 200)
        set.command = name
        details.push(set)
      } catch {
        warnings.push(`${name} metadata is unavailable with the current permissions or server version.`)
      }
    }
    if (Buffer.byteLength(JSON.stringify(details)) > 8 * 1024 * 1024) {
      details.length = 0
      warnings.push('Detailed metadata exceeded the 8 MiB display limit.')
    }
    return {
      properties: Object.entries(rows[0]).map(([name, value]) => ({
        name,
        value: value === null ? 'Unknown' : String(value),
      })),
      structure,
      details,
      definition: { text: structure.ddl, source: 'server' },
      warnings,
    }
  }
  async explain(input: ExplainInput): Promise<ExplainResult> {
    if (input.mode !== 'estimate')
      throw new Error(
        'ClickHouse supports EXPLAIN PLAN inspection here; execution analysis is not implemented.',
      )
    const started = performance.now(),
      query = clickhouseReadQuery(input.sql),
      result = await this.execute({
        ...input,
        sql: 'EXPLAIN PLAN ' + query,
        maxRows: 1000,
        privateSession: false,
      })
    return {
      engine: 'clickhouse',
      mode: 'estimate',
      format: 'text',
      raw: result.sets.flatMap((set) => set.rows.map((row) => String(row[0]))).join('\n'),
      durationMs: Math.round(performance.now() - started),
      warnings: [
        'Native ClickHouse EXPLAIN PLAN; this does not execute the query or provide actual timings.',
      ],
      cancelled: result.cancelled,
    }
  }
  async openImport(
    target: ImportTarget & { columns: string[]; consentNonTransactionalAppend?: true },
    signal: AbortSignal,
  ): Promise<ImportWriter> {
    const live = this.connection(target.connectionId)
    if (live.profile.readOnly || live.restrictedReadOnly)
      throw new Error('This ClickHouse connection is read-only.')
    if (!target.consentNonTransactionalAppend)
      throw new Error('Explicit nontransactional append confirmation is required for ClickHouse imports.')
    if (live.profile.environment === 'production' && target.confirm !== importTargetConfirmation(target))
      throw new Error('Confirm the exact production import target.')
    const database = target.schema || selectedDatabase(live, target.database),
      params = { db: database, table: target.table }
    const info = records(
      await this.read(
        live,
        target.database,
        'SELECT engine FROM system.tables WHERE database={db:String} AND name={table:String}',
        params,
      ),
    )
    if (info[0]?.engine !== 'MergeTree')
      throw new Error(
        'ClickHouse append imports currently require a local MergeTree table; replicated, distributed, view, and specialized merge engines are unavailable.',
      )
    const structure = await this.structure({ ...target, database }),
      columns = target.columns.map((name) => {
        const column = structure.columns.find((column) => column.name === name)
        if (!column) throw new Error('The ClickHouse target column no longer exists.')
        if (column.defaultValue && /^(ALIAS|MATERIALIZED)\b/.test(column.defaultValue))
          throw new Error('Generated ClickHouse columns cannot be imported.')
        if (
          !/^(?:(?:Nullable|LowCardinality)\()*(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|Bool|String|UUID|IPv[46]|Date(?:32)?|DateTime(?:64)?(?:\([^)]*\))?|Decimal(?:32|64|128|256)?\([^)]*\))\)*$/.test(
            column.type,
          )
        )
          throw new Error(
            'This ClickHouse column type is not supported by the append importer. Use an explicit reviewed server-side ingestion workflow.',
          )
        return column
      })
    let closed = false
    return {
      columns,
      commitModel: 'append',
      warnings: [
        'Each successful batch is acknowledged by ClickHouse. Failed or interrupted dispatched batches can have partial effects and are reported uncertain. No rollback or automatic retry is possible.',
      ],
      close: async () => {
        closed = true
      },
      writeBatch: async (rows) => {
        if (closed || signal.aborted || live.closed)
          throw new ImportBatchError(
            'ClickHouse append was cancelled before dispatch.',
            'rolled-back',
            rows.length,
          )
        if (rows.length > 500 || rows.some((row) => row.length !== columns.length))
          throw new ImportBatchError('Invalid ClickHouse import batch.', 'rolled-back', rows.length)
        try {
          for (const row of rows)
            row.forEach((value, index) => validateClickhouseImport(value, columns[index].type))
        } catch (error) {
          throw new ImportBatchError(
            error instanceof Error ? error.message : 'Invalid ClickHouse input.',
            'rolled-back',
            rows.length,
          )
        }
        const encoded = rows.map((row) =>
          JSON.stringify(
            Object.fromEntries(
              row.map((value, index) => {
                if (value === null) {
                  if (!columns[index].nullable)
                    throw new ImportBatchError(
                      'NULL is not allowed in a selected ClickHouse column.',
                      'rolled-back',
                      rows.length,
                    )
                  return ['c' + index, null]
                }
                if (typeof value === 'object') return ['c' + index, value.base64]
                return ['c' + index, typeof value === 'boolean' ? (value ? '1' : '0') : String(value)]
              }),
            ),
          ),
        )
        const definitions = columns.map((_column, index) => `c${index} Nullable(String)`).join(',')
        const select = columns
          .map((column, index) => {
            const binary = rows.some((row) => typeof row[index] === 'object' && row[index] !== null)
            if (binary && rows.some((row) => row[index] !== null && typeof row[index] !== 'object'))
              throw new ImportBatchError(
                'Do not mix binary and text values in one ClickHouse import column.',
                'rolled-back',
                rows.length,
              )
            if (binary && !/String/.test(column.type))
              throw new ImportBatchError(
                'Binary input requires a ClickHouse String column.',
                'rolled-back',
                rows.length,
              )
            const value = binary
              ? `base64Decode(c${index})`
              : /DateTime/.test(column.type)
                ? `parseDateTime64BestEffort(c${index},${Number(/DateTime64\(\s*(\d+)/.exec(column.type)?.[1] ?? 0)},'UTC')`
                : `c${index}`
            return `accurateCast(${value},${clickhouseLiteral(column.type)})`
          })
          .join(',')
        const body = encoded.join('\n') + '\n'
        if (Buffer.byteLength(body) > 16 * 1024 * 1024)
          throw new ImportBatchError(
            'Encoded ClickHouse import batch exceeds its transfer limit.',
            'rolled-back',
            rows.length,
          )
        const active: Active = {
            id: randomUUID(),
            controller: new AbortController(),
            database: selectedDatabase(live, target.database),
            cancelled: false,
          },
          slot = `_import:${active.id}`
        live.active.set(slot, active)
        const abort = () => {
          void this.kill(live, active).catch(() => {})
        }
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(abort, live.profile.queryTimeout)
        try {
          const response = await this.client(live, target.database).exec({
            query: `INSERT INTO ${clickhouseQuote(database)}.${clickhouseQuote(target.table)} (${target.columns.map(clickhouseQuote).join(',')}) SELECT ${select} FROM input(${clickhouseLiteral(definitions)}) FORMAT JSONEachRow`,
            values: Readable.from([body]),
            query_id: active.id,
            abort_signal: active.controller.signal,
            clickhouse_settings: {
              readonly: '0',
              async_insert: 0,
              input_format_skip_unknown_fields: 0,
              input_format_allow_errors_num: '0',
              input_format_allow_errors_ratio: 0,
            },
          })
          try {
            for await (const chunk of response.stream) {
              if (Buffer.byteLength(chunk) > 0) throw new Error('Unexpected ClickHouse append response.')
            }
          } finally {
            response.stream.destroy()
          }
          if (active.cancelled) throw new Error('ClickHouse append was interrupted.')
        } catch {
          throw new ImportBatchError(
            'ClickHouse did not acknowledge the entire append batch. Its effects are uncertain; inspect the target before any manual retry.',
            'uncertain',
            rows.length,
          )
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          await active.killing?.catch(() => {})
          live.active.delete(slot)
        }
      },
    }
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const live = this.connection(input.connectionId)
    await this.run(
      live,
      input.database,
      clickhouseReadQuery(input.sql),
      clickhouseParameters(input.parameters),
      `_export:${randomUUID()}`,
      sink.onColumns,
      sink.onRow,
      sink.signal,
    )
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
  }): Promise<{ requested: boolean; message: string }> {
    const live = this.connection(input.connectionId),
      active = live.active.get(input.sessionId)
    if (!active) return { requested: false, message: 'No ClickHouse query is running in this session.' }
    try {
      await this.kill(live, active)
      return { requested: true, message: 'ClickHouse acknowledged native query cancellation.' }
    } catch {
      return {
        requested: true,
        message:
          'The client request was closed, but the server did not acknowledge cancellation. Check server activity; no query was replayed.',
      }
    }
  }
  getSessionState(input:{connectionId:string;sessionId:string}):{state:'idle';connected:boolean;running:boolean} {
    const live=this.connections.get(input.connectionId)
    return {state:'idle',connected:!!live&&!live.closed,running:!!live?.active.has(input.sessionId)}
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connection(input.connectionId)
    await this.cancel(input)
    live.sessions.delete(input.sessionId)
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!live) return
    live.closed = true
    await Promise.allSettled([...live.active.values()].map((active) => this.kill(live, active)))
    await Promise.allSettled([...live.clients.values()].map((client) => client.close()))
    await live.transport.close()
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
