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
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import type { TrinoProgress } from '../../shared/trino'
import { sqlSafety } from '../../shared/sql'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import { athenaHost, NativeAthenaEndpoint, type AthenaEndpoint } from './athena-client'
import { list, record, string, type JsonRecord } from './cloud-json'

interface Operation {
  requestId: string
  token: string
  nativeId?: string
  controller: AbortController
  progress: TrinoProgress
  stopping?: Promise<void>
  done?: Promise<void>
}
interface Live {
  profile: ConnectionProfile
  api: AthenaEndpoint
  status: ConnectionStatus
  active: Map<string, Operation>
  progress: Map<string, TrinoProgress>
}
const safeCount = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Athena returned a count outside the exact supported integer range.')
  return value
}
const queryId = (value: unknown) => {
  const id = string(value)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid Athena query identity.')
  return id
}
const selectedDatabase = (live: Live, database?: string) => {
  const value = database || live.profile.database
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Select an explicit Athena database.')
  return value
}

export function athenaRows(value: unknown, columns: ResultColumn[]): Cell[][] {
  return list(value || []).map((raw) => {
    const row = list(record(raw).Data || [])
    if (row.length !== columns.length) throw new Error('Athena result row does not match column metadata.')
    return row.map((raw, index) => {
      const item = record(raw)
      if (item.VarCharValue === undefined) return null
      const value = string(item.VarCharValue)
      if (columns[index].type === 'boolean') {
        if (!['true', 'false'].includes(value)) throw new Error('Invalid Athena boolean representation.')
        return value === 'true'
      }
      return value // Native textual decimals, timestamps, complex and binary values are never guessed or rounded.
    })
  })
}
export class AthenaService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  constructor(
    private endpoint: (profile: ConnectionProfile, credentials: string) => AthenaEndpoint = (
      profile,
      credentials,
    ) => new NativeAthenaEndpoint(profile, credentials),
  ) {}
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live) throw new Error('Connect explicitly to Athena.')
    return live
  }
  status(id: string): ConnectionStatus {
    return structuredClone(
      this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' },
    )
  }
  private async validateWorkgroup(live: Live, signal?: AbortSignal): Promise<JsonRecord> {
    const settings = live.profile.athena
    if (
      !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9_./=-]*\/$/.test(settings.outputLocation) ||
      /\/\.\.?\//.test(settings.outputLocation) ||
      !/^\d{12}$/.test(settings.expectedBucketOwner)
    )
      throw new Error(
        'Select an explicit S3 output prefix ending in / and its 12-digit expected bucket owner.',
      )
    const maximum = Number(settings.maximumScannedBytes)
    if (!Number.isSafeInteger(maximum) || maximum < 10_000_000)
      throw new Error('Athena scan budget must be an exact integer of at least 10,000,000 bytes.')
    const group = record(
      (await live.api.call('GetWorkGroup', { WorkGroup: settings.workgroup }, signal)).WorkGroup,
    )
    if (group.Name !== settings.workgroup || group.State !== 'ENABLED')
      throw new Error('The exact Athena workgroup is not enabled.')
    const config = record(group.Configuration),
      result = record(config.ResultConfiguration)
    if (
      config.EnforceWorkGroupConfiguration !== true ||
      safeCount(config.BytesScannedCutoffPerQuery) > maximum ||
      safeCount(config.BytesScannedCutoffPerQuery) < 10_000_000
    )
      throw new Error(
        'Use a workgroup with enforced settings and a server scan cutoff at or below the reviewed byte budget. Harbor does not change workgroups.',
      )
    if (
      result.OutputLocation !== settings.outputLocation ||
      result.ExpectedBucketOwner !== settings.expectedBucketOwner ||
      (config.ManagedQueryResultsConfiguration && record(config.ManagedQueryResultsConfiguration).Enabled)
    )
      throw new Error(
        'Workgroup output storage differs from the reviewed S3 prefix/owner. Managed result storage is not selected for this profile.',
      )
    const encryption = record(result.EncryptionConfiguration)
    if (!['SSE_S3', 'SSE_KMS'].includes(string(encryption.EncryptionOption)))
      throw new Error('Use server-side encrypted Athena result storage.')
    return config
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    let api: AthenaEndpoint | undefined
    try {
      if (
        profile.engine !== 'athena' ||
        profile.host !== athenaHost(profile.athena.region) ||
        profile.port !== 443 ||
        !profile.tls.enabled ||
        !profile.tls.rejectUnauthorized ||
        profile.ssh.enabled ||
        profile.tls.cert ||
        profile.tls.keyPath
      )
        throw new Error(
          'Athena requires the selected region’s official HTTPS endpoint with verified TLS. SSH and client-certificate authentication are unsupported.',
        )
      if (!secrets.password)
        throw new Error('Supply explicitly scoped AWS credentials JSON; ambient credentials are never read.')
      api = this.endpoint(profile, secrets.password)
      const live: Live = {
        profile: structuredClone(profile),
        api,
        status: { state: 'connecting' },
        active: new Map(),
        progress: new Map(),
      }
      const config = await this.validateWorkgroup(live)
      const catalog = record(
        (
          await api.call('GetDataCatalog', {
            Name: profile.athena.catalog,
            WorkGroup: profile.athena.workgroup,
          })
        ).DataCatalog,
      )
      if (catalog.Name !== profile.athena.catalog)
        throw new Error('The selected Athena catalog identity was not confirmed.')
      live.status = {
        state: 'connected',
        version: `Athena ${string(record(config.EngineVersion).EffectiveEngineVersion)}`,
        transport:
          'Verified TLS · explicit AWS credentials · enforced scan/output scope · no automatic retry',
        checkedAt: new Date().toISOString(),
      }
      this.connections.set(profile.id, live)
      return structuredClone(live.status)
    } catch (error) {
      api?.close()
      const status: ConnectionStatus = {
        state: 'failed',
        error: error instanceof Error ? error.message : 'Athena connection failed.',
        checkedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  async listDatabases(id: string): Promise<string[]> {
    const live = this.live(id),
      p = live.profile.athena,
      result: string[] = [],
      tokens = new Set<string>()
    let token: string | undefined
    do {
      const page = await live.api.call('ListDatabases', {
        CatalogName: p.catalog,
        WorkGroup: p.workgroup,
        MaxResults: 50,
        ...(token ? { NextToken: token } : {}),
      })
      result.push(...list(page.DatabaseList || []).map((value) => string(record(value).Name)))
      token = page.NextToken ? string(page.NextToken) : undefined
      if (result.length > 1000 || (token && tokens.has(token)))
        throw new Error('Athena catalog exceeds 1,000 databases or repeats a cursor.')
      if (token) tokens.add(token)
    } while (token)
    return result
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId),
      database = selectedDatabase(live, input.database),
      p = live.profile.athena,
      objects: ObjectInfo[] = [],
      tokens = new Set<string>()
    let token: string | undefined
    do {
      const page = await live.api.call('ListTableMetadata', {
        CatalogName: p.catalog,
        DatabaseName: database,
        WorkGroup: p.workgroup,
        MaxResults: 50,
        ...(token ? { NextToken: token } : {}),
      })
      for (const raw of list(page.TableMetadataList || [])) {
        const table = record(raw)
        objects.push({
          database,
          schema: database,
          name: string(table.Name),
          kind: table.TableType === 'VIRTUAL_VIEW' ? 'view' : 'table',
        })
      }
      token = page.NextToken ? string(page.NextToken) : undefined
      if (objects.length > 5000 || (token && tokens.has(token)))
        throw new Error('Athena database exceeds 5,000 tables or repeats a cursor.')
      if (token) tokens.add(token)
    } while (token)
    return objects
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const live = this.live(input.connectionId),
      p = live.profile.athena,
      database = selectedDatabase(live, input.database)
    if (input.schema !== database) throw new Error('Athena table database context changed.')
    const table = record(
      (
        await live.api.call('GetTableMetadata', {
          CatalogName: p.catalog,
          DatabaseName: database,
          TableName: input.table,
          WorkGroup: p.workgroup,
        })
      ).TableMetadata,
    )
    const fields = [...list(table.Columns || []), ...list(table.PartitionKeys || [])]
    if (fields.length > 2000) throw new Error('Athena column metadata exceeds 2,000 fields.')
    return {
      columns: fields.map((raw) => {
        const field = record(raw)
        return {
          name: string(field.Name),
          type: string(field.Type),
          nullable: true,
          primaryKey: false,
          defaultValue: null,
        }
      }),
      indexes: [],
      constraints: [],
      foreignKeys: [],
      ddl: '-- Athena catalog metadata only; no executable DDL or primary key was inferred.',
    }
  }
  private async stop(live: Live, op: Operation): Promise<void> {
    if (op.stopping) return op.stopping
    op.controller.abort()
    op.progress.cancellation = 'requested'
    op.stopping = (async () => {
      try {
        if (!op.nativeId) throw new Error('No native job identity.')
        await live.api.call(
          'StopQueryExecution',
          { QueryExecutionId: op.nativeId },
          AbortSignal.timeout(5000),
        )
        op.progress.cancellation = 'acknowledged'
      } catch {
        op.progress.cancellation = 'unconfirmed'
      }
    })()
    return op.stopping
  }
  private async run(
    live: Live,
    database: string,
    sql: string,
    sessionId: string,
    requestId: string,
    sink: QueryStreamSink,
    maximumRows?: number,
  ) {
    const safety = sqlSafety(sql, 'athena')
    if (safety.statementCount !== 1 || safety.controlsTransaction || Buffer.byteLength(sql) > 262144)
      throw new Error(
        'Run one Athena statement of at most 256 KiB without raw transactions or session changes.',
      )
    if (live.profile.readOnly && !safety.readOnly)
      throw new Error('The Athena profile is read-only; no job was submitted.')
    if (live.active.has(sessionId) || live.active.size >= 4 || sink.signal.aborted)
      throw new Error('Athena tab is busy, the four-job limit is reached, or this operation was cancelled.')
    const start = performance.now(),
      op: Operation = {
        requestId,
        token: randomUUID(),
        controller: new AbortController(),
        progress: {
          requestId,
          phase: 'VALIDATING SCOPE',
          pages: 0,
          rowsReceived: 0,
          elapsedMs: 0,
          cancellation: 'none',
        },
      }
    let release!: () => void
    op.done = new Promise<void>((resolve) => {
      release = resolve
    })
    live.active.set(sessionId, op)
    const abort = () => {
        void this.stop(live, op)
      },
      timer = setTimeout(abort, live.profile.queryTimeout)
    sink.signal.addEventListener('abort', abort, { once: true })
    let truncated = false,
      affectedRows = 0,
      bytes = 0
    try {
      await this.validateWorkgroup(live, op.controller.signal)
      const p = live.profile.athena
      op.progress.phase = 'SUBMITTING'
      op.nativeId = queryId(
        (
          await live.api.call(
            'StartQueryExecution',
            {
              ClientRequestToken: op.token,
              QueryString: sql,
              QueryExecutionContext: { Catalog: p.catalog, Database: database },
              WorkGroup: p.workgroup,
              ResultConfiguration: {
                OutputLocation: p.outputLocation,
                ExpectedBucketOwner: p.expectedBucketOwner,
              },
              ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: false } },
            },
            op.controller.signal,
          )
        ).QueryExecutionId,
      )
      op.progress.queryId = op.nativeId
      let execution: JsonRecord
      for (;;) {
        execution = record(
          (await live.api.call('GetQueryExecution', { QueryExecutionId: op.nativeId }, op.controller.signal))
            .QueryExecution,
        )
        if (execution.QueryExecutionId !== op.nativeId || execution.WorkGroup !== p.workgroup)
          throw new Error('Athena execution identity or workgroup changed.')
        const phase = string(record(execution.Status).State)
        op.progress.phase = phase
        if (execution.Statistics && record(execution.Statistics).DataScannedInBytes !== undefined)
          op.progress.processedBytes = String(safeCount(record(execution.Statistics).DataScannedInBytes))
        if (phase === 'SUCCEEDED') break
        if (!['QUEUED', 'RUNNING'].includes(phase))
          throw new Error('Athena job failed or was cancelled. Provider query/error contents are omitted.')
        await delay(500, undefined, { signal: op.controller.signal })
      }
      const output = record(execution.ResultConfiguration)
      if (
        output.ExpectedBucketOwner !== p.expectedBucketOwner ||
        !string(output.OutputLocation).startsWith(p.outputLocation)
      )
        throw new Error(
          'Completed Athena job output differs from the reviewed storage scope; no results were fetched.',
        )
      let token: string | undefined,
        columns: ResultColumn[] | undefined,
        first = true
      const tokens = new Set<string>()
      do {
        const page = await live.api.call(
          'GetQueryResults',
          {
            QueryExecutionId: op.nativeId,
            QueryResultType: 'DATA_ROWS',
            MaxResults: 1000,
            ...(token ? { NextToken: token } : {}),
          },
          op.controller.signal,
        )
        const set = record(page.ResultSet),
          current = list(record(set.ResultSetMetadata).ColumnInfo).map((raw) => {
            const field = record(raw)
            return {
              name: string(field.Label || field.Name),
              type:
                string(field.Type) +
                (field.Type === 'decimal' ? `(${safeCount(field.Precision)},${safeCount(field.Scale)})` : ''),
            }
          })
        if (current.length > 2000 || (columns && JSON.stringify(columns) !== JSON.stringify(current)))
          throw new Error('Athena result metadata exceeded its bound or changed across pages.')
        if (!columns) {
          columns = current
          await sink.onColumns(columns)
        }
        let nativeRows = list(set.Rows || [])
        if (first && execution.SubstatementType === 'SELECT') {
          const header = list(record(nativeRows[0]).Data).map((raw) => string(record(raw).VarCharValue))
          if (JSON.stringify(header) !== JSON.stringify(columns.map((column) => column.name)))
            throw new Error('Athena SELECT header differs from its metadata; rows were not guessed.')
          nativeRows = nativeRows.slice(1)
        }
        first = false
        op.progress.pages++
        for (const row of athenaRows(nativeRows, columns)) {
          const size = Buffer.byteLength(JSON.stringify(row))
          if (
            maximumRows !== undefined &&
            (op.progress.rowsReceived >= maximumRows || bytes + size > 8 * 1024 * 1024)
          ) {
            truncated = true
            break
          }
          await sink.onRow(row)
          bytes += size
          op.progress.rowsReceived++
        }
        if (page.UpdateCount !== undefined) affectedRows = safeCount(page.UpdateCount)
        token = page.NextToken ? string(page.NextToken) : undefined
        if (token && tokens.has(token))
          throw new Error('Athena repeated a result cursor; no page replay occurred.')
        if (token) tokens.add(token)
      } while (token && !truncated)
      op.progress.phase = truncated ? 'LOADED LIMIT REACHED' : 'SUCCEEDED'
      return { truncated, affectedRows, durationMs: Math.round(performance.now() - start) }
    } catch (error) {
      await this.stop(live, op)
      op.progress.phase = 'INTERRUPTED / CHECK OUTCOME'
      live.status = { ...live.status, state: 'degraded', checkedAt: new Date().toISOString() }
      throw new Error(
        `${error instanceof Error ? error.message : 'Athena failed.'} Query: ${op.nativeId || 'not acknowledged'}; submission token: ${op.token}; cancellation ${op.progress.cancellation}. Writes and charges may have completed; no retry occurred.`,
      )
    } finally {
      clearTimeout(timer)
      sink.signal.removeEventListener('abort', abort)
      op.progress.elapsedMs = Math.round(performance.now() - start)
      live.progress.set(sessionId + '/' + requestId, structuredClone(op.progress))
      while (live.progress.size > 50) live.progress.delete(live.progress.keys().next().value!)
      live.active.delete(sessionId)
      release()
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId),
      database = selectedDatabase(live, input.database)
    if (input.confirm !== live.profile.name)
      throw new Error(
        'Review the Athena catalog/workgroup, storage owner and scan budget; type the exact profile name.',
      )
    if (input.parameters?.length)
      throw new Error('Athena execution parameters are not advertised; no values were interpolated.')
    const columns: ResultColumn[] = [],
      rows: Cell[][] = []
    const result = await this.run(
      live,
      database,
      input.sql,
      input.sessionId,
      input.requestId,
      {
        signal: new AbortController().signal,
        onColumns: async (value) => {
          columns.push(...value)
        },
        onRow: async (row) => {
          rows.push(row)
        },
      },
      input.maxRows,
    )
    return {
      requestId: input.requestId,
      sets: [
        {
          columns,
          rows,
          command: 'ATHENA JOB',
          affectedRows: result.affectedRows,
          truncated: result.truncated,
        },
      ],
      durationMs: result.durationMs,
      transaction: 'idle',
      messages: [
        'Server scan cutoff is enforced by the selected workgroup; it is not a monetary cap. Cancellation does not reverse completed writes, S3 output or charges.',
        'Native complex, binary and temporal values retain provider text and column types. No automatic replay, result reuse, resource creation or session transactions.',
      ],
    }
  }
  async table(input: TableInput): Promise<QueryResult> {
    void input
    throw new Error('Opening an Athena table creates an inert draft; review the job scope before execution.')
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const live = this.live(input.connectionId)
    if (input.parameters?.length || !sqlSafety(input.sql, 'athena').readOnly)
      throw new Error('Athena full export requires one unparameterized read-only statement.')
    await this.run(live, selectedDatabase(live, input.database), input.sql, randomUUID(), randomUUID(), sink)
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
      return { requested: false, message: 'This exact Athena query is no longer active.' }
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
      live.api.close()
      this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
