import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import oracledb from 'oracledb'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  HarborAPI,
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
  oracleConfirmation,
  oracleProgram,
  oracleQuote,
  oracleSafety,
  oracleSql,
  oracleVisible,
} from '../../shared/oracle'
import type { ObjectInspection, ObjectInspectionInput } from '../../shared/inspection'
import { importTargetConfirmation, type ImportTarget } from '../../shared/imports'
import { ImportBatchError, type ImportWriter } from '../persistence/import-writer'
import { openTransport, type Transport } from './transport'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import {
  OracleInputError,
  oracleColumnProjection,
  closeOracleLobs,
  oracleBindings,
  oracleColumns,
  oracleFetchType,
  oracleImportExpression,
  oracleRow,
} from './oracle-values'

export const ORACLE_EXPORT_CONSISTENCY =
  'A fresh dedicated Oracle read-only transaction provides one consistent database snapshot. It excludes uncommitted changes in query tabs; the query is never replayed.'
interface Session {
  connection: oracledb.Connection
  state: 'idle' | 'open' | 'failed'
  busy: boolean
  cancelled: boolean
  closed: boolean
  requestId?: string
  timer?: ReturnType<typeof setTimeout>
  settled?: Promise<void>
  release?: () => void
}
interface Live {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  schema: string
  service: string
  sessions: Map<string, Session>
  pending: Map<string, Promise<Session>>
  closed: boolean
  status: ConnectionStatus
}
const codeOf = (error: unknown): string =>
  typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
function safeError(error: unknown): string {
  if (error instanceof OracleInputError) return error.message
  const code = codeOf(error)
  if (code === 'ORA-01017')
    return 'Oracle authentication failed. Verify the service, username and stored password.'
  if (code === 'ORA-01031')
    return 'Oracle denied this operation. Ask the administrator to review the account grants.'
  if (code === 'ORA-01013') return 'Oracle cancelled the current statement. No statement was replayed.'
  if (code === 'ORA-08177')
    return 'Oracle could not serialize this transaction. Roll back and review before retrying explicitly.'
  if (code === 'ORA-01438') return 'A value exceeds the Oracle destination precision.'
  return `Oracle operation failed${/^(ORA|NJS|DPI)-\d+$/.test(code) ? ' (' + code + ')' : ''}. Check syntax, service, permissions, types and transport. No statement was replayed.`
}
function fatal(error: unknown): boolean {
  return /^(?:NJS-|DPI-|ORA-(?:03113|03114|03135|125\d\d|12170|01012))/.test(codeOf(error))
}
function records(set: ResultSet): Record<string, Cell>[] {
  return set.rows.map((row) =>
    Object.fromEntries(set.columns.map((column, index) => [column.name, row[index]])),
  )
}
function serviceName(profile: ConnectionProfile): string {
  const value = profile.database || 'FREEPDB1'
  if (!/^[\w.$#-]+$/.test(value))
    throw new OracleInputError('Enter an Oracle service name, not a TNS alias, URL or connection descriptor.')
  return value
}

export class OracleService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  exportConsistency(): string {
    return ORACLE_EXPORT_CONSISTENCY
  }
  private live(id: string, database?: string): Live {
    const live = this.connections.get(id)
    if (!live || live.closed)
      throw new OracleInputError('Oracle is disconnected. Connect explicitly before continuing.')
    if (database && database !== live.service)
      throw new OracleInputError(
        'This Oracle connection is bound to another service. Create a separate connection profile.',
      )
    return live
  }
  private async create(live: Live): Promise<Session> {
    if (!oracledb.thin)
      throw new OracleInputError(
        'Harbor Oracle requires the pure JavaScript Thin driver. Thick mode is not enabled.',
      )
    const { profile, transport } = live
    if (!/^[A-Za-z0-9.:%_-]+$/.test(transport.host))
      throw new OracleInputError('Enter a hostname or IP address without connection descriptor characters.')
    const connectString = `(DESCRIPTION=(RETRY_COUNT=0)(CONNECT_TIMEOUT=${Math.ceil(profile.connectTimeout / 1000)})(TRANSPORT_CONNECT_TIMEOUT=${Math.ceil(profile.connectTimeout / 1000)})(ADDRESS=(PROTOCOL=${profile.tls.enabled ? 'TCPS' : 'TCP'})(HOST=${transport.host})(PORT=${transport.port}))(CONNECT_DATA=(SERVICE_NAME=${live.service})(SERVER=DEDICATED)))`
    let walletContent: string | undefined
    if (profile.tls.enabled && (profile.tls.ca || profile.tls.cert || profile.tls.keyPath)) {
      if (!profile.tls.ca || !profile.tls.cert || !profile.tls.keyPath)
        throw new OracleInputError(
          'Oracle Thin custom trust requires a complete PEM CA, client certificate and private-key file. CA-only wallets are not supported by this driver configuration.',
        )
      walletContent = [profile.tls.ca, profile.tls.cert, await readFile(profile.tls.keyPath, 'utf8')].join(
        '\n',
      )
    }
    const connection = await oracledb.getConnection({
      user: profile.username,
      password: live.secrets.password ?? '',
      connectString,
      sslServerDNMatch: true,
      sslAllowWeakDNMatch: false,
      ...(walletContent ? { walletContent } : {}),
    })
    const session: Session = { connection, state: 'idle', busy: false, cancelled: false, closed: false }
    try {
      if (live.closed) throw new OracleInputError('Oracle connection closed while opening a session.')
      connection.callTimeout = profile.queryTimeout
      connection.clientId = 'Harbor DB'
      for (const sql of [
        "ALTER SESSION SET NLS_NUMERIC_CHARACTERS='.,'",
        'ALTER SESSION SET NLS_DATE_FORMAT=\'SYYYY-MM-DD"T"HH24:MI:SS\'',
        'ALTER SESSION SET NLS_TIMESTAMP_FORMAT=\'SYYYY-MM-DD"T"HH24:MI:SS.FF9\'',
        "ALTER SESSION SET TIME_ZONE='+00:00'",
      ])
        await connection.execute(sql)
      if (live.schema)
        await connection.execute('ALTER SESSION SET CURRENT_SCHEMA=' + oracleQuote(live.schema))
      return session
    } catch (error) {
      await connection.close().catch(() => {})
      throw error
    }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'oracle')
      throw new OracleInputError('Use the matching engine adapter for this profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id),
      started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let live: Live | undefined
    try {
      if (!profile.username.trim())
        throw new OracleInputError(
          'Oracle username is required. External and SYSDBA authentication are not supported.',
        )
      if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
        throw new OracleInputError(
          'Oracle Thin requires verified TLS; disabling certificate verification is not supported.',
        )
      if (profile.tls.enabled && profile.ssh.enabled)
        throw new OracleInputError(
          'Combined Oracle SSH and TCPS is not supported because Thin cannot verify the original hostname through this local tunnel. Use direct verified TCPS or an explicitly trusted SSH tunnel with TCP.',
        )
      const service = serviceName(profile),
        transport = await openTransport(profile, secrets)
      live = {
        profile,
        secrets,
        transport,
        service,
        schema: profile.schema && profile.schema !== 'public' ? profile.schema : '',
        sessions: new Map(),
        pending: new Map(),
        closed: false,
        status: { state: 'connecting' },
      }
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      this.connections.set(profile.id, live)
      const session = await this.create(live)
      try {
        if (!session.connection.oracleServerVersion || session.connection.oracleServerVersion < 1201000000)
          throw new OracleInputError('Harbor Oracle Thin requires Oracle Database 12.1 or newer.')
        const current = await this.collect(
          session,
          "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS SCHEMA_NAME FROM DUAL",
          {},
          1,
        )
        live.schema = String(current.rows[0][0])
        live.status = {
          state: 'connected',
          version: 'Oracle ' + session.connection.oracleServerVersionString,
          transport: profile.ssh.enabled
            ? 'SSH tunnel + Oracle Thin TCP'
            : profile.tls.enabled
              ? 'Oracle Thin TCPS'
              : 'Oracle Thin TCP',
          durationMs: Math.round(performance.now() - started),
          lastConnectedAt: new Date().toISOString(),
        }
      } finally {
        await session.connection.close()
      }
      if (live.closed || this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      this.states.set(profile.id, live.status)
      return live.status
    } catch (error) {
      const stale = this.generations.get(profile.id) !== generation
      if (live && this.connections.get(profile.id) === live) await this.disconnect(profile.id)
      if (stale) return { state: 'disconnected' }
      const status: ConnectionStatus = {
        state: 'failed',
        error: safeError(error),
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private async session(live: Live, id: string): Promise<Session> {
    const existing = live.sessions.get(id)
    if (existing) {
      if (existing.closed)
        throw new OracleInputError(
          'This Oracle session was lost. Close the tab or reconnect explicitly; transactions are never restored.',
        )
      return existing
    }
    const pending = live.pending.get(id)
    if (pending) return pending
    if (live.sessions.size + live.pending.size >= 32)
      throw new OracleInputError('Close an Oracle query tab before opening more sessions.')
    const opening = this.create(live)
      .then((session) => {
        live.sessions.set(id, session)
        return session
      })
      .finally(() => live.pending.delete(id))
    live.pending.set(id, opening)
    return opening
  }
  private claim(live: Live, session: Session, requestId?: string): void {
    if (session.busy) throw new OracleInputError('This Oracle session is already running a request.')
    if (session.closed)
      throw new OracleInputError('This Oracle session is closed. Open a new tab explicitly.')
    session.busy = true
    session.cancelled = false
    session.requestId = requestId
    session.settled = new Promise((resolve) => {
      session.release = resolve
    })
    session.timer = setTimeout(() => {
      session.cancelled = true
      void session.connection.break().catch(() => {})
    }, live.profile.queryTimeout)
  }
  private release(session: Session): void {
    clearTimeout(session.timer)
    session.busy = false
    session.requestId = undefined
    session.release?.()
    session.release = undefined
  }
  private async lost(live: Live, session: Session): Promise<void> {
    session.closed = true
    session.state = 'failed'
    live.status = {
      ...live.status,
      state: 'degraded',
      error: 'An Oracle session was lost. Its transaction was not restored and no query was replayed.',
    }
    await session.connection.close().catch(() => {})
  }
  private async consume(
    session: Session,
    sql: string,
    binds: oracledb.BindParameters,
    onColumns: (columns: ResultColumn[]) => Promise<void>,
    onRow: (row: Cell[]) => Promise<boolean | void>,
    autoCommit = false,
  ): Promise<number> {
    const result = await session.connection.execute<unknown[]>(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      resultSet: true,
      prefetchRows: 0,
      fetchArraySize: 1,
      autoCommit,
      fetchTypeHandler: oracleFetchType,
    })
    if (result.warning) {
      await result.resultSet?.close()
      throw new OracleInputError(
        'Oracle completed the operation with a server warning. A stored unit may have been created with compilation errors; inspect its status and USER_ERRORS before invoking it.',
      )
    }
    if (result.implicitResults?.length) {
      for (const set of result.implicitResults) if ('close' in set) await set.close()
      throw new OracleInputError(
        'Implicit PL/SQL result cursors are not supported. Select their scalar results explicitly.',
      )
    }
    const cursor = result.resultSet
    if (!cursor) {
      await onColumns([])
      return result.rowsAffected ?? 0
    }
    try {
      const metadata = result.metaData ?? cursor.metaData
      await onColumns(oracleColumns(metadata))
      // Bound scalar batches by declared byte widths. LOB locators are streamed separately.
      const estimatedRowBytes = metadata.reduce((sum, column) => sum + (column.byteSize ?? 128), 0)
      const batchSize = Math.max(
        1,
        Math.min(50, Math.floor((2 * 1024 * 1024) / Math.max(1, estimatedRowBytes))),
      )
      while (!session.cancelled) {
        const rows = await cursor.getRows(batchSize)
        if (!rows.length) break
        let stop = false
        try {
          for (const raw of rows) {
            const row = await oracleRow(raw)
            if ((await onRow(row)) === false) {
              stop = true
              break
            }
            if (session.cancelled) break
          }
        } finally {
          closeOracleLobs(rows)
        }
        if (stop) break
      }
      if (session.cancelled)
        throw new OracleInputError('Oracle query was cancelled or timed out. No query was replayed.')
      return 0
    } finally {
      await cursor.close()
    }
  }
  private async collect(
    session: Session,
    sql: string,
    binds: oracledb.BindParameters = {},
    maxRows = 200,
    autoCommit = false,
  ): Promise<ResultSet> {
    const set: ResultSet = {
      columns: [],
      rows: [],
      affectedRows: 0,
      command: oracleVisible(sql).trim().split(/\s/)[0] ?? '',
      truncated: false,
    }
    let bytes = 0
    set.affectedRows = await this.consume(
      session,
      sql,
      binds,
      async (columns) => {
        set.columns = columns
      },
      async (row) => {
        const size = Buffer.byteLength(JSON.stringify(row))
        if (set.rows.length >= maxRows || bytes + size > 8 * 1024 * 1024) {
          set.truncated = true
          return false
        }
        bytes += size
        set.rows.push(row)
      },
      autoCommit,
    )
    return set
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId, input.database),
      sql = oracleSql(input.sql),
      safety = oracleSafety(sql),
      confirmation = oracleConfirmation(sql, live.profile)
    if (!safety.statementCount)
      throw new OracleInputError('Enter an Oracle SQL statement or one complete PL/SQL unit.')
    if (safety.controlsTransaction)
      throw new OracleInputError(
        'Use the transaction controls; session and system commands are not permitted in query tabs.',
      )
    if (live.profile.readOnly && !safety.readOnly)
      throw new OracleInputError('This Oracle profile is read-only.')
    if (confirmation && input.confirm !== confirmation)
      throw new OracleInputError('Type the connection name to confirm this Oracle operation.')
    const prepared = oracleBindings(sql, input.parameters),
      session = await this.session(live, input.sessionId),
      program = oracleProgram(oracleVisible(sql)),
      ddl = /^\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT)\b/i.test(oracleVisible(sql))
    if (session.state === 'open' && (program || ddl))
      throw new OracleInputError(
        'Finish the open transaction before running DDL or PL/SQL. Oracle can implicitly commit or execute transaction control inside these units.',
      )
    if (session.state === 'failed')
      throw new OracleInputError(
        'This Oracle transaction or session failed. Roll back or close it before continuing.',
      )
    this.claim(live, session, input.requestId)
    const started = performance.now()
    let fence = false
    try {
      if (live.profile.readOnly && session.state === 'idle') {
        await session.connection.execute('SET TRANSACTION READ ONLY')
        fence = true
      }
      const set = await this.collect(
        session,
        prepared.sql,
        prepared.binds,
        input.maxRows,
        session.state === 'idle' && !fence && !safety.readOnly,
      )
      return {
        requestId: input.requestId,
        sets: [set],
        durationMs: Math.round(performance.now() - started),
        messages: [
          ...(ddl ? ['Oracle DDL commits implicitly.'] : []),
          ...(program
            ? [
                'PL/SQL executed as a complete unit. Its internal transaction control and side effects belong to the program.',
              ]
            : []),
          ...(live.profile.readOnly
            ? [
                'Read-only transaction enforced; use a restricted server account for untrusted stored functions.',
              ]
            : []),
        ],
        transaction: session.state,
      }
    } catch (error) {
      if (fatal(error)) await this.lost(live, session)
      throw new OracleInputError(
        safeError(error) +
          (!safety.readOnly && (fatal(error) || session.cancelled)
            ? ' The write outcome may be uncertain; inspect server state before retrying.'
            : ''),
      )
    } finally {
      if (fence && !session.closed) await session.connection.rollback().catch(() => this.lost(live, session))
      this.release(session)
    }
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId?: string
  }): Promise<{ requested: boolean; message: string }> {
    const session = this.connections.get(input.connectionId)?.sessions.get(input.sessionId)
    if (!session?.busy || (input.requestId && session.requestId !== input.requestId))
      return { requested: false, message: 'This Oracle session has no matching running request.' }
    session.cancelled = true
    try {
      await session.connection.break()
      return {
        requested: true,
        message:
          'Oracle cancellation was requested on the same physical session. Wait for its final outcome.',
      }
    } catch {
      return {
        requested: true,
        message:
          'Oracle cancellation could not be acknowledged. The query or write outcome remains uncertain until the request finishes.',
      }
    }
  }
  async transaction(
    input: Parameters<HarborAPI['transaction']>[0],
  ): Promise<{ state: 'idle' | 'open' | 'failed' }> {
    const live = this.live(input.connectionId, input.database),
      session = await this.session(live, input.sessionId)
    this.claim(live, session)
    try {
      if (input.action === 'begin') {
        if (session.state !== 'idle')
          throw new OracleInputError('This Oracle tab already has an open transaction.')
        await session.connection.execute(
          live.profile.readOnly ? 'SET TRANSACTION READ ONLY' : 'SET TRANSACTION READ WRITE',
        )
        session.state = 'open'
      } else {
        if (session.state === 'idle') throw new OracleInputError('This Oracle tab has no open transaction.')
        if (input.action === 'commit') await session.connection.commit()
        else await session.connection.rollback()
        session.state = 'idle'
      }
      return { state: session.state }
    } catch (error) {
      if (fatal(error)) {
        await this.lost(live, session)
        throw new OracleInputError(
          'Oracle transaction acknowledgement was lost. Its outcome is uncertain; no transaction was restored or replayed.',
        )
      }
      throw new OracleInputError(safeError(error))
    } finally {
      this.release(session)
    }
  }
  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: 'idle' | 'open' | 'failed'
    connected: boolean
    running: boolean
  } {
    const live = this.connections.get(input.connectionId),
      session = live?.sessions.get(input.sessionId)
    return {
      state: session?.state ?? 'idle',
      connected: !!live && !live.closed && !session?.closed,
      running: session?.busy ?? false,
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connections.get(input.connectionId)
    if (!live) return
    await live.pending.get(input.sessionId)?.catch(() => {})
    const session = live.sessions.get(input.sessionId)
    if (!session) return
    if (session.busy) {
      await this.cancel(input)
      await session.settled
    }
    if (!session.closed) {
      await session.connection.rollback().catch(() => {})
      await session.connection.close().catch(() => {})
    }
    session.closed = true
    live.sessions.delete(input.sessionId)
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const live = this.connections.get(id)
    if (live) {
      live.closed = true
      await Promise.allSettled([...live.pending.values()])
      for (const sessionId of live.sessions.keys()) await this.closeSession({ connectionId: id, sessionId })
      await live.transport.close()
      this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
  async listDatabases(id: string): Promise<string[]> {
    return [this.live(id).service]
  }
  private async metadata<T>(live: Live, run: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.create(live)
    this.claim(live, session)
    try {
      return await run(session)
    } catch (error) {
      throw new OracleInputError(safeError(error))
    } finally {
      this.release(session)
      await session.connection.rollback().catch(() => {})
      await session.connection.close().catch(() => {})
    }
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId, input.database)
    return this.metadata(live, async (session) =>
      records(
        await this.collect(
          session,
          "SELECT OWNER,OBJECT_NAME,OBJECT_TYPE FROM ALL_OBJECTS WHERE OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','FUNCTION','PROCEDURE','PACKAGE','SEQUENCE','TRIGGER') AND (:owner IS NULL OR OWNER=:owner) AND GENERATED='N' ORDER BY OWNER,OBJECT_TYPE,OBJECT_NAME",
          { owner: input.schema || live.schema },
          10000,
        ),
      ).map((row) => ({
        name: String(row.OBJECT_NAME),
        schema: String(row.OWNER),
        database: live.service,
        kind:
          row.OBJECT_TYPE === 'MATERIALIZED VIEW'
            ? 'materialized view'
            : ['FUNCTION', 'PROCEDURE', 'PACKAGE'].includes(String(row.OBJECT_TYPE))
              ? 'function'
              : (String(row.OBJECT_TYPE).toLowerCase() as ObjectInfo['kind']),
      })),
    )
  }
  private async structureOn(
    live: Live,
    session: Session,
    schema: string,
    table: string,
    columnsOnly = false,
  ): Promise<TableStructure> {
    oracleQuote(schema)
    oracleQuote(table)
    const binds = { owner: schema, tab: table }
    const columns = records(
      await this.collect(
        session,
        "SELECT c.COLUMN_NAME,c.DATA_TYPE,c.DATA_LENGTH,c.CHAR_LENGTH,c.CHAR_USED,c.DATA_PRECISION,c.DATA_SCALE,c.NULLABLE,c.VIRTUAL_COLUMN,c.IDENTITY_COLUMN,(SELECT cc.POSITION FROM ALL_CONSTRAINTS k JOIN ALL_CONS_COLUMNS cc ON cc.OWNER=k.OWNER AND cc.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.OWNER=c.OWNER AND k.TABLE_NAME=c.TABLE_NAME AND k.CONSTRAINT_TYPE='P' AND cc.COLUMN_NAME=c.COLUMN_NAME) AS PK_POSITION FROM ALL_TAB_COLS c WHERE c.OWNER=:owner AND c.TABLE_NAME=:tab AND c.HIDDEN_COLUMN='NO' ORDER BY c.COLUMN_ID",
        binds,
        1000,
      ),
    )
    if (!columns.length) throw new OracleInputError('Oracle table or view is not visible to this account.')
    const mappedColumns = columns.map((row) => {
      let type = String(row.DATA_TYPE)
      if (type === 'NUMBER' && row.DATA_PRECISION !== null)
        type += `(${row.DATA_PRECISION},${row.DATA_SCALE ?? 0})`
      else if (/^(N?VARCHAR2|N?CHAR|RAW)$/.test(type))
        type += `(${row.CHAR_USED === 'C' ? row.CHAR_LENGTH : row.DATA_LENGTH}${row.CHAR_USED === 'C' ? ' CHAR' : ''})`
      return {
        name: String(row.COLUMN_NAME),
        type,
        nullable: row.NULLABLE === 'Y',
        defaultValue:
          row.VIRTUAL_COLUMN === 'YES'
            ? 'GENERATED VIRTUAL'
            : row.IDENTITY_COLUMN === 'YES'
              ? 'GENERATED IDENTITY'
              : null,
        primaryKey: row.PK_POSITION !== null,
        ...(row.PK_POSITION !== null ? { primaryKeyPosition: Number(row.PK_POSITION) } : {}),
      }
    })
    if (columnsOnly) return { columns: mappedColumns, constraints: [], foreignKeys: [], indexes: [], ddl: '' }
    const constraintRows = records(
      await this.collect(
        session,
        'SELECT k.CONSTRAINT_NAME,k.CONSTRAINT_TYPE,k.STATUS,k.DELETE_RULE,k.R_OWNER,p.TABLE_NAME AS P_TABLE,c.COLUMN_NAME,c.POSITION,r.COLUMN_NAME AS P_COLUMN,k.SEARCH_CONDITION_VC FROM ALL_CONSTRAINTS k LEFT JOIN ALL_CONS_COLUMNS c ON c.OWNER=k.OWNER AND c.CONSTRAINT_NAME=k.CONSTRAINT_NAME LEFT JOIN ALL_CONSTRAINTS p ON p.OWNER=k.R_OWNER AND p.CONSTRAINT_NAME=k.R_CONSTRAINT_NAME LEFT JOIN ALL_CONS_COLUMNS r ON r.OWNER=p.OWNER AND r.CONSTRAINT_NAME=p.CONSTRAINT_NAME AND r.POSITION=c.POSITION WHERE k.OWNER=:owner AND k.TABLE_NAME=:tab ORDER BY k.CONSTRAINT_NAME,c.POSITION',
        binds,
        5000,
      ),
    )
    const groups = new Map<string, Record<string, Cell>[]>()
    for (const row of constraintRows) {
      const name = String(row.CONSTRAINT_NAME)
      groups.set(name, [...(groups.get(name) ?? []), row])
    }
    const foreignKeys: NonNullable<TableStructure['foreignKeys']> = [],
      constraints: TableStructure['constraints'] = []
    for (const [name, rows] of groups) {
      const first = rows[0],
        names = rows.filter((row) => row.COLUMN_NAME).map((row) => oracleQuote(String(row.COLUMN_NAME)))
      let definition = String(first.CONSTRAINT_TYPE)
      if (first.CONSTRAINT_TYPE === 'R') {
        foreignKeys.push({
          name,
          columns: rows.map((row) => String(row.COLUMN_NAME)),
          referencedDatabase: live.service,
          referencedSchema: String(first.R_OWNER),
          referencedTable: String(first.P_TABLE),
          referencedColumns: rows.map((row) => String(row.P_COLUMN)),
          onDelete: String(first.DELETE_RULE),
        })
        definition = `FOREIGN KEY (${names.join(', ')}) REFERENCES ${oracleQuote(String(first.R_OWNER))}.${oracleQuote(String(first.P_TABLE))} (${rows.map((row) => oracleQuote(String(row.P_COLUMN))).join(', ')}) ON DELETE ${first.DELETE_RULE}`
      } else if (first.CONSTRAINT_TYPE === 'P' || first.CONSTRAINT_TYPE === 'U')
        definition =
          (first.CONSTRAINT_TYPE === 'P' ? 'PRIMARY KEY' : 'UNIQUE') + ' (' + names.join(', ') + ')'
      else if (first.CONSTRAINT_TYPE === 'C')
        definition = 'CHECK (' + String(first.SEARCH_CONDITION_VC ?? 'condition not visible') + ')'
      constraints.push({ name, definition: definition + ' — ' + first.STATUS })
    }
    const indexes = records(
        await this.collect(
          session,
          'SELECT i.INDEX_NAME,i.UNIQUENESS,i.INDEX_TYPE,c.COLUMN_NAME,c.COLUMN_POSITION,c.DESCEND FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER=i.OWNER AND c.INDEX_NAME=i.INDEX_NAME WHERE i.TABLE_OWNER=:owner AND i.TABLE_NAME=:tab ORDER BY i.INDEX_NAME,c.COLUMN_POSITION',
          binds,
          5000,
        ),
      ),
      indexGroups = new Map<string, Record<string, Cell>[]>()
    for (const row of indexes) {
      const name = String(row.INDEX_NAME)
      indexGroups.set(name, [...(indexGroups.get(name) ?? []), row])
    }
    let ddl =
      '-- Server DDL is unavailable to this account. The native catalog metadata below remains available.'
    try {
      const kind = records(
        await this.collect(
          session,
          "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER=:owner AND OBJECT_NAME=:tab AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW')",
          binds,
          1,
        ),
      )[0]?.OBJECT_TYPE
      ddl = String(
        (
          await this.collect(
            session,
            'SELECT DBMS_METADATA.GET_DDL(:kind,:tab,:owner) AS DDL FROM DUAL',
            { ...binds, kind: String(kind ?? 'TABLE').replaceAll(' ', '_') },
            1,
          )
        ).rows[0][0],
      )
    } catch (error) {
      // DDL privileges can be narrower than ALL_* visibility; transport or size failures are not a metadata success.
      if (!['ORA-31603', 'ORA-31608', 'ORA-01031'].includes(codeOf(error))) throw error
    }
    const structure: TableStructure = {
      columns: mappedColumns,
      constraints,
      foreignKeys,
      indexes: [...indexGroups].map(([name, rows]) => ({
        name,
        definition: `${rows[0].UNIQUENESS} ${rows[0].INDEX_TYPE} (${rows.map((row) => oracleQuote(String(row.COLUMN_NAME)) + ' ' + row.DESCEND).join(', ')})`,
      })),
      ddl,
    }
    if (Buffer.byteLength(JSON.stringify(structure)) > 8 * 1024 * 1024)
      throw new OracleInputError(
        'Oracle structure metadata exceeds the 8 MiB inspection limit. Inspect a narrower object projection.',
      )
    return structure
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const live = this.live(input.connectionId, input.database)
    return this.metadata(live, (session) =>
      this.structureOn(live, session, input.schema || live.schema, input.table),
    )
  }
  async table(input: TableInput): Promise<QueryResult> {
    const live = this.live(input.connectionId, input.database),
      schema = input.schema || live.schema,
      structure = await this.structure({ ...input, schema }),
      known = new Set(structure.columns.map((column) => column.name)),
      parameters: NonNullable<QueryInput['parameters']> = [],
      conditions = input.filters?.conditions ?? (input.filter ? [input.filter] : [])
    const where = conditions
      .map((condition, index) => {
        if (!known.has(condition.column))
          throw new OracleInputError('The Oracle filter column no longer exists.')
        const column = oracleQuote(condition.column)
        if (condition.operator === 'is null' || condition.operator === 'is not null')
          return column + ' ' + condition.operator.toUpperCase()
        const name = 'filter' + index
        parameters.push({ name, type: 'text', secret: false, value: condition.value })
        if (condition.operator === 'contains') return `INSTR(${column},:${name}) > 0`
        const operator = { equals: '=', 'not equals': '<>', 'greater than': '>', 'less than': '<' }[
          condition.operator
        ]
        return `${column} ${operator} :${name}`
      })
      .join(input.filters?.match === 'any' ? ' OR ' : ' AND ')
    const sorts =
      input.sorts ??
      (input.sort
        ? [{ column: input.sort, direction: input.direction }]
        : structure.columns
            .filter((column) => column.primaryKey)
            .sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0))
            .map((column) => ({ column: column.name, direction: 'asc' as const })))
    const order = sorts
      .map((sort) => {
        if (!known.has(sort.column)) throw new OracleInputError('The Oracle sort column no longer exists.')
        return oracleQuote(sort.column) + ' ' + sort.direction.toUpperCase()
      })
      .join(', ')
    const sql = `SELECT ${structure.columns.map(oracleColumnProjection).join(',')} FROM ${oracleQuote(schema)}.${oracleQuote(input.table)}${where ? ' WHERE ' + where : ''}${order ? ' ORDER BY ' + order : ''} OFFSET ${input.offset} ROWS FETCH NEXT ${input.limit + 1} ROWS ONLY`
    const result = await this.execute({
      connectionId: input.connectionId,
      database: input.database,
      sessionId: input.sessionId,
      requestId: randomUUID(),
      sql,
      parameters,
      maxRows: input.limit,
      privateSession: false,
    })
    // Preserve native type metadata even when values use a lossless server text projection.
    if (result.sets[0])
      result.sets[0].columns.forEach((column, index) => {
        column.type = structure.columns[index]?.type ?? column.type
      })
    result.tableQuery = { sql, parameters: parameters.map((parameter) => parameter.value), editorSql: sql }
    if (!order)
      result.messages.push('Oracle pagination has no unique key ordering; concurrent changes may move rows.')
    return result
  }
  async inspectObject(input: ObjectInspectionInput): Promise<ObjectInspection> {
    const live = this.live(input.connectionId, input.database)
    return this.metadata(live, async (session) => {
      const properties = records(
        await this.collect(
          session,
          `SELECT OBJECT_TYPE,STATUS,LTRIM(TO_CHAR(CREATED,'SYYYY-MM-DD"T"HH24:MI:SS')) AS CREATED,LTRIM(TO_CHAR(LAST_DDL_TIME,'SYYYY-MM-DD"T"HH24:MI:SS')) AS LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER=:owner AND OBJECT_NAME=:name ORDER BY OBJECT_TYPE`,
          { owner: input.schema, name: input.name },
          20,
        ),
      )
      if (!properties.length) throw new OracleInputError('Oracle object is not visible.')
      if (input.kind === 'table' || input.kind === 'view') {
        const structure = await this.structureOn(live, session, input.schema, input.name)
        return {
          structure,
          definition: { text: structure.ddl, source: structure.ddl.startsWith('--') ? 'summary' : 'server' },
          properties: [
            { name: 'Schema', value: input.schema },
            ...Object.entries(properties[0]).map(([name, value]) => ({ name, value: String(value ?? '') })),
          ],
          warnings: [
            'Catalog defaults are shown in server DDL; generated-column markers are not executable expressions.',
          ],
        }
      }
      const kind = String(
          properties.find((row) =>
            ['FUNCTION', 'PROCEDURE', 'PACKAGE', 'TRIGGER'].includes(String(row.OBJECT_TYPE)),
          )?.OBJECT_TYPE ?? 'FUNCTION',
        ),
        set = await this.collect(
          session,
          'SELECT DBMS_METADATA.GET_DDL(:kind,:name,:owner) AS DDL FROM DUAL',
          { kind, name: input.name, owner: input.schema },
          1,
        )
      return {
        properties: [
          { name: 'Kind', value: kind },
          { name: 'Schema', value: input.schema },
        ],
        definition: { text: String(set.rows[0][0]), source: 'server' },
        warnings: [],
      }
    })
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const live = this.live(input.connectionId, input.database),
      sql = oracleSql(input.sql)
    if (!oracleSafety(sql).readOnly)
      throw new OracleInputError(
        'Oracle exports require one read-only SELECT. Writes and PL/SQL are never replayed for export.',
      )
    const prepared = oracleBindings(sql, input.parameters),
      session = await this.create(live),
      abort = () => {
        session.cancelled = true
        void session.connection.break().catch(() => {})
      }
    this.claim(live, session)
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      if (sink.signal.aborted) throw new OracleInputError('Oracle export was cancelled.')
      await session.connection.execute('SET TRANSACTION READ ONLY')
      await this.consume(session, prepared.sql, prepared.binds, sink.onColumns, async (row) => {
        if (sink.signal.aborted) throw new OracleInputError('Oracle export was cancelled.')
        await sink.onRow(row)
      })
    } catch (error) {
      if (error instanceof OracleInputError) throw error
      if (codeOf(error)) throw new OracleInputError(safeError(error))
      throw error
    } finally {
      sink.signal.removeEventListener('abort', abort)
      this.release(session)
      await session.connection.rollback().catch(() => {})
      await session.connection.close().catch(() => {})
    }
  }
  async openImport(target: ImportTarget & { columns: string[] }, signal: AbortSignal): Promise<ImportWriter> {
    const live = this.live(target.connectionId, target.database)
    if (live.profile.readOnly) throw new OracleInputError('This Oracle profile is read-only.')
    if (
      live.profile.environment.toLowerCase() === 'production' &&
      target.confirm !== importTargetConfirmation(target)
    )
      throw new OracleInputError('Confirm the exact Oracle import target before writing.')
    const session = await this.create(live),
      schema = target.schema || live.schema
    let closed = false,
      committing = false,
      busy = false
    const abort = () => {
      session.cancelled = true
      if (!committing) void session.connection.break().catch(() => {})
    }
    signal.addEventListener('abort', abort)
    try {
      const writable = async (): Promise<void> => {
        const binds = { owner: schema, tab: target.table }
        const result = await this.collect(
          session,
          "SELECT COUNT(*) AS N FROM ALL_TABLES WHERE OWNER=:owner AND TABLE_NAME=:tab AND TEMPORARY='N' AND NESTED='NO' AND (IOT_TYPE IS NULL OR IOT_TYPE='IOT')",
          binds,
          1,
        )
        const excluded = await this.collect(
          session,
          "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER=:owner AND OBJECT_NAME=:tab AND OBJECT_TYPE='MATERIALIZED VIEW'",
          binds,
          1,
        )
        const external = await this.collect(
          session,
          'SELECT TABLE_NAME FROM ALL_EXTERNAL_TABLES WHERE OWNER=:owner AND TABLE_NAME=:tab',
          binds,
          1,
        )
        if (result.rows[0]?.[0] !== '1' || excluded.rows.length || external.rows.length)
          throw new OracleInputError(
            'Oracle imports require an ordinary persistent table. Views, materialized views, temporary tables and external tables are not supported.',
          )
      }
      await writable()
      const structure = await this.structureOn(live, session, schema, target.table, true),
        columns = target.columns.map((name) => {
          const column = structure.columns.find((column) => column.name === name)
          if (!column || column.defaultValue?.startsWith('GENERATED'))
            throw new OracleInputError(
              'Choose existing writable Oracle columns; generated columns cannot be imported.',
            )
          return column
        })
      if (!columns.length || new Set(target.columns).size !== columns.length)
        throw new OracleInputError('Choose distinct Oracle import columns.')
      const close = async () => {
        if (closed) return
        closed = true
        signal.removeEventListener('abort', abort)
        if (busy)
          throw new OracleInputError('Wait for the active Oracle import batch before closing its writer.')
        await session.connection.rollback().catch(() => {})
        await session.connection.close().catch(() => {})
      }
      return {
        columns,
        commitModel: 'transaction',
        warnings: [
          'Oracle empty text strings are stored as NULL. Each batch commits independently. Server triggers may have additional or autonomous side effects; review them before importing.',
        ],
        close,
        writeBatch: async (rows) => {
          if (closed || busy || signal.aborted)
            throw new ImportBatchError(
              'Oracle import was cancelled before the next batch.',
              'rolled-back',
              rows.length,
            )
          if (rows.length > 500 || Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024)
            throw new ImportBatchError(
              'Oracle import batch exceeds its row or byte limit.',
              'rolled-back',
              rows.length,
            )
          busy = true
          this.claim(live, session)
          let dispatched = false
          try {
            const prepared = rows.map((row) => {
              if (row.length !== columns.length)
                throw new OracleInputError('Oracle import row width differs from its mapping.')
              return row.map((value, index) => oracleImportExpression(value, columns[index], 'v' + index))
            })
            await session.connection.execute(
              `LOCK TABLE ${oracleQuote(schema)}.${oracleQuote(target.table)} IN ROW SHARE MODE NOWAIT`,
            )
            await writable()
            const fresh = await this.structureOn(live, session, schema, target.table, true)
            if (
              columns.some(
                (column) =>
                  !fresh.columns.some(
                    (current) =>
                      current.name === column.name &&
                      current.type === column.type &&
                      !current.defaultValue?.startsWith('GENERATED'),
                  ),
              )
            )
              throw new OracleInputError(
                'Oracle destination columns changed since preview. Review the mapping again.',
              )
            for (const row of prepared) {
              if (signal.aborted || session.cancelled)
                throw new OracleInputError('Oracle import was cancelled.')
              dispatched = true
              await session.connection.execute(
                `INSERT INTO ${oracleQuote(schema)}.${oracleQuote(target.table)} (${columns.map((column) => oracleQuote(column.name)).join(',')}) VALUES (${row.map((item) => item.expression).join(',')})`,
                Object.fromEntries(row.map((item, index) => ['v' + index, item.bind])),
                { autoCommit: false },
              )
            }
            if (signal.aborted || session.cancelled)
              throw new OracleInputError('Oracle import was cancelled before commit.')
            committing = true
            clearTimeout(session.timer)
            await session.connection.commit()
          } catch (error) {
            let rolledBack = false
            if (!committing && !fatal(error))
              try {
                await session.connection.rollback()
                rolledBack = true
              } catch {
                /* Failed acknowledgement is uncertain. */
              }
            throw new ImportBatchError(
              safeError(error) +
                (committing
                  ? ' Oracle commit acknowledgement was lost; inspect the target before retrying.'
                  : ''),
              rolledBack || (!dispatched && !committing) ? 'rolled-back' : 'uncertain',
              rows.length,
            )
          } finally {
            committing = false
            busy = false
            this.release(session)
          }
        },
      }
    } catch (error) {
      signal.removeEventListener('abort', abort)
      await session.connection.rollback().catch(() => {})
      await session.connection.close().catch(() => {})
      throw error instanceof OracleInputError ? error : new OracleInputError(safeError(error))
    }
  }
}
