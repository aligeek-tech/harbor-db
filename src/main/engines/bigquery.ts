import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Cell, ConnectionProfile, ConnectionStatus, ObjectInfo, QueryInput, QueryResult, ResultColumn, Secrets, TableInput, TableStructure } from '../../shared/contracts'
import type { BigQueryEstimate } from '../../shared/bigquery'
import type { TrinoProgress } from '../../shared/trino'
import { parameterValue, type QueryParameter } from '../../shared/parameters'
import { sqlSafety } from '../../shared/sql'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import { canonical, CloudHttpError, CloudJson, exact, list, record, string, type JsonEndpoint, type JsonRecord } from './cloud-json'

type Field = { name: string; type: string; mode?: string; fields?: Field[] }
const project = (value: string) => { if (!/^[a-z][a-z0-9:.-]{3,254}$/.test(value)) throw new Error('Select an explicit valid BigQuery billing project.'); return value }
const segment = (value: string) => encodeURIComponent(value)
const root = (value: string) => `/bigquery/v2/projects/${segment(project(value))}`
const failure = (body: JsonRecord) => { const status = body.status ? record(body.status) : {}; if (status.errorResult || body.error || body.errors) throw new Error('BigQuery rejected this operation. Review permissions, query types, job location and billing limits; provider details are omitted.') }
function fields(value: unknown): Field[] {
  return list(value).map((item) => { const field = record(item); return { name: string(field.name), type: string(field.type), ...(field.mode ? { mode: string(field.mode) } : {}), ...(field.fields ? { fields: fields(field.fields) } : {}) } })
}
function nativeValue(value: unknown, field: Field): unknown {
  if (value === null || value === undefined) return null
  if (field.mode === 'REPEATED') return list(value).map((entry) => nativeValue(record(entry).v, { ...field, mode: undefined }))
  if (field.type === 'RECORD' || field.type === 'STRUCT') return { fields: (field.fields || []).map((child, index) => ({ name: child.name, type: child.type, value: nativeValue(record(list(record(value).f)[index]).v, child) })) }
  const text = string(value)
  if (field.type === 'BOOLEAN' || field.type === 'BOOL') { if (!['true','false'].includes(text)) throw new Error('Invalid BigQuery boolean value.'); return text === 'true' }
  if (field.type === 'BYTES') { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Invalid BigQuery binary encoding.'); return { type: 'binary', base64: text } }
  return text
}
export function bigQueryRows(body: JsonRecord, schema: Field[]): Cell[][] {
  return list(body.rows || []).map((raw) => {
    const row = list(record(raw).f)
    if (row.length !== schema.length) throw new Error('BigQuery row shape differs from schema.')
    return row.map((item, index) => { const value = nativeValue(record(item).v, schema[index]); return value && typeof value === 'object' && !('type' in value && value.type === 'binary') ? canonical(value) : value as Cell })
  })
}
export function bigQueryParameters(parameters: QueryParameter[] = []) {
  const names = new Set<string>()
  return parameters.map((parameter) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(parameter.name) || names.has(parameter.name)) throw new Error('BigQuery parameters require unique named @identifiers.')
    names.add(parameter.name)
    parameterValue(parameter)
    if (parameter.type === 'decimal' && (!/^[+-]?\d+(?:\.\d*)?$/.test(parameter.value) || parameter.value.replace(/^[+-]?0*/, '').split('.')[0].length > 38 || (parameter.value.split('.')[1]?.length || 0) > 38)) throw new Error('BigQuery decimal parameters require plain decimal text with at most 38 integer and 38 fractional digits; no rounding or exponent conversion is performed.')
    if (parameter.type === 'integer' && (BigInt(parameter.value) < -9223372036854775808n || BigInt(parameter.value) > 9223372036854775807n)) throw new Error('BigQuery INT64 parameter is outside the exact signed 64-bit range.')
    const types = { text: 'STRING', integer: 'INT64', decimal: 'BIGNUMERIC', boolean: 'BOOL', null: 'STRING', json: 'JSON', timestamp: 'TIMESTAMP', binary: 'BYTES' }
    return { name: parameter.name, parameterType: { type: types[parameter.type] }, parameterValue: { value: parameter.type === 'null' ? null : parameter.value } }
  })
}
interface Operation { requestId: string; project: string; jobId: string; controller: AbortController; progress: TrinoProgress; cancelled: boolean; cancellation?: Promise<void>; done?: Promise<void> }
interface Live { profile: ConnectionProfile; http: JsonEndpoint; active: Map<string, Operation>; progress: Map<string, TrinoProgress>; status: ConnectionStatus }

/** GoogleSQL jobs and native REST catalogs; no PostgreSQL behavior or ambient Google credentials. */
export class BigQueryService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  constructor(private endpoint: (profile: ConnectionProfile, token: string) => JsonEndpoint = (profile, token) => new CloudJson('bigquery.googleapis.com', token, profile.queryTimeout, {}, profile.tls.ca || undefined)) {}
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    let http: JsonEndpoint | undefined
    try {
      if (profile.engine !== 'bigquery' || profile.host !== 'bigquery.googleapis.com' || profile.port !== 443 || !profile.tls.enabled || !profile.tls.rejectUnauthorized || profile.ssh.enabled) throw new Error('BigQuery requires its native bigquery.googleapis.com:443 endpoint with verified TLS. SSH and custom endpoints are unsupported.')
      project(profile.database)
      if (!secrets.password) throw new Error('Enter a BigQuery OAuth access token with explicit project permissions. Ambient credentials are never loaded.')
      http = this.endpoint(profile, secrets.password)
      failure(await http.request('GET', root(profile.database) + '/datasets?maxResults=1'))
      const status: ConnectionStatus = { state: 'connected', version: 'BigQuery REST v2 (managed service)', transport: 'Verified TLS · supplied OAuth access token · no automatic token refresh', checkedAt: new Date().toISOString() }
      this.connections.set(profile.id, { profile: structuredClone(profile), http, active: new Map(), progress: new Map(), status }); return status
    } catch (error) { http?.close(); const status: ConnectionStatus = { state: error instanceof CloudHttpError && error.status === 401 ? 'authentication-failed' : 'failed', error: error instanceof Error ? error.message : 'BigQuery connection failed.', checkedAt: new Date().toISOString() }; this.states.set(profile.id, status); return status }
  }
  private live(id: string): Live { const live = this.connections.get(id); if (!live) throw new Error('Connect explicitly to BigQuery.'); return live }
  status(id: string): ConnectionStatus { return structuredClone(this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }) }
  async listDatabases(id: string): Promise<string[]> {
    const live = this.live(id), body = await live.http.request('GET', '/bigquery/v2/projects?maxResults=1000'); failure(body)
    if (body.nextPageToken) throw new Error('More than 1,000 projects are visible; select a billing project explicitly in the profile.')
    return list(body.projects || []).map((item) => string(record(record(item).projectReference).projectId))
  }
  async listObjects(input: { connectionId: string; database?: string; schema?: string }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId), selected = project(input.database || live.profile.database)
    let datasets = input.schema ? [input.schema] : live.profile.schema ? [live.profile.schema] : []
    if (!datasets.length) { const body = await live.http.request('GET', root(selected) + '/datasets?maxResults=100'); failure(body); if (body.nextPageToken) throw new Error('More than 100 datasets are visible. Choose a preferred dataset to narrow browsing.'); datasets = list(body.datasets || []).map((item) => string(record(record(item).datasetReference).datasetId)) }
    const result: ObjectInfo[] = []
    for (const dataset of datasets) {
      const body = await live.http.request('GET', `${root(selected)}/datasets/${segment(dataset)}/tables?maxResults=1000`); failure(body)
      if (body.nextPageToken) throw new Error('This dataset has more than 1,000 tables; narrow the dataset outside this bounded explorer.')
      for (const item of list(body.tables || [])) { const table = record(item), reference = record(table.tableReference); result.push({ database: selected, schema: string(reference.datasetId), name: string(reference.tableId), kind: table.type === 'VIEW' ? 'view' : table.type === 'MATERIALIZED_VIEW' ? 'materialized view' : 'table' }) }
      if (result.length > 5000) throw new Error('More than 5,000 objects are visible. Select one preferred dataset.')
    }
    return result
  }
  async structure(input: { connectionId: string; database?: string; schema: string; table: string }): Promise<TableStructure> {
    const live = this.live(input.connectionId), selected = project(input.database || live.profile.database)
    const body = await live.http.request('GET', `${root(selected)}/datasets/${segment(input.schema)}/tables/${segment(input.table)}`); failure(body)
    const schema = fields(record(body.schema).fields)
    return { columns: schema.map((field) => ({ name: field.name, type: field.fields ? canonical(field) : `${field.type}${field.mode === 'REPEATED' ? ' REPEATED' : ''}`, nullable: field.mode !== 'REQUIRED', primaryKey: false, defaultValue: null })), indexes: [], constraints: [], foreignKeys: [], ddl: '-- BigQuery REST metadata; this is not executable DDL.\n' + canonical({ schema: body.schema, partitioning: body.timePartitioning || body.rangePartitioning, clustering: body.clustering }).split('\n').map((line) => '-- ' + line).join('\n') }
  }
  private configuration(live: Live, selected: string, sql: string, parameters: QueryParameter[] = []) {
    const safety = sqlSafety(sql, 'bigquery')
    if (safety.statementCount !== 1 || safety.controlsTransaction) throw new Error('Submit one GoogleSQL statement without session changes or raw transactions.')
    if (live.profile.readOnly && !safety.readOnly) throw new Error('The BigQuery profile is read-only. No job was submitted.')
    return { query: sql, useLegacySql: false, maximumBytesBilled: live.profile.bigQuery.maximumBytesBilled, parameterMode: 'NAMED', queryParameters: bigQueryParameters(parameters), ...(live.profile.schema ? { defaultDataset: { projectId: selected, datasetId: live.profile.schema } } : {}) }
  }
  async estimate(input: { connectionId: string; database: string; sql: string }): Promise<BigQueryEstimate> {
    const live = this.live(input.connectionId), selected = project(input.database)
    const body = await live.http.request('POST', root(selected) + '/queries', { ...this.configuration(live, selected, input.sql), dryRun: true, location: live.profile.bigQuery.location }); failure(body)
    return { processedBytes: exact(body.totalBytesProcessed || '0'), maximumBytesBilled: live.profile.bigQuery.maximumBytesBilled, location: live.profile.bigQuery.location, cacheCaveat: 'Dry run does not execute the query. Estimates and cache behavior can differ from billed execution; the server byte cap remains enforced.' }
  }
  private async stop(live: Live, operation: Operation): Promise<void> {
    if (operation.cancellation) return operation.cancellation
    operation.cancelled = true; operation.controller.abort(); operation.progress.cancellation = 'requested'
    operation.cancellation = (async () => { try { const body = await live.http.request('POST', `${root(operation.project)}/jobs/${segment(operation.jobId)}/cancel?location=${segment(live.profile.bigQuery.location)}`, {}, AbortSignal.timeout(5000)); failure(body); operation.progress.cancellation = 'acknowledged' } catch { operation.progress.cancellation = 'unconfirmed' } })()
    return operation.cancellation
  }
  private async run(live: Live, selected: string, sql: string, parameters: QueryParameter[] | undefined, sessionId: string, requestId: string, sink: QueryStreamSink, maxRows?: number) {
    if (live.active.has(sessionId) || live.active.size >= 4) throw new Error('BigQuery operation already active in this tab or four-job profile limit reached.')
    const config = this.configuration(live, selected, sql, parameters), start = performance.now()
    const operation: Operation = { requestId, project: selected, jobId: 'harbor_' + randomUUID().replaceAll('-', ''), controller: new AbortController(), cancelled: false, progress: { requestId, phase: 'SUBMITTING', pages: 0, rowsReceived: 0, elapsedMs: 0, cancellation: 'none' } }
    operation.progress.queryId = operation.jobId
    live.active.set(sessionId, operation)
    let release!: () => void; operation.done = new Promise<void>((resolve) => { release = resolve })
    const abort = () => { void this.stop(live, operation) }, timer = setTimeout(abort, live.profile.queryTimeout)
    sink.signal.addEventListener('abort', abort, { once: true })
    let truncated = false, affected = '0'
    try {
      if (sink.signal.aborted) throw new Error('BigQuery job cancelled before dispatch.')
      const body = await live.http.request('POST', root(selected) + '/jobs', { jobReference: { projectId: selected, jobId: operation.jobId, location: live.profile.bigQuery.location }, configuration: { query: config, jobTimeoutMs: String(live.profile.queryTimeout) } }, operation.controller.signal); failure(body)
      const jobPath = `${root(selected)}/jobs/${segment(operation.jobId)}?location=${segment(live.profile.bigQuery.location)}`
      for (;;) {
        const job = await live.http.request('GET', jobPath, undefined, operation.controller.signal); failure(job)
        const status = record(job.status); operation.progress.phase = string(status.state)
        const statistics = job.statistics ? record(job.statistics) : {}, query = statistics.query ? record(statistics.query) : {}
        if (query.totalBytesProcessed !== undefined) operation.progress.processedBytes = exact(query.totalBytesProcessed)
        if (query.numDmlAffectedRows !== undefined) affected = exact(query.numDmlAffectedRows)
        if (status.state === 'DONE') break
        await delay(500, undefined, { signal: operation.controller.signal })
      }
      let token: string | undefined, schema: Field[] | undefined, rows = 0, bytes = 0
      do {
        const page = await live.http.request('GET', `${root(selected)}/queries/${segment(operation.jobId)}?location=${segment(live.profile.bigQuery.location)}&maxResults=1000${token ? '&pageToken=' + segment(token) : ''}`, undefined, operation.controller.signal); failure(page)
        if (page.jobComplete === false) throw new Error('BigQuery result was not ready after a completed job.')
        operation.progress.pages++
        if (page.schema) { const current = fields(record(page.schema).fields); if (schema && canonical(schema) !== canonical(current)) throw new Error('BigQuery result schema changed between pages.'); if (!schema) { schema = current; await sink.onColumns(schema.map((field) => ({ name: field.name, type: field.type === 'TIMESTAMP' ? 'TIMESTAMP (exact epoch seconds)' : field.fields ? canonical(field) : `${field.type}${field.mode === 'REPEATED' ? ' REPEATED' : ''}` }))) } }
        for (const row of bigQueryRows(page, schema || [])) {
          const size = Buffer.byteLength(JSON.stringify(row))
          if (maxRows !== undefined && (rows >= maxRows || bytes + size > 8 * 1024 * 1024)) { truncated = true; break }
          await sink.onRow(row); rows++; bytes += size; operation.progress.rowsReceived++
        }
        if (page.numDmlAffectedRows !== undefined) affected = exact(page.numDmlAffectedRows)
        token = page.pageToken ? string(page.pageToken) : undefined
      } while (token && !truncated)
      operation.progress.phase = truncated ? 'LOADED LIMIT REACHED' : 'DONE'
      return { truncated, affected, durationMs: Math.round(performance.now() - start) }
    } catch (error) {
      // A stable user-generated native job ID allows cancellation after an uncertain submission, never resubmission.
      await this.stop(live, operation)
      operation.progress.phase = 'INTERRUPTED / CHECK JOB'
      live.status = { ...live.status, state: error instanceof CloudHttpError && error.status === 401 ? 'authentication-failed' : 'degraded', checkedAt: new Date().toISOString() }
      throw new Error(`${error instanceof Error ? error.message : 'BigQuery job failed.'} Native job ${operation.jobId}; cancellation ${operation.progress.cancellation}. Cancellation is best effort and does not reverse completed work or billing. No retry occurred.`)
    } finally {
      clearTimeout(timer); sink.signal.removeEventListener('abort', abort); operation.progress.elapsedMs = Math.round(performance.now() - start)
      live.progress.set(sessionId + '/' + requestId, structuredClone(operation.progress)); while (live.progress.size > 50) live.progress.delete(live.progress.keys().next().value!)
      live.active.delete(sessionId); release()
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId), selected = project(input.database || live.profile.database)
    if (input.confirm !== live.profile.name) throw new Error('Review the BigQuery billing project, location and byte cap, then type the exact profile name before submitting a job.')
    const columns: ResultColumn[] = [], rows: Cell[][] = []
    const result = await this.run(live, selected, input.sql, input.parameters, input.sessionId, input.requestId, { signal: new AbortController().signal, onColumns: async (value) => { columns.push(...value) }, onRow: async (row) => { rows.push(row) } }, input.maxRows)
    return { requestId: input.requestId, durationMs: result.durationMs, transaction: 'idle', sets: [{ columns, rows, truncated: result.truncated, command: 'GOOGLESQL JOB', affectedRows: Number.isSafeInteger(Number(result.affected)) ? Number(result.affected) : 0 }], messages: [`BigQuery billing project ${selected}; location ${live.profile.bigQuery.location}; maximum billed bytes ${live.profile.bigQuery.maximumBytesBilled}.`, `Exact affected rows: ${result.affected}. Result display limits do not reduce bytes processed or job charges.`, 'No interactive transaction or row editing support; native permissions remain authoritative.'] }
  }
  async table(_input: TableInput): Promise<QueryResult> { void _input; throw new Error('BigQuery rows require a reviewed job with explicit billing limits. Open the generated query and review before execution.') }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> { const live = this.live(input.connectionId); if (!sqlSafety(input.sql, 'bigquery').readOnly) throw new Error('BigQuery full export requires a read-only query.'); await this.run(live, project(input.database || live.profile.database), input.sql, input.parameters, randomUUID(), randomUUID(), sink) }
  progress(input: { connectionId: string; sessionId: string; requestId: string }): TrinoProgress | null { const live = this.live(input.connectionId), active = live.active.get(input.sessionId); return structuredClone(active?.requestId === input.requestId ? active.progress : live.progress.get(input.sessionId + '/' + input.requestId) || null) }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) { const live = this.live(input.connectionId), operation = live.active.get(input.sessionId); if (!operation || operation.requestId !== input.requestId) return { requested: false, message: 'This exact BigQuery job is no longer active.' }; await this.stop(live, operation); return { requested: true, message: `Cancellation ${operation.progress.cancellation}; BigQuery cancellation is best effort and cannot reverse completed billing or writes.` } }
  getSessionState(input: { connectionId: string; sessionId: string }): { state: 'idle'; connected: boolean; running: boolean } { const live = this.connections.get(input.connectionId); return { state: 'idle', connected: live?.status.state === 'connected', running: !!live?.active.has(input.sessionId) } }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> { const live = this.connections.get(input.connectionId), active = live?.active.get(input.sessionId); if (live && active) { await this.stop(live, active); await active.done } }
  async disconnect(id: string): Promise<void> { const live = this.connections.get(id); if (live) { await Promise.allSettled([...live.active.values()].map(async (active) => { await this.stop(live, active); await active.done })); live.http.close(); this.connections.delete(id) }; this.states.set(id, { state: 'disconnected' }) }
  async closeAll(): Promise<void> { await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id))) }
}
