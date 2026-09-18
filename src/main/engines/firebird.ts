import { randomUUID } from 'node:crypto'
import { createWireClient } from 'node-firebird-driver-wire'
import {
  TransactionIsolation,
  type Attachment,
  type Client,
  type Statement,
  type Transaction,
  type ResultSet as NativeResultSet,
} from 'node-firebird-driver'
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
import { firebirdLiteral, firebirdQuote } from '../../shared/firebird'
import { requiredSqlConfirmation, sqlSafety } from '../../shared/sql'
import { openTransport, type Transport } from './transport'
import { firebirdExactStatement, firebirdRow, FirebirdInputError } from './firebird-values'
import type { QueryStreamSink, StreamQueryInput } from './adapter'

interface Session {
  client: Client
  attachment: Attachment
  transaction?: Transaction
  state: 'idle' | 'open' | 'failed'
  busy?: string
  cancelled: boolean
  closing: boolean
  done?: Promise<void>
}
interface Live {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  sessions: Map<string, Session>
  creating: Map<string, Promise<Session>>
  status: ConnectionStatus
  closing: boolean
}
const errorText = (error: unknown) =>
  error instanceof FirebirdInputError
    ? error.message.slice(0, 600)
    : 'Firebird rejected or lost the operation. Check privileges, statement syntax and transport; driver details are omitted.'

export class FirebirdService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live || live.closing) throw new FirebirdInputError('Connect explicitly to Firebird.')
    return live
  }
  private target(live: Live, database?: string) {
    if (database && database !== live.profile.database)
      throw new FirebirdInputError(
        'Firebird tab database differs from its physical attachment. Reconnect another profile explicitly.',
      )
  }
  status(id: string): ConnectionStatus {
    return structuredClone(
      this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' },
    )
  }
  private async session(live: Live, id: string): Promise<Session> {
    const existing = live.sessions.get(id)
    if (existing) {
      if (existing.closing || !existing.attachment.isValid)
        throw new FirebirdInputError('Firebird tab attachment closed; open a new tab explicitly.')
      return existing
    }
    if (live.creating.has(id)) return live.creating.get(id)!
    if (live.sessions.size + live.creating.size >= 12)
      throw new FirebirdInputError('Firebird profile already has twelve live tab attachments.')
    const opening = (async () => {
      const client = createWireClient({ timeoutMs: live.profile.queryTimeout })
      let attachment: Attachment | undefined
      try {
        attachment = await client.connect(
          `${live.transport.host}/${live.transport.port}:${live.profile.database}`,
          {
            username: live.profile.username,
            password: live.secrets.password,
            role: live.profile.firebird.role || undefined,
          },
        )
        await attachment.enableCancellation(true)
        if (live.closing) throw new FirebirdInputError('Firebird connection closed while opening a tab.')
        const session: Session = { client, attachment, state: 'idle', cancelled: false, closing: false }
        live.sessions.set(id, session)
        return session
      } catch (error) {
        await attachment?.disconnect().catch(() => {})
        await client.dispose().catch(() => {})
        throw error
      }
    })()
    live.creating.set(id, opening)
    try {
      return await opening
    } finally {
      live.creating.delete(id)
    }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    let transport: Transport | undefined
    try {
      if (
        profile.engine !== 'firebird' ||
        !profile.database ||
        /[\r\n\0]/.test(profile.database) ||
        /[\r\n\0/:]/.test(profile.host)
      )
        throw new FirebirdInputError(
          'Select an explicit Firebird hostname and database alias or server file path. IPv6 is not yet supported by this pinned driver.',
        )
      if (profile.tls.enabled)
        throw new FirebirdInputError(
          'Firebird native wire authentication is not TLS. Use verified SSH for remote servers; TLS settings are not silently ignored.',
        )
      if (!profile.ssh.enabled && !['localhost', '127.0.0.1'].includes(profile.host))
        throw new FirebirdInputError(
          'Use a verified SSH tunnel for a remote Firebird endpoint. Direct native wire connections are limited to loopback.',
        )
      if (
        profile.firebird.mode === 'local-file' &&
        (profile.ssh.enabled ||
          !['localhost', '127.0.0.1'].includes(profile.host) ||
          !/^(?:\/|[A-Za-z]:[\\/])/.test(profile.database))
      )
        throw new FirebirdInputError(
          'Local-file mode requires an absolute path served by your loopback Firebird server. Embedded opening is not advertised.',
        )
      if (!profile.username || !secrets.password)
        throw new FirebirdInputError('Firebird requires explicitly supplied username/password credentials.')
      transport = await openTransport(profile, secrets)
      const live: Live = {
        profile: structuredClone(profile),
        secrets: { ...secrets },
        transport,
        sessions: new Map(),
        creating: new Map(),
        status: { state: 'connecting' },
        closing: false,
      }
      this.connections.set(profile.id, live)
      const version = await this.read(
        live,
        "SELECT RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION') AS VERSION FROM RDB$DATABASE",
        1,
      )
      const text = String(version.rows[0]?.[0] || '')
      if (!/^5\./.test(text))
        throw new FirebirdInputError(
          'This Firebird adapter currently requires Firebird 5.x; other server majors are not advertised.',
        )
      live.status = {
        state: 'connected',
        version: `Firebird ${text}`,
        transport: profile.ssh.enabled
          ? 'Verified SSH · native Firebird authentication · pinned beta wire driver'
          : 'Loopback · native Firebird authentication · pinned beta wire driver',
        checkedAt: new Date().toISOString(),
      }
      return structuredClone(live.status)
    } catch (error) {
      await this.disconnect(profile.id)
      await transport?.close()
      const status: ConnectionStatus = {
        state: 'failed',
        error: errorText(error),
        checkedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  private async executeSession(
    live: Live,
    session: Session,
    sql: string,
    requestId: string,
    sink: QueryStreamSink,
    maximumRows?: number,
  ) {
    const safety = sqlSafety(sql, 'firebird')
    if (safety.statementCount !== 1 || safety.controlsTransaction)
      throw new FirebirdInputError(
        'Run one Firebird statement; use the transaction controls instead of raw session/transaction SQL.',
      )
    if (live.profile.readOnly && !safety.readOnly)
      throw new FirebirdInputError('This Firebird profile is read-only; no statement was executed.')
    if (session.busy || session.closing || session.state === 'failed' || sink.signal.aborted)
      throw new FirebirdInputError(
        'This Firebird tab is busy, cancelled or in a failed transaction. Roll back before continuing.',
      )
    session.busy = requestId
    session.cancelled = false
    let release!: () => void
    session.done = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = performance.now(),
      own = !session.transaction
    let transaction = session.transaction,
      statement: Statement | undefined,
      cursor: NativeResultSet | undefined,
      bytes = 0,
      count = 0,
      truncated = false,
      commitAttempted = false
    const cancel = () => {
        session.cancelled = true
        void session.attachment.cancelOperation().catch(() => {
          session.closing = true
        })
      },
      timer = setTimeout(cancel, live.profile.queryTimeout)
    sink.signal.addEventListener('abort', cancel, { once: true })
    try {
      transaction ||= await session.attachment.startTransaction({
        accessMode: live.profile.readOnly || (safety.readOnly && own) ? 'READ_ONLY' : 'READ_WRITE',
        isolation: TransactionIsolation.READ_COMMITTED,
        readCommittedMode: 'RECORD_VERSION',
        waitMode: 'NO_WAIT',
      })
      statement = await session.attachment.prepare(transaction, sql)
      const metadata = firebirdExactStatement(statement)
      await sink.onColumns(metadata.columns)
      if (session.cancelled) throw new FirebirdInputError('Firebird operation cancelled before execution.')
      const deliver = async (raw: unknown[]) => {
        const row = await firebirdRow(raw, session.attachment, transaction!, metadata.blobText),
          size = Buffer.byteLength(JSON.stringify(row))
        if (maximumRows !== undefined && (count >= maximumRows || bytes + size > 8 * 1024 * 1024)) {
          if (!safety.readOnly)
            throw new FirebirdInputError(
              'Firebird write result exceeded its reviewed buffer; transaction is not committed.',
            )
          truncated = true
          return false
        }
        await sink.onRow(row)
        bytes += size
        count++
        return true
      }
      if (statement.hasResultSet) {
        cursor = await statement.executeQuery(transaction)
        for (;;) {
          if (session.cancelled) throw new FirebirdInputError('Firebird operation cancelled.')
          const rows = await cursor.fetch({ fetchSize: 1 })
          if (!rows.length) break
          if (!(await deliver(rows[0]))) break
        }
        await cursor.close()
        cursor = undefined
      } else if (metadata.columns.length) {
        const row = await statement.executeSingleton(transaction)
        await deliver(row)
      } else await statement.execute(transaction)
      if (session.cancelled) throw new FirebirdInputError('Firebird operation cancelled before commit.')
      await statement.dispose()
      statement = undefined
      if (own) {
        if (safety.readOnly) await transaction.rollback()
        else {
          commitAttempted = true
          await transaction.commit()
        }
      }
      return { truncated, durationMs: Math.round(performance.now() - start) }
    } catch (error) {
      await cursor?.close().catch(() => {})
      cursor = undefined
      await statement?.dispose().catch(() => {})
      statement = undefined
      if (own && transaction?.isValid && !commitAttempted)
        await transaction.rollback().catch(() => {
          session.closing = true
        })
      if (!own) session.state = 'failed'
      if (commitAttempted || !session.attachment.isValid) {
        session.state = 'failed'
        session.closing = true
        live.status = { ...live.status, state: 'degraded', checkedAt: new Date().toISOString() }
      }
      throw new FirebirdInputError(
        errorText(error) +
          (commitAttempted
            ? ' Commit acknowledgement is unknown; no retry or rollback claim was made.'
            : ' No statement was automatically replayed.'),
      )
    } finally {
      clearTimeout(timer)
      sink.signal.removeEventListener('abort', cancel)
      session.busy = undefined
      release()
    }
  }
  private async read(live: Live, sql: string, limit = 5000) {
    const id = 'metadata-' + randomUUID(),
      session = await this.session(live, id),
      columns: ResultColumn[] = [],
      rows: Cell[][] = []
    try {
      const result = await this.executeSession(
        live,
        session,
        sql,
        randomUUID(),
        {
          signal: new AbortController().signal,
          onColumns: async (value) => {
            columns.push(...value)
          },
          onRow: async (value) => {
            rows.push(value)
          },
        },
        limit,
      )
      if (result.truncated) throw new FirebirdInputError('Firebird metadata exceeded its bounded view.')
      return { columns, rows }
    } finally {
      await this.closeSession({ connectionId: live.profile.id, sessionId: id })
    }
  }
  async listDatabases(id: string): Promise<string[]> {
    return [this.live(id).profile.database]
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    const result = await this.read(
      live,
      "SELECT TRIM(RDB$RELATION_NAME), CASE WHEN RDB$VIEW_BLR IS NULL THEN 'table' ELSE 'view' END FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG,0)=0 ORDER BY RDB$RELATION_NAME",
    )
    return result.rows.map((row) => ({
      database: live.profile.database,
      schema: '',
      name: String(row[0]),
      kind: row[1] === 'view' ? 'view' : 'table',
    }))
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    if (input.schema)
      throw new FirebirdInputError('Firebird 5 has no SQL schema namespace; select the unqualified table.')
    const rows = (
      await this.read(
        live,
        `SELECT TRIM(rf.RDB$FIELD_NAME), CAST(f.RDB$FIELD_TYPE AS VARCHAR(20)), CAST(f.RDB$FIELD_SUB_TYPE AS VARCHAR(20)), CAST(f.RDB$FIELD_SCALE AS VARCHAR(20)), CAST(f.RDB$FIELD_PRECISION AS VARCHAR(20)), CAST(f.RDB$CHARACTER_LENGTH AS VARCHAR(20)), CAST(rf.RDB$NULL_FLAG AS VARCHAR(20)), rf.RDB$DEFAULT_SOURCE FROM RDB$RELATION_FIELDS rf JOIN RDB$FIELDS f ON rf.RDB$FIELD_SOURCE=f.RDB$FIELD_NAME WHERE rf.RDB$RELATION_NAME=${firebirdLiteral(input.table)} ORDER BY rf.RDB$FIELD_POSITION`,
        2000,
      )
    ).rows
    if (!rows.length) throw new FirebirdInputError('Firebird table metadata is unavailable.')
    const keys = (
      await this.read(
        live,
        `SELECT TRIM(s.RDB$FIELD_NAME), CAST(s.RDB$FIELD_POSITION AS VARCHAR(20)) FROM RDB$RELATION_CONSTRAINTS c JOIN RDB$INDEX_SEGMENTS s ON c.RDB$INDEX_NAME=s.RDB$INDEX_NAME WHERE c.RDB$RELATION_NAME=${firebirdLiteral(input.table)} AND c.RDB$CONSTRAINT_TYPE='PRIMARY KEY' ORDER BY s.RDB$FIELD_POSITION`,
      )
    ).rows
    const types: Record<string, string> = {
      '7': 'SMALLINT',
      '8': 'INTEGER',
      '10': 'FLOAT',
      '12': 'DATE',
      '13': 'TIME',
      '14': 'CHAR',
      '16': 'BIGINT',
      '23': 'BOOLEAN',
      '24': 'DECFLOAT(16)',
      '25': 'DECFLOAT(34)',
      '26': 'INT128',
      '27': 'DOUBLE PRECISION',
      '28': 'TIME WITH TIME ZONE',
      '29': 'TIMESTAMP WITH TIME ZONE',
      '35': 'TIMESTAMP',
      '37': 'VARCHAR',
      '261': 'BLOB',
    }
    return {
      columns: rows.map((row) => {
        const position = keys.find((key) => key[0] === row[0])
        const native = types[String(row[1])] || `FIREBIRD_TYPE_${row[1]}`
        return {
          name: String(row[0]),
          type:
            ['1', '2'].includes(String(row[2])) && ['7', '8', '16', '26'].includes(String(row[1]))
              ? `${row[2] === '1' ? 'NUMERIC' : 'DECIMAL'}(${row[4]},${Math.abs(Number(row[3]))})`
              : ['14', '37'].includes(String(row[1]))
                ? `${native}(${row[5]})`
                : native,
          nullable: row[6] !== '1',
          primaryKey: !!position,
          ...(position ? { primaryKeyPosition: Number(position[1]) } : {}),
          defaultValue: row[7] === null ? null : String(row[7]),
        }
      }),
      indexes: [],
      constraints: [],
      foreignKeys: [],
      ddl: '-- Firebird catalog columns and primary keys; no executable DDL is inferred.',
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    const confirmation = requiredSqlConfirmation(input.sql, 'firebird', live.profile)
    if (confirmation && input.confirm !== confirmation)
      throw new FirebirdInputError('This Firebird write needs the exact target confirmation.')
    if (input.parameters?.length)
      throw new FirebirdInputError(
        'Firebird parameters are unavailable in this pinned adapter; no values were interpolated.',
      )
    const session = await this.session(live, input.sessionId),
      columns: ResultColumn[] = [],
      rows: Cell[][] = []
    const result = await this.executeSession(
      live,
      session,
      input.sql,
      input.requestId,
      {
        signal: new AbortController().signal,
        onColumns: async (value) => {
          columns.push(...value)
        },
        onRow: async (value) => {
          rows.push(value)
        },
      },
      input.maxRows,
    )
    return {
      requestId: input.requestId,
      sets: [{ columns, rows, command: 'FIREBIRD STATEMENT', affectedRows: 0, truncated: result.truncated }],
      durationMs: result.durationMs,
      transaction: session.state,
      messages: [
        'Firebird 5 native transactions. Fixed numbers and temporal values are fetched as exact server text; floating values retain native IEEE values. Affected-row counts are unavailable and not inferred. Pinned experimental wire driver.',
      ],
    }
  }
  async table(input: TableInput): Promise<QueryResult> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    if (input.filters?.conditions.length || input.filter)
      throw new FirebirdInputError(
        'Use an explicit Firebird query for filtered table views; this adapter does not advertise generated server filtering.',
      )
    const structure = await this.structure(input),
      sorts = input.sorts || (input.sort ? [{ column: input.sort, direction: input.direction }] : [])
    if (sorts.some((sort) => !structure.columns.some((column) => column.name === sort.column)))
      throw new FirebirdInputError('Invalid Firebird sort column.')
    const sql = `SELECT FIRST ${input.limit} SKIP ${input.offset} * FROM ${firebirdQuote(input.table)}${sorts.length ? ' ORDER BY ' + sorts.map((sort) => firebirdQuote(sort.column) + (sort.direction === 'asc' ? ' ASC' : ' DESC')).join(', ') : ''}`
    return this.execute({
      connectionId: input.connectionId,
      database: input.database,
      sessionId: input.sessionId,
      requestId: randomUUID(),
      sql,
      maxRows: input.limit,
      privateSession: true,
    })
  }
  async transaction(input: {
    connectionId: string
    sessionId: string
    database?: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: 'idle' | 'open' }> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    const session = await this.session(live, input.sessionId)
    if (session.busy) throw new FirebirdInputError('This Firebird tab is busy.')
    if (input.action === 'begin' && (session.transaction || session.state !== 'idle'))
      throw new FirebirdInputError('This Firebird tab already has an open or failed transaction.')
    if (input.action !== 'begin' && !session.transaction)
      throw new FirebirdInputError('This Firebird tab has no active transaction.')
    if (session.state === 'failed' && input.action !== 'rollback')
      throw new FirebirdInputError('This Firebird transaction failed; roll back before continuing.')
    session.busy = 'transaction-' + randomUUID()
    let release!: () => void
    session.done = new Promise<void>(resolve => { release = resolve })
    try {
      if (input.action === 'begin') {
        session.transaction = await session.attachment.startTransaction({
          accessMode: live.profile.readOnly ? 'READ_ONLY' : 'READ_WRITE', waitMode: 'NO_WAIT',
        })
        session.state = 'open'
        return { state: 'open' }
      }
      if (input.action === 'commit') await session.transaction!.commit()
      else await session.transaction!.rollback()
      session.transaction = undefined
      session.state = 'idle'
      return { state: 'idle' }
    } catch {
      session.state = 'failed'
      session.closing = true
      live.status = { ...live.status, state: 'degraded', checkedAt: new Date().toISOString() }
      throw new FirebirdInputError(
        'Firebird transaction acknowledgement was lost. No retry occurred; close the tab and verify the database outcome.',
      )
    } finally { session.busy = undefined; release() }
  }

  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const live = this.live(input.connectionId)
    this.target(live, input.database)
    if (input.parameters?.length || !sqlSafety(input.sql, 'firebird').readOnly)
      throw new FirebirdInputError('Firebird full export requires one read-only unparameterized query.')
    const id = 'export-' + randomUUID()
    try {
      await this.executeSession(live, await this.session(live, id), input.sql, randomUUID(), sink)
    } finally {
      await this.closeSession({ connectionId: input.connectionId, sessionId: id })
    }
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const session = this.live(input.connectionId).sessions.get(input.sessionId)
    if (!session || session.busy !== input.requestId)
      return { requested: false, message: 'This exact Firebird statement is no longer active.' }
    session.cancelled = true
    await session.attachment.cancelOperation()
    return {
      requested: true,
      message:
        'Native cancellation requested. Completion is determined by the running operation; completed commits cannot be reversed.',
    }
  }
  getSessionState(input: { connectionId: string; sessionId: string }) {
    const live = this.connections.get(input.connectionId),
      session = live?.sessions.get(input.sessionId)
    return {
      state: session?.state || 'idle',
      connected: !!live && !live.closing && !session?.closing,
      running: !!session?.busy,
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connections.get(input.connectionId)
    if (!live) return
    await live.creating.get(input.sessionId)?.catch(() => {})
    const session = live.sessions.get(input.sessionId)
    if (!session) return
    session.closing = true
    if (session.busy) {
      session.cancelled = true
      await session.attachment.cancelOperation().catch(() => {})
      await session.done
    }
    await session.transaction?.rollback().catch(() => {})
    await session.attachment.disconnect().catch(() => {})
    await session.client.dispose().catch(() => {})
    live.sessions.delete(input.sessionId)
  }
  async disconnect(id: string): Promise<void> {
    const live = this.connections.get(id)
    if (live) {
      live.closing = true
      await Promise.allSettled(live.creating.values())
      await Promise.allSettled(
        [...live.sessions.keys()].map((sessionId) => this.closeSession({ connectionId: id, sessionId })),
      )
      await live.transport.close()
      live.secrets = {}
      this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
