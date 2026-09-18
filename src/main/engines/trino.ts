import { randomUUID } from 'node:crypto'
import type { Cell, ConnectionProfile, ConnectionStatus, ObjectInfo, QueryInput, QueryResult, ResultColumn, ResultSet, Secrets, TableInput, TableStructure } from '../../shared/contracts'
import type { TrinoPage, TrinoProgress } from '../../shared/trino'
import { requiredSqlConfirmation, sqlSafety, quoteIdentifier } from '../../shared/sql'
import { buildTableQuery } from '../../shared/table-query'
import { TrinoHttp, TrinoHttpError } from './trino-http'
import { openTransport, type Transport } from './transport'
import type { QueryStreamSink, StreamQueryInput } from './adapter'

interface Active {
  requestId: string; controller: AbortController; next?: string; transaction?: string
  cancelled: boolean; limited: boolean; timeout: boolean; killing?: Promise<void>
  progress: TrinoProgress; started: number; done?: Promise<void>
}
interface Live {
  profile: ConnectionProfile; transport: Transport; http: TrinoHttp; status: ConnectionStatus
  active: Map<string, Active>; progress: Map<string, TrinoProgress>; closed: boolean
}
const quote = (value: string) => quoteIdentifier(value, 'trino')
const literal = (value: string) => { if (value.includes('\0')) throw new Error('NUL is invalid in a catalog identifier.'); return "'" + value.replaceAll("'", "''") + "'" }
const text = (value: Cell | undefined) => value === null || value === undefined ? '' : String(value)
const LIMIT = 8 * 1024 * 1024

/** Trino direct-protocol SQL workbench. Connector capabilities are never inherited from PostgreSQL. */
export class TrinoService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'trino') throw new Error('Use a Trino profile.')
    await this.disconnect(profile.id)
    const start = performance.now(); let transport: Transport | undefined, live: Live | undefined
    try {
      transport = await openTransport(profile, secrets)
      live = { profile: structuredClone(profile), transport, http: new TrinoHttp(profile, transport, secrets), active: new Map(), progress: new Map(), status: { state: 'connecting' }, closed: false }
      this.connections.set(profile.id, live)
      const version = await this.read(live, undefined, 'SELECT version()', 1, true)
      if (!/^\d{3,}(?:[-.][\w.-]+)?$/.test(text(version.rows[0]?.[0]))) throw new Error('The endpoint did not report a recognizable Trino release.')
      live.status = { state: 'connected', version: `Trino ${text(version.rows[0][0])}`, durationMs: Math.round(performance.now() - start), transport: `${profile.ssh.enabled ? 'Pinned SSH tunnel · ' : ''}${profile.tls.enabled ? 'TLS' : 'HTTP'} · direct protocol · ${profile.trino.auth} authentication`, checkedAt: new Date().toISOString() }
      this.states.set(profile.id, live.status); return structuredClone(live.status)
    } catch (error) {
      live?.http.close(); await transport?.close(); this.connections.delete(profile.id)
      const status: ConnectionStatus = { state: error instanceof TrinoHttpError && error.status === 401 ? 'authentication-failed' : 'failed', error: error instanceof Error ? error.message : 'Trino connection failed.', durationMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString() }
      this.states.set(profile.id, status); return status
    }
  }
  status(id: string): ConnectionStatus { return structuredClone(this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }) }
  private live(id: string): Live { const live = this.connections.get(id); if (!live || live.closed) throw new Error('Connect explicitly to the Trino coordinator.'); return live }
  private catalog(live: Live, database?: string): string | undefined {
    const catalog = database ?? live.profile.database
    if (catalog && /[\r\n\0]/.test(catalog)) throw new Error('Invalid Trino catalog.')
    return catalog || undefined
  }
  private async stop(live: Live, active: Active): Promise<void> {
    active.cancelled = true; active.progress.cancellation = 'requested'
    if (active.killing) return active.killing
    active.killing = (async () => {
      const next = active.next
      active.controller.abort()
      try {
        if (!next) throw new Error('The coordinator has not acknowledged a query cursor.')
        await live.http.request('DELETE', next, { transaction: active.transaction, timeout: 5000 })
        active.progress.cancellation = 'acknowledged'
      } catch { active.progress.cancellation = 'unconfirmed' }
    })()
    return active.killing
  }
  private async pages(live: Live, active: Active, sql: string, catalog: string | undefined, sink?: { columns(value: ResultColumn[]): Promise<void>; row(value: Cell[]): Promise<boolean | void> }, signal = active.controller.signal, track = true): Promise<TrinoPage> {
    let page = await live.http.request('POST', '/v1/statement', { sql, catalog, schema: catalog ? live.profile.schema || undefined : undefined, transaction: active.transaction, signal })
    let columns: string | undefined
    while (page) {
      active.next = page.nextUri
      if (page.transaction) active.transaction = page.transaction
      if (page.clearTransaction) active.transaction = undefined
      if (track) {
        active.progress.queryId = page.id; active.progress.phase = page.phase; active.progress.pages++
        active.progress.processedRows = page.processedRows; active.progress.processedBytes = page.processedBytes
      }
      if (page.columns && sink) {
        const shape = JSON.stringify(page.columns)
        if (columns && columns !== shape) throw new Error('Trino columns changed during a query.')
        if (!columns) { columns = shape; await sink.columns(page.columns) }
      }
      for (const row of page.rows) {
        active.progress.rowsReceived++
        if (sink && await sink.row(row) === false) { active.limited = true; await this.stop(live, active); return page }
      }
      if (!page.nextUri) return page
      if (active.cancelled || signal.aborted) throw new Error('Trino query cancelled.')
      page = await live.http.request('GET', page.nextUri, { catalog, transaction: active.transaction, signal })
    }
    throw new Error('Trino ended without a query result.')
  }
  private async run(live: Live, sql: string, catalog: string | undefined, slot: string, requestId: string, readOnly: boolean, sink: { columns(value: ResultColumn[]): Promise<void>; row(value: Cell[]): Promise<boolean | void> }, signal?: AbortSignal): Promise<TrinoPage> {
    if (live.closed || signal?.aborted) throw new Error('Trino query cancelled before dispatch.')
    if (live.active.has(slot)) throw new Error('This Trino tab is already executing a query.')
    if (live.active.size >= 4) throw new Error('Four Trino operations are already running on this profile.')
    const active: Active = { requestId, controller: new AbortController(), cancelled: false, limited: false, timeout: false, started: performance.now(), progress: { requestId, phase: 'SUBMITTING', pages: 0, rowsReceived: 0, elapsedMs: 0, cancellation: 'none' } }
    live.active.set(slot, active)
    const abort = () => { void this.stop(live, active) }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { active.timeout = true; abort() }, live.profile.queryTimeout)
    let release!: () => void; active.done = new Promise<void>((resolve) => { release = resolve })
    try {
      if (readOnly) {
        await this.pages(live, active, 'START TRANSACTION READ ONLY', catalog, undefined, active.controller.signal, false)
        if (!active.transaction) throw new Error('Trino did not establish the required server read-only transaction.')
      }
      active.progress.pages = 0; active.progress.rowsReceived = 0
      const result = await this.pages(live, active, sql, catalog, sink)
      if (active.cancelled && !active.limited) throw new Error('Trino query cancelled.')
      live.status = { ...live.status, state: 'connected', error: undefined, checkedAt: new Date().toISOString() }
      return result
    } catch (error) {
      if (active.cancelled) {
        await active.killing
        throw new Error(`${active.timeout ? 'Trino query deadline exceeded.' : 'Trino query cancelled.'} ${active.progress.cancellation === 'acknowledged' ? 'The coordinator acknowledged cancellation.' : 'Server cancellation is unconfirmed; inspect any submitted write before retrying.'}`)
      }
      if (active.next) await this.stop(live, active)
      if (error instanceof TrinoHttpError && /transport|interrupted|deadline/i.test(error.message)) live.status = { ...live.status, state: 'degraded', error: error.message, checkedAt: new Date().toISOString() }
      throw error
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (active.transaction) {
        const cleanup = new AbortController(), deadline = setTimeout(() => cleanup.abort(), 5000)
        // Cancellation stops the submitted query, but the read-only transaction still needs closing.
        const cleanupActive: Active = { ...active, controller: cleanup, cancelled: false, next: undefined, progress: { ...active.progress } }
        try { await this.pages(live, cleanupActive, 'ROLLBACK', catalog, undefined, cleanup.signal, false) }
        catch { live.status = { ...live.status, state: 'degraded', error: 'Read-only transaction cleanup could not be confirmed. Reconnect explicitly; the server idle-transaction timeout remains authoritative.' } }
        finally { clearTimeout(deadline) }
      }
      active.progress.elapsedMs = Math.round(performance.now() - active.started)
      active.progress.phase = active.limited ? 'LIMIT REACHED' : active.cancelled ? 'CANCELLED / CHECK OUTCOME' : active.progress.phase
      live.progress.set(`${slot}/${requestId}`, structuredClone(active.progress))
      while (live.progress.size > 50) live.progress.delete(live.progress.keys().next().value!)
      live.active.delete(slot); release()
    }
  }
  private async read(live: Live, database: string | undefined, sql: string, maxRows = 5000, connecting = false): Promise<ResultSet> {
    const result: ResultSet = { columns: [], rows: [], affectedRows: 0, command: 'SELECT', truncated: false }; let bytes = 0
    await this.run(live, sql, connecting ? undefined : this.catalog(live, database), randomUUID(), randomUUID(), true, {
      columns: async (columns) => { result.columns = columns },
      row: async (row) => { const size = Buffer.byteLength(JSON.stringify(row)); if (result.rows.length >= maxRows || bytes + size > LIMIT) { result.truncated = true; return false } bytes += size; result.rows.push(row) },
    })
    result.affectedRows = result.rows.length; return result
  }
  async listDatabases(id: string): Promise<string[]> {
    const set = await this.read(this.live(id), undefined, 'SHOW CATALOGS')
    if (set.truncated) throw new Error('Catalog listing exceeded its bound.')
    return set.rows.map((row) => text(row[0]))
  }
  async listObjects(input: { connectionId: string; database?: string; schema?: string }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId), catalog = this.catalog(live, input.database)
    if (!catalog) throw new Error('Select an explicit Trino catalog to inspect its schemas and tables.')
    const set = await this.read(live, catalog, `SELECT table_schema,table_name,table_type FROM ${quote(catalog)}.information_schema.tables${input.schema ? ` WHERE table_schema=${literal(input.schema)}` : ''} ORDER BY table_schema,table_name LIMIT 5001`, 5001)
    if (set.truncated || set.rows.length > 5000) throw new Error('Catalog contains more than 5,000 visible objects. Select a schema to narrow inspection.')
    return set.rows.map((row) => ({ schema: text(row[0]), name: text(row[1]), kind: text(row[2]) === 'VIEW' ? 'view' : 'table', database: catalog }))
  }
  async structure(input: { connectionId: string; database?: string; schema: string; table: string }): Promise<TableStructure> {
    const live = this.live(input.connectionId), catalog = this.catalog(live, input.database)
    if (!catalog) throw new Error('Select a Trino catalog.')
    const set = await this.read(live, catalog, `SELECT column_name,data_type,is_nullable,column_default FROM ${quote(catalog)}.information_schema.columns WHERE table_schema=${literal(input.schema)} AND table_name=${literal(input.table)} ORDER BY ordinal_position`, 2000)
    if (set.truncated) throw new Error('Object has more columns than the supported inspection bound.')
    if (!set.rows.length) throw new Error('The object is unavailable or its column metadata is not permitted.')
    let ddl = '-- Native DDL is unavailable for this connector or principal.'
    try { const result = await this.read(live, catalog, `SHOW CREATE TABLE ${quote(catalog)}.${quote(input.schema)}.${quote(input.table)}`, 1); if (!result.truncated && typeof result.rows[0]?.[0] === 'string') ddl = result.rows[0][0] } catch (error) { ddl += `\n-- ${error instanceof Error ? error.message : 'Metadata request failed.'}` }
    return { columns: set.rows.map((row) => ({ name: text(row[0]), type: text(row[1]), nullable: text(row[2]) === 'YES', defaultValue: row[3] === null ? null : text(row[3]), primaryKey: false })), indexes: [], constraints: [], foreignKeys: [], ddl }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId), safety = sqlSafety(input.sql, 'trino')
    if (safety.statementCount !== 1 || safety.controlsTransaction || /^\s*(PREPARE|EXECUTE|DEALLOCATE)\b/i.test(input.sql)) throw new Error('Run one Trino statement. Session changes, raw transactions and prepared-statement commands are unavailable in this workflow.')
    if (input.parameters?.length) throw new Error('Trino parameter binding is not advertised by this adapter. No values were interpolated.')
    if (live.profile.readOnly && !safety.readOnly) throw new Error('The Trino profile is read-only. This statement was not sent.')
    const confirmation = requiredSqlConfirmation(input.sql, 'trino', live.profile)
    if (confirmation && input.confirm !== confirmation) throw new Error('Review the Trino connector write and type the exact profile name before execution.')
    const started = performance.now(), set: ResultSet = { columns: [], rows: [], affectedRows: 0, truncated: false, command: 'QUERY' }; let bytes = 0
    const page = await this.run(live, input.sql.trim().replace(/;\s*$/, ''), this.catalog(live, input.database), input.sessionId, input.requestId, safety.readOnly, {
      columns: async (columns) => { set.columns = columns },
      row: async (row) => { const size = Buffer.byteLength(JSON.stringify(row)); if (set.rows.length >= input.maxRows || bytes + size > LIMIT) { set.truncated = true; return false } set.rows.push(row); bytes += size },
    })
    const affected = Number(page.updateCount || set.rows.length)
    set.affectedRows = Number.isSafeInteger(affected) ? affected : 0; set.command = page.updateType || 'QUERY'
    return { requestId: input.requestId, sets: [set], durationMs: Math.round(performance.now() - started), transaction: 'idle', messages: [
      'Trino connector permissions and write semantics apply. Interactive transactions and row editing are unavailable.',
      ...(set.truncated ? ['Loaded result reached its explicit row/byte limit; remaining pages were cancelled.'] : []),
      ...(page.updateCount ? [`Server affected-row count (exact): ${page.updateCount}`] : []),
    ] }
  }
  async table(input: TableInput): Promise<QueryResult> {
    const structure = await this.structure(input), generated = buildTableQuery(input, structure, 'trino')
    const result = await this.execute({ connectionId: input.connectionId, database: input.database, sessionId: input.sessionId, requestId: randomUUID(), sql: generated.editorSql, maxRows: input.limit, privateSession: true })
    return { ...result, tableQuery: generated, messages: [...result.messages, 'Connector table ordering is not stable without an explicit sort; no primary-key metadata was inferred.'] }
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const live = this.live(input.connectionId), safety = sqlSafety(input.sql, 'trino')
    if (!safety.readOnly || safety.statementCount !== 1 || input.parameters?.length) throw new Error('Trino export requires one unparameterized read-only statement.')
    await this.run(live, input.sql.trim().replace(/;\s*$/, ''), this.catalog(live, input.database), randomUUID(), randomUUID(), true, { columns: sink.onColumns, row: sink.onRow }, sink.signal)
  }
  progress(input: { connectionId: string; sessionId: string; requestId: string }): TrinoProgress | null {
    const live = this.live(input.connectionId), active = live.active.get(input.sessionId)
    if (active?.requestId === input.requestId) return structuredClone({ ...active.progress, elapsedMs: Math.round(performance.now() - active.started) })
    return structuredClone(live.progress.get(`${input.sessionId}/${input.requestId}`) || null)
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }): Promise<{ requested: boolean; message: string }> {
    const live = this.live(input.connectionId), active = live.active.get(input.sessionId)
    if (!active || active.requestId !== input.requestId) return { requested: false, message: 'This exact Trino request is no longer active.' }
    await this.stop(live, active)
    return { requested: true, message: active.progress.cancellation === 'acknowledged' ? 'Trino coordinator acknowledged cancellation; a write might already have committed.' : 'Client stopped waiting; server cancellation is unconfirmed. Inspect writes before retrying.' }
  }
  getSessionState(input: { connectionId: string; sessionId: string }): { state: 'idle'; connected: boolean; running: boolean } {
    const live = this.connections.get(input.connectionId)
    return { state: 'idle', connected: !!live && !live.closed && live.status.state === 'connected', running: !!live?.active.has(input.sessionId) }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connections.get(input.connectionId), active = live?.active.get(input.sessionId)
    if (live && active) { await this.stop(live, active); await active.done }
  }
  async disconnect(id: string): Promise<void> {
    const live = this.connections.get(id)
    if (live) {
      live.closed = true
      await Promise.allSettled([...live.active.values()].map(async (active) => { await this.stop(live, active); await active.done }))
      live.http.close(); await live.transport.close(); this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll(): Promise<void> { await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id))) }
}
