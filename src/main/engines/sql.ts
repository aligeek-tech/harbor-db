import pg, { type Client as PgClient, type QueryResult as PgResult, type QueryArrayConfig } from 'pg'
import mariadb, { type Connection as MariaConnection } from 'mariadb'
import type { EventEmitter } from 'node:events'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  EditsInput,
  ObjectInfo,
  QueryInput,
  QueryResult,
  ResultSet,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import { qualifiedName, quoteIdentifier, requiredSqlConfirmation, sqlSafety } from '../../shared/sql'
import { buildTableQuery } from '../../shared/table-query'
import { openTransport } from './transport'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS = 32
const MAX_RESULT_SETS = 100
const PG_TYPES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  700: 'real',
  701: 'double precision',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp (no time zone)',
  1184: 'timestamp with time zone',
  1186: 'interval',
  1700: 'numeric',
  114: 'json',
  3802: 'jsonb',
  2950: 'uuid',
}
type Tx = 'idle' | 'open' | 'failed'
interface Session {
  database: string
  pg?: PgClient
  maria?: MariaConnection
  backendId: number
  transaction: Tx
  busy?: string
  cancelRequested: boolean
  dead: boolean
  messages: string[]
}
interface LiveConnection {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Awaited<ReturnType<typeof openTransport>>
  sessions: Map<string, Session>
  creating: Map<string, Promise<Session>>
  databases: Map<string, string>
  bootstrapDatabase: string
  status: ConnectionStatus
  closed: boolean
}

export function losslessCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return { type: 'binary', base64: value.toString('base64') }
  if (value instanceof Uint8Array) return { type: 'binary', base64: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  throw new Error('Unexpected structured driver value: refusing a potentially lossy conversion.')
}
function parameter(cell: Cell): unknown {
  return cell !== null && typeof cell === 'object' ? Buffer.from(cell.base64, 'base64') : cell
}
function emptySet(command = ''): ResultSet {
  return { columns: [], rows: [], affectedRows: 0, command, truncated: false }
}
function records(set: ResultSet): Record<string, Cell>[] {
  return set.rows.map((row) => Object.fromEntries(set.columns.map((col, i) => [col.name, row[i]])))
}
function text(value: Cell | undefined): string {
  return value == null ? '' : String(value)
}
function assertTabSession(id: string): void {
  if (id.startsWith('_')) throw new Error('Session identifiers beginning with an underscore are reserved.')
}
function errorCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
}
function readableError(error: unknown, secrets?: Secrets): Error {
  let message = error instanceof Error ? error.message : 'Database operation failed.'
  // MariaDB errors append SQL text and parameters; do not return those in an error envelope.
  message = message.split(/\n(?:sql:|parameters:)/i)[0]
  for (const secret of Object.values(secrets ?? {}))
    if (secret) message = message.replaceAll(secret, '[redacted]')
  const code = errorCode(error)
  if (
    [
      'ECONNRESET',
      'EPIPE',
      'PROTOCOL_CONNECTION_LOST',
      'ER_CMD_CONNECTION_CLOSED',
      '57P01',
      '08006',
    ].includes(code)
  )
    message +=
      ' Connection lost. The last write may have reached the server; inspect its outcome before retrying.'
  if (typeof error === 'object' && error && 'position' in error && /^[1-9]\d*$/.test(String(error.position)))
    message += ` (SQL character ${String(error.position)})`
  return Object.assign(new Error(message), { code })
}

/** One physical SQL session per tab, never a pooled transaction. No statement is retried. */
export class SqlService {
  private live = new Map<string, LiveConnection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()

  async connect(profile: ConnectionProfile, secrets: Secrets): Promise<ConnectionStatus> {
    if (profile.engine === 'redis') throw new Error('Use the Redis adapter for Redis connections.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let connection: LiveConnection | undefined
    try {
      const transport = await openTransport(profile, secrets)
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      connection = {
        profile: { ...profile },
        secrets: { ...secrets },
        transport,
        sessions: new Map(),
        creating: new Map(),
        databases: new Map(),
        bootstrapDatabase: profile.database || (profile.engine === 'postgres' ? 'postgres' : ''),
        status: { state: 'connecting' },
        closed: false,
      }
      this.live.set(profile.id, connection)
      let session: Session
      if (profile.engine === 'postgres' && !profile.database) {
        const candidates = [...new Set(['postgres', profile.username, 'template1'].filter(Boolean))]
        let connected: Session | undefined
        for (let index = 0; index < candidates.length; index++) {
          try {
            connected = await this.session(connection, '_metadata', candidates[index])
            connection.bootstrapDatabase = candidates[index]
            break
          } catch (error) {
            const code = errorCode(error)
            const databaseUnavailable =
              code === '3D000' ||
              (code === '42501' &&
                /permission denied for database|CONNECT privilege/i.test(
                  error instanceof Error ? error.message : '',
                ))
            if (!databaseUnavailable || index === candidates.length - 1) throw error
          }
        }
        if (!connected) throw new Error('No accessible PostgreSQL maintenance database was found.')
        session = connected
      } else session = await this.session(connection, '_metadata', connection.bootstrapDatabase)
      const result = await this.raw(session, profile.engine, 'SELECT version() AS version', [], 1)
      if (connection.closed || this.generations.get(profile.id) !== generation)
        return { state: 'disconnected' }
      connection.status = {
        state: 'connected',
        version: text(result[0]?.rows[0]?.[0]),
        durationMs: Math.round(performance.now() - started),
        transport: profile.ssh.enabled ? 'SSH tunnel' : profile.tls.enabled ? 'TLS' : 'TCP',
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      if (connection && this.live.get(profile.id) === connection) await this.disconnect(profile.id)
      const state: ConnectionStatus = {
        state: 'failed',
        durationMs: Math.round(performance.now() - started),
        error: readableError(error, secrets).message,
      }
      this.states.set(profile.id, state)
      return state
    }
  }

  status(id: string): ConnectionStatus {
    return this.live.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }

  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: Tx
    connected: boolean
    running: boolean
  } {
    assertTabSession(input.sessionId)
    const connection = this.live.get(input.connectionId)
    if (!connection || connection.closed) return { state: 'idle', connected: false, running: false }
    const session = connection.sessions.get(input.sessionId)
    if (!session)
      return {
        state: 'idle',
        connected: connection.status.state === 'connected',
        running: connection.creating.has(input.sessionId),
      }
    if (session.dead) return { state: 'idle', connected: false, running: false }
    const state = session.pg?.getTransactionStatus()
    const transaction = session.pg
      ? state === 'T'
        ? 'open'
        : state === 'E'
          ? 'failed'
          : 'idle'
      : (session.maria?.info?.status ?? 0) & 1
        ? 'open'
        : 'idle'
    session.transaction = transaction
    return { state: transaction, connected: true, running: !!session.busy }
  }

  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const connection = this.live.get(id)
    this.live.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    connection.closed = true
    await Promise.allSettled([...connection.creating.values()])
    await Promise.allSettled([...connection.sessions.values()].map((session) => this.end(session)))
    connection.sessions.clear()
    connection.databases.clear()
    connection.secrets = {}
    await connection.transport.close()
  }

  private connection(id: string): LiveConnection {
    const connection = this.live.get(id)
    if (!connection || connection.closed)
      throw new Error('Connection is disconnected. Connect before running this operation.')
    return connection
  }

  private database(connection: LiveConnection, requested?: string, sessionId?: string): string {
    const { profile } = connection
    if (profile.engine !== 'postgres') return profile.database
    const bound = sessionId ? connection.databases.get(sessionId) : undefined
    if (profile.database && requested && requested !== profile.database)
      throw new Error(
        'This connection is configured for a different PostgreSQL database. Open a separate connection context.',
      )
    if (bound && requested && requested !== bound)
      throw new Error(
        `This tab is already bound to PostgreSQL database "${bound}". Open a new tab for another database.`,
      )
    const database = bound || requested || profile.database
    if (!database)
      throw new Error('Choose a PostgreSQL database before opening objects or running a new query tab.')
    if (database.includes('\0')) throw new Error('A PostgreSQL database name cannot contain NUL.')
    return database
  }

  private async createSession(connection: LiveConnection, database: string): Promise<Session> {
    const { profile, transport, secrets } = connection
    const session: Session = {
      database,
      backendId: 0,
      transaction: 'idle',
      cancelRequested: false,
      dead: false,
      messages: [],
    }
    try {
      if (profile.engine === 'postgres') {
        const client = new pg.Client({
          host: transport.host,
          port: transport.port,
          user: profile.username || undefined,
          password: secrets.password,
          database,
          ssl: transport.tls ?? false,
          connectionTimeoutMillis: profile.connectTimeout,
          application_name: 'Harbor DB',
          types: {
            getTypeParser: (oid: number) =>
              oid === 17 ? pg.types.getTypeParser(17, 'text') : (value: string) => value,
          },
        })
        session.pg = client
        client.on('error', () => {
          session.dead = true
          if (connection.sessions.get('_metadata') === session) {
            connection.status = {
              state: 'failed',
              error: 'Database connection was lost. Reconnect to continue.',
            }
            this.states.set(profile.id, connection.status)
          }
        })
        client.on('end', () => {
          session.dead = true
        })
        client.on('notice', (notice) => {
          if (session.messages.length < 100)
            session.messages.push(readableError(notice, secrets).message.slice(0, 10000))
        })
        await client.connect()
        const settings = await client.query({
          text: "SELECT pg_backend_pid() AS pid, set_config('statement_timeout', $1, false), set_config('TimeZone','UTC',false), set_config('application_name','Harbor DB',false), set_config('standard_conforming_strings','on',false)",
          values: [String(profile.queryTimeout)],
        })
        session.backendId = Number(settings.rows[0].pid)
        if (profile.schema)
          await client.query({
            text: "SELECT set_config('search_path', $1, false)",
            values: [quoteIdentifier(profile.schema, 'postgres') + ', public'],
          })
        if (profile.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
        // ReadyForQuery is the authoritative PostgreSQL transaction state, including raw SQL BEGIN/ROLLBACK.
        const wire = (
          client as unknown as {
            connection: { on: (event: string, callback: (message: { status: string }) => void) => void }
          }
        ).connection
        wire.on('readyForQuery', (message) => {
          session.transaction = message.status === 'T' ? 'open' : message.status === 'E' ? 'failed' : 'idle'
        })
      } else {
        const client = await mariadb.createConnection({
          host: transport.host,
          port: transport.port,
          user: profile.username || undefined,
          password: secrets.password,
          database: profile.database || undefined,
          ssl: transport.tls,
          connectTimeout: profile.connectTimeout,
          queryTimeout: profile.queryTimeout,
          rowsAsArray: true,
          dateStrings: true,
          autoJsonMap: false,
          bigIntAsNumber: false,
          decimalAsNumber: false,
          multipleStatements: true,
          permitLocalInfile: false,
          timezone: '+00:00',
          trace: false,
          logParam: false,
        })
        session.maria = client
        if (client.threadId === null) throw new Error('MariaDB did not provide a session identifier.')
        session.backendId = client.threadId
        client.on('error', () => {
          session.dead = true
          if (connection.sessions.get('_metadata') === session)
            connection.status = {
              state: 'failed',
              error: 'Database connection was lost. Reconnect to continue.',
            }
        })
        await client.query("SET time_zone = '+00:00'")
        await client.query(`SET SESSION max_statement_time = ${profile.queryTimeout / 1000}`)
        if (profile.readOnly) await client.query('SET SESSION TRANSACTION READ ONLY')
      }
      if (connection.closed) {
        await this.end(session)
        throw new Error('Connection closed while creating a session.')
      }
      return session
    } catch (error) {
      await this.end(session)
      throw readableError(error, secrets)
    }
  }

  private async session(
    connection: LiveConnection,
    id: string,
    requestedDatabase?: string,
  ): Promise<Session> {
    const database = this.database(connection, requestedDatabase, id)
    const existing = connection.sessions.get(id)
    if (existing) {
      if (existing.dead)
        throw new Error(
          'This tab’s database session ended. Reconnect before retrying; open transactions were not restored.',
        )
      return existing
    }
    const pending = connection.creating.get(id)
    if (pending) return pending
    if (connection.sessions.size + connection.creating.size >= MAX_SESSIONS)
      throw new Error(
        'Connection has 32 open sessions. Close unused tabs or reconnect to release database metadata sessions.',
      )
    connection.databases.set(id, database)
    const created = this.createSession(connection, database)
      .then((session) => {
        connection.sessions.set(id, session)
        return session
      })
      .finally(() => {
        connection.creating.delete(id)
        if (!connection.sessions.has(id)) connection.databases.delete(id)
      })
    connection.creating.set(id, created)
    return created
  }

  private async end(session: Session): Promise<void> {
    session.dead = true
    // Closing a physical session rolls back its active transaction. A running query is terminated.
    if (session.maria) {
      session.maria.destroy()
      return
    }
    if (session.pg) await session.pg.end().catch(() => undefined)
  }

  private claim(session: Session, requestId: string): void {
    if (session.busy) throw new Error('This tab already has an operation running. Wait or cancel it first.')
    session.busy = requestId
    session.cancelRequested = false
    session.messages = []
  }

  private async raw(
    session: Session,
    engine: ConnectionProfile['engine'],
    sql: string,
    values: unknown[] = [],
    maxRows = 1000,
  ): Promise<ResultSet[]> {
    let bytes = 0
    let rowCount = 0
    const append = (set: ResultSet, row: unknown[]) => {
      if (set.rows.length >= maxRows || bytes >= MAX_BYTES || rowCount >= maxRows) {
        set.truncated = true
        return
      }
      const cells = row.map(losslessCell)
      const size = Buffer.byteLength(JSON.stringify(cells), 'utf8')
      if (bytes + size > MAX_BYTES) {
        set.truncated = true
        bytes = MAX_BYTES
        return
      }
      bytes += size
      rowCount++
      set.rows.push(cells)
    }
    if (engine === 'postgres') {
      return new Promise((resolve, reject) => {
        const saved = new Map<PgResult, ResultSet>()
        let conversionError: unknown
        const get = (result: PgResult): ResultSet => {
          let set = saved.get(result)
          if (!set) {
            set = emptySet()
            saved.set(result, set)
          }
          if (!set.columns.length)
            set.columns = result.fields.map((field) => ({
              name: field.name,
              type: PG_TYPES[field.dataTypeID] ?? `oid:${field.dataTypeID}`,
            }))
          return set
        }
        const config: QueryArrayConfig = {
          text: sql,
          values: values.length ? values : undefined,
          rowMode: 'array',
        }
        const query = new pg.Query(config)
        query.on('row', (row: unknown[], result?: PgResult) => {
          try {
            if (result && !conversionError && (saved.has(result) || saved.size < MAX_RESULT_SETS))
              append(get(result), row)
          } catch (error) {
            conversionError = error
          }
        })
        query.on('error', (error: Error & { severity?: string }) => {
          // PostgreSQL sends ErrorResponse before ReadyForQuery. Wait for the latter
          // before reporting an error so Commit cannot race the failed-transaction state.
          if (error.severity !== 'ERROR' || session.dead) {
            reject(error)
            return
          }
          const wire = (session.pg as unknown as { connection: EventEmitter }).connection
          const finish = () => {
            wire.off('readyForQuery', finish)
            session.pg!.off('end', finish)
            session.pg!.off('error', finish)
            const status = session.pg!.getTransactionStatus()
            session.transaction = status === 'T' ? 'open' : status === 'E' ? 'failed' : 'idle'
            reject(error)
          }
          wire.once('readyForQuery', finish)
          session.pg!.once('end', finish)
          session.pg!.once('error', finish)
        })
        query.on('end', (result: PgResult | PgResult[]) => {
          if (conversionError) {
            reject(conversionError)
            return
          }
          const results = Array.isArray(result) ? result : [result]
          if (results.length > MAX_RESULT_SETS)
            session.messages.push(
              'Only the first 100 result sets are displayed; the complete script was executed.',
            )
          resolve(
            results.slice(0, MAX_RESULT_SETS).map((result) => {
              const set = get(result)
              set.command = result.command
              set.affectedRows = result.rowCount ?? 0
              return set
            }),
          )
        })
        session.pg!.query(query)
      })
    }
    return new Promise((resolve, reject) => {
      const sets: ResultSet[] = []
      let current: ResultSet | undefined
      let resultCount = 0
      let conversionError: unknown
      const stream = session.maria!.queryStream({ sql, rowsAsArray: true }, values)
      stream.on('fields', (fields: { name: () => string; type: string; flags: number }[]) => {
        resultCount++
        if (resultCount > MAX_RESULT_SETS) {
          current = undefined
          return
        }
        current = emptySet(sql.trim().split(/\s+/)[0].toUpperCase())
        current.columns = fields.map((field) => ({
          name: field.name(),
          type: field.type,
          nullable: !(field.flags & 1),
        }))
        sets.push(current)
      })
      stream.on('data', (row: unknown[] | { affectedRows?: number; warningStatus?: number }) => {
        try {
          if (Array.isArray(row)) {
            if (current && !conversionError) {
              current.affectedRows++
              append(current, row)
            }
          } else {
            resultCount++
            if (resultCount <= MAX_RESULT_SETS) {
              const set = emptySet(sql.trim().split(/\s+/)[0].toUpperCase())
              set.affectedRows = Number(row.affectedRows ?? 0)
              sets.push(set)
            }
            current = undefined
            if (row.warningStatus && session.messages.length < 100)
              session.messages.push(
                `${row.warningStatus} server warning(s). Run SHOW WARNINGS in this tab for details.`,
              )
          }
        } catch (error) {
          conversionError = error
        }
      })
      stream.on('error', reject)
      stream.on('end', () => {
        if (conversionError) {
          reject(conversionError)
          return
        }
        if (resultCount > MAX_RESULT_SETS)
          session.messages.push(
            'Only the first 100 result sets are displayed; the complete script was executed.',
          )
        resolve(sets.length ? sets : [emptySet(sql.trim().split(/\s+/)[0].toUpperCase())])
      })
    })
  }

  private async syncTransaction(session: Session): Promise<void> {
    if (session.pg && !session.dead) {
      const status = session.pg.getTransactionStatus()
      session.transaction = status === 'T' ? 'open' : status === 'E' ? 'failed' : 'idle'
    }
    if (session.maria && !session.dead) {
      // The connector exposes the server's last protocol status; an extra SQL query here
      // would destroy ROW_COUNT()/warning diagnostics belonging to the user's statement.
      session.transaction = (session.maria.info?.status ?? 0) & 1 ? 'open' : 'idle'
    }
  }

  async execute(input: QueryInput): Promise<QueryResult> {
    return this.executeSql(input, [])
  }

  private async executeSql(input: QueryInput, values: unknown[]): Promise<QueryResult> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const safety = sqlSafety(input.sql, profile.engine as 'postgres' | 'mariadb')
    if (safety.statementCount > 100)
      throw new Error('A script can contain at most 100 statements. Run smaller sections explicitly.')
    assertTabSession(input.sessionId)
    if (profile.readOnly && (!safety.readOnly || safety.controlsTransaction))
      throw new Error(
        'This connection is read-only. Only read statements are allowed; use transaction controls for Begin / Commit / Rollback.',
      )
    const confirmation = requiredSqlConfirmation(input.sql, profile.engine as 'postgres' | 'mariadb', profile)
    if (!profile.readOnly && confirmation && input.confirm !== confirmation)
      throw new Error(
        `Type "${confirmation}" to confirm this ${safety.destructive ? 'destructive' : 'production write'} operation on ${profile.name}.`,
      )
    if (profile.engine === 'mariadb' && /^\s*DELIMITER\b/im.test(input.sql))
      throw new Error(
        'DELIMITER is a command-line client directive. Select the complete routine without DELIMITER lines.',
      )
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, input.requestId)
    const started = performance.now()
    let readonlyWrapper = false
    try {
      if (profile.readOnly && session.transaction === 'idle') {
        await this.raw(
          session,
          profile.engine,
          profile.engine === 'postgres' ? 'BEGIN READ ONLY' : 'START TRANSACTION READ ONLY',
        )
        readonlyWrapper = true
        if (session.pg) await this.raw(session, profile.engine, 'SELECT 1') // pin the snapshot; prevent changing transaction access mode
      }
      const sets = await this.raw(session, profile.engine, input.sql, values, input.maxRows)
      if (readonlyWrapper) await this.raw(session, profile.engine, 'COMMIT')
      await this.syncTransaction(session)
      const messages = [...session.messages]
      if (sets.some((set) => set.truncated))
        messages.push(
          `Display capped at ${input.maxRows.toLocaleString()} rows or 8 MiB. The original SQL ran unchanged; remaining result rows were drained without retention.`,
        )
      if (profile.engine === 'mariadb')
        messages.push(
          'MariaDB DDL can implicitly commit; transaction state reflects the server. Nontransactional storage engines cannot roll back writes.',
        )
      return {
        requestId: input.requestId,
        sets,
        durationMs: Math.round(performance.now() - started),
        messages,
        transaction: session.transaction,
      }
    } catch (error) {
      if (readonlyWrapper) await this.raw(session, profile.engine, 'ROLLBACK').catch(() => undefined)
      await this.syncTransaction(session).catch(() => undefined)
      const code = errorCode(error)
      if (
        session.cancelRequested &&
        ['57014', 'ER_QUERY_INTERRUPTED', 'ER_STATEMENT_TIMEOUT', 'ER_QUERY_TIMEOUT'].includes(code)
      ) {
        return {
          requestId: input.requestId,
          sets: [],
          durationMs: Math.round(performance.now() - started),
          messages: [
            'The server confirmed query cancellation. Earlier script statements may already have committed.',
          ],
          transaction: session.transaction,
          cancelled: true,
        }
      }
      const normalized = readableError(error, connection.secrets)
      if (session.transaction === 'failed')
        normalized.message += ' Transaction is failed; roll it back before continuing.'
      throw normalized
    } finally {
      session.busy = undefined
    }
  }

  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<{ requested: boolean; message: string }> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const session = connection.sessions.get(input.sessionId)
    if (!session || session.busy !== input.requestId || session.dead)
      return { requested: false, message: 'This request is no longer running.' }
    // Use a separate control socket; never queue cancellation behind the query it must cancel.
    const control = await this.createSession(connection, session.database)
    try {
      if (session.busy !== input.requestId)
        return { requested: false, message: 'The request completed before cancellation could be sent.' }
      session.cancelRequested = true
      if (connection.profile.engine === 'postgres') {
        const result = await this.raw(
          control,
          'postgres',
          'SELECT pg_cancel_backend($1) AS requested',
          [session.backendId],
          1,
        )
        const requested = ['true', 't'].includes(String(result[0].rows[0]?.[0]))
        return {
          requested,
          message: requested
            ? 'Cancellation requested. Waiting for the query server outcome.'
            : 'The server no longer has that query running.',
        }
      }
      await this.raw(control, 'mariadb', `KILL QUERY ${session.backendId}`)
      return { requested: true, message: 'Cancellation requested. Waiting for the query server outcome.' }
    } catch (error) {
      session.cancelRequested = false
      throw readableError(error, connection.secrets)
    } finally {
      await this.end(control)
    }
  }

  async transaction(input: {
    connectionId: string
    sessionId: string
    action: 'begin' | 'commit' | 'rollback'
    database?: string
  }): Promise<{ state: Tx }> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, `transaction:${input.action}`)
    try {
      if (input.action === 'begin' && session.transaction !== 'idle')
        throw new Error('This tab already has an open transaction.')
      if (input.action === 'commit' && session.transaction === 'failed')
        throw new Error('The transaction failed. Rollback is required.')
      const sql =
        input.action === 'begin'
          ? (connection.profile.engine === 'postgres' ? 'BEGIN' : 'START TRANSACTION') +
            (connection.profile.readOnly ? ' READ ONLY' : '')
          : input.action.toUpperCase()
      await this.raw(session, connection.profile.engine, sql)
      if (input.action === 'begin' && connection.profile.readOnly && session.pg)
        await this.raw(session, 'postgres', 'SELECT 1')
      await this.syncTransaction(session)
      return { state: session.transaction }
    } catch (error) {
      throw readableError(error, connection.secrets)
    } finally {
      session.busy = undefined
    }
  }

  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    assertTabSession(input.sessionId)
    const connection = this.live.get(input.connectionId)
    if (!connection) return
    const session =
      connection.sessions.get(input.sessionId) ?? (await connection.creating.get(input.sessionId))
    connection.sessions.delete(input.sessionId)
    connection.databases.delete(input.sessionId)
    if (session) await this.end(session)
  }

  private async metadata(
    connectionId: string,
    sql: string,
    values: unknown[] = [],
    database?: string,
  ): Promise<Record<string, Cell>[]> {
    const connection = this.connection(connectionId)
    const target =
      connection.profile.engine === 'postgres' ? database || connection.bootstrapDatabase : undefined
    const key = target && target !== connection.bootstrapDatabase ? `_metadata:${target}` : '_metadata'
    const session = await this.session(connection, key, target)
    // Metadata reads may queue on their dedicated session; never share a tab's transaction.
    const sets = await this.raw(session, connection.profile.engine, sql, values, 10000)
    if (sets.some((set) => set.truncated))
      throw new Error('Metadata exceeds the 10,000 row / 8 MiB limit. Narrow the schema before refreshing.')
    return records(sets[0])
  }

  async listDatabases(id: string): Promise<string[]> {
    const postgres = this.connection(id).profile.engine === 'postgres'
    const rows = await this.metadata(
      id,
      postgres
        ? "SELECT datname AS name FROM pg_database WHERE datallowconn AND has_database_privilege(datname,'CONNECT') ORDER BY datname"
        : 'SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name',
    )
    return rows.map((row) => text(row.name))
  }

  async listObjects(input: {
    connectionId: string
    schema?: string
    database?: string
  }): Promise<ObjectInfo[]> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (profile.engine === 'postgres') {
      const database = this.database(connection, input.database)
      // Consult stable Timescale views only when the installed extension owns them and
      // the caller can read them. Ordinary PostgreSQL must not parse missing relations.
      const timescaleViews = await this.metadata(
        input.connectionId,
        `SELECT c.relname AS name
         FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass
           AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_class'::regclass
         JOIN pg_catalog.pg_class c ON c.oid=d.objid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE e.extname='timescaledb' AND n.nspname='timescaledb_information'
           AND c.relname IN ('chunks','continuous_aggregates')
           AND pg_catalog.has_schema_privilege(n.oid,'USAGE')
           AND pg_catalog.has_table_privilege(c.oid,'SELECT')`,
        [],
        database,
      )
      const available = new Set(timescaleViews.map((row) => text(row.name)))
      const timescaleRelations = [
        available.has('chunks')
          ? `AND NOT EXISTS (SELECT 1 FROM timescaledb_information.chunks chunk
              WHERE chunk.chunk_schema=n.nspname AND chunk.chunk_name=c.relname)`
          : '',
        available.has('continuous_aggregates')
          ? `AND NOT EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates aggregate
              WHERE aggregate.materialization_hypertable_schema=n.nspname
                AND aggregate.materialization_hypertable_name=c.relname)`
          : '',
      ].join('\n')
      const rows = await this.metadata(
        input.connectionId,
        `WITH extension_members AS (
           SELECT d.classid,d.objid,e.extname
           FROM pg_catalog.pg_depend d
           JOIN pg_catalog.pg_extension e ON d.refclassid='pg_catalog.pg_extension'::regclass
             AND d.refobjid=e.oid
           WHERE d.deptype='e' AND d.objsubid=0
         ), user_schemas AS (
           SELECT n.oid,n.nspname FROM pg_catalog.pg_namespace n
           WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
             AND ($1::text IS NULL OR n.nspname=$1)
             AND NOT EXISTS (SELECT 1 FROM extension_members member
               WHERE member.classid='pg_catalog.pg_namespace'::regclass
                 AND member.objid=n.oid AND member.extname='timescaledb')
         )
         SELECT n.nspname AS schema,c.relname AS name,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
             WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
           c.reltuples::bigint::text AS estimate
         FROM pg_catalog.pg_class c JOIN user_schemas n ON n.oid=c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','S','f')
           AND NOT EXISTS (SELECT 1 FROM extension_members member
             WHERE member.classid='pg_catalog.pg_class'::regclass AND member.objid=c.oid
               AND member.extname='timescaledb')
           ${timescaleRelations}
         UNION ALL
         SELECT n.nspname,p.proname,'function',NULL
         FROM pg_catalog.pg_proc p JOIN user_schemas n ON n.oid=p.pronamespace
         WHERE NOT EXISTS (SELECT 1 FROM extension_members member
           WHERE member.classid='pg_catalog.pg_proc'::regclass AND member.objid=p.oid)
         ORDER BY schema,name`,
        [input.schema || null],
        database,
      )
      return rows.map((row) => ({
        name: text(row.name),
        schema: text(row.schema),
        database,
        kind: text(row.kind) as ObjectInfo['kind'],
        estimatedRows: row.estimate == null ? undefined : text(row.estimate),
      }))
    }
    const schema = input.schema || profile.database
    if (!schema)
      throw new Error(
        'Choose a database in the sidebar to browse its objects, or set a default database in this connection.',
      )
    const rows = await this.metadata(
      input.connectionId,
      `SELECT table_schema AS schema_name,table_name AS name,CASE WHEN table_type='VIEW' THEN 'view' ELSE 'table' END AS kind,table_rows AS estimate FROM information_schema.tables WHERE table_schema = ? UNION ALL SELECT routine_schema,routine_name,'function',NULL FROM information_schema.routines WHERE routine_schema=? UNION ALL SELECT trigger_schema,trigger_name,'trigger',NULL FROM information_schema.triggers WHERE trigger_schema=? ORDER BY schema_name,name`,
      [schema, schema, schema],
    )
    return rows.map((row) => ({
      name: text(row.name),
      schema: text(row.schema_name),
      kind: text(row.kind) as ObjectInfo['kind'],
      estimatedRows: row.estimate == null ? undefined : text(row.estimate),
    }))
  }

  async structure(input: {
    connectionId: string
    schema: string
    table: string
    database?: string
  }): Promise<TableStructure> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const dialect = profile.engine as 'postgres' | 'mariadb'
    const database = dialect === 'postgres' ? this.database(connection, input.database) : undefined
    const schema = input.schema || (dialect === 'postgres' ? 'public' : profile.database)
    if (dialect === 'postgres') {
      const name = qualifiedName(schema, input.table, dialect)
      const columns = await this.metadata(
        input.connectionId,
        `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS default_value,EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS primary_key FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [name],
        database,
      )
      const indexes = await this.metadata(
        input.connectionId,
        'SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname',
        [schema, input.table],
        database,
      )
      const constraints = await this.metadata(
        input.connectionId,
        'SELECT conname AS name,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname',
        [name],
        database,
      )
      const result: TableStructure = {
        columns: columns.map((row) => ({
          name: text(row.name),
          type: text(row.type),
          nullable: ['t', 'true'].includes(text(row.nullable)),
          defaultValue: row.default_value === null ? null : text(row.default_value),
          primaryKey: ['t', 'true'].includes(text(row.primary_key)),
        })),
        indexes: indexes.map((row) => ({ name: text(row.name), definition: text(row.definition) })),
        constraints: constraints.map((row) => ({ name: text(row.name), definition: text(row.definition) })),
        ddl: '',
      }
      result.ddl = `-- Structural summary; use pg_dump for authoritative DDL including ownership, policies, and dependencies.\nCREATE TABLE ${name} (\n${[...result.columns.map((col) => `  ${quoteIdentifier(col.name, dialect)} ${col.type}${col.nullable ? '' : ' NOT NULL'}${col.defaultValue === null ? '' : ` DEFAULT ${col.defaultValue}`}`), ...result.constraints.map((item) => `  CONSTRAINT ${quoteIdentifier(item.name, dialect)} ${item.definition}`)].join(',\n')}\n);`
      return result
    }
    const columns = await this.metadata(
      input.connectionId,
      `SELECT column_name AS name,column_type AS type,is_nullable AS nullable,column_default AS default_value,column_key AS key_type FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
      [schema, input.table],
    )
    const indexes = await this.metadata(
      input.connectionId,
      `SELECT index_name AS name,GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS definition FROM information_schema.statistics WHERE table_schema=? AND table_name=? GROUP BY index_name ORDER BY index_name`,
      [schema, input.table],
    )
    const constraints = await this.metadata(
      input.connectionId,
      `SELECT c.constraint_name AS name,CONCAT(c.constraint_type,': ',COALESCE(GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ', '),''),COALESCE(CONCAT(' → ',MAX(k.referenced_table_name)) ,'')) AS definition FROM information_schema.table_constraints c LEFT JOIN information_schema.key_column_usage k ON c.constraint_schema=k.constraint_schema AND c.table_name=k.table_name AND c.constraint_name=k.constraint_name WHERE c.table_schema=? AND c.table_name=? GROUP BY c.constraint_name,c.constraint_type`,
      [schema, input.table],
    )
    const ddlRows = await this.metadata(
      input.connectionId,
      `SHOW CREATE TABLE ${qualifiedName(schema, input.table, dialect)}`,
    )
    return {
      columns: columns.map((row) => ({
        name: text(row.name),
        type: text(row.type),
        nullable: text(row.nullable) === 'YES',
        defaultValue: row.default_value === null ? null : text(row.default_value),
        primaryKey: text(row.key_type) === 'PRI',
      })),
      indexes: indexes.map((row) => ({ name: text(row.name), definition: text(row.definition) })),
      constraints: constraints.map((row) => ({ name: text(row.name), definition: text(row.definition) })),
      ddl: text(Object.values(ddlRows[0] ?? {})[1]),
    }
  }

  async table(input: TableInput): Promise<QueryResult> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const dialect = profile.engine as 'postgres' | 'mariadb'
    const database =
      dialect === 'postgres' ? this.database(connection, input.database, input.sessionId) : undefined
    const structure = await this.structure({ ...input, database })
    const keys = structure.columns.filter((col) => col.primaryKey).map((col) => col.name)
    const tableQuery = buildTableQuery(
      { ...input, schema: input.schema || (dialect === 'postgres' ? 'public' : profile.database) },
      structure,
      dialect,
    )
    const result = await this.executeSql(
      {
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        database,
        requestId: `table:${crypto.randomUUID()}`,
        sql: tableQuery.sql,
        maxRows: input.limit,
        privateSession: false,
      },
      tableQuery.parameters,
    )
    result.tableQuery = tableQuery
    for (const set of result.sets)
      set.columns = set.columns.map((col) => ({ ...col, key: keys.includes(col.name) }))
    if (!keys.length)
      result.messages.push('No primary key: rows are read-only and pagination order may change.')
    else
      result.messages.push(
        'Offset pagination uses primary-key tie breakers. Concurrent inserts and deletes can move page boundaries.',
      )
    return result
  }

  async applyEdits(input: EditsInput): Promise<{ affectedRows: number }> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (profile.readOnly) throw new Error('This connection is read-only.')
    const dialect = profile.engine as 'postgres' | 'mariadb'
    const database =
      dialect === 'postgres' ? this.database(connection, input.database, input.sessionId) : undefined
    const structure = await this.structure({ ...input, database })
    const keys = structure.columns.filter((col) => col.primaryKey).map((col) => col.name)
    if (!keys.length)
      throw new Error('Editing requires a declared primary key. This table has no reliable row identity.')
    const schema = input.schema || (dialect === 'postgres' ? 'public' : profile.database)
    if (dialect === 'mariadb') {
      const engine = await this.metadata(
        input.connectionId,
        'SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',
        [schema, input.table],
      )
      if (!['INNODB', 'XTRADB'].includes(text(engine[0]?.engine).toUpperCase()))
        throw new Error(
          'Safe transactional editing requires an InnoDB table. This object uses another engine or is a view.',
        )
    } else {
      const kind = await this.metadata(
        input.connectionId,
        'SELECT relkind FROM pg_class WHERE oid=$1::regclass',
        [qualifiedName(schema, input.table, dialect)],
        database,
      )
      if (!['r', 'p'].includes(text(kind[0]?.relkind)))
        throw new Error('Only base tables support reviewed row editing.')
    }
    const session = await this.session(connection, input.sessionId, database)
    this.claim(session, 'apply-edits')
    if (session.transaction !== 'idle') {
      session.busy = undefined
      throw new Error('Commit or roll back the tab’s open transaction before applying staged edits.')
    }
    let affectedRows = 0
    try {
      await this.raw(session, profile.engine, dialect === 'postgres' ? 'BEGIN' : 'START TRANSACTION')
      const allowed = new Set(structure.columns.map((col) => col.name))
      for (const change of input.changes) {
        const values: unknown[] = []
        const bind = (cell: Cell) => {
          values.push(parameter(cell))
          return dialect === 'postgres' ? `$${values.length}` : '?'
        }
        const entries = Object.entries(change.values)
        if (entries.some(([name]) => !allowed.has(name)))
          throw new Error('A changed column no longer exists. Refresh table structure.')
        const table = qualifiedName(schema, input.table, dialect)
        let sql: string
        if (change.kind === 'insert') {
          sql = entries.length
            ? `INSERT INTO ${table} (${entries.map(([name]) => quoteIdentifier(name, dialect)).join(',')}) VALUES (${entries.map(([, value]) => bind(value)).join(',')})`
            : dialect === 'postgres'
              ? `INSERT INTO ${table} DEFAULT VALUES`
              : `INSERT INTO ${table} () VALUES ()`
        } else {
          const original = change.original
          if (!original || keys.some((key) => original[key] === undefined || original[key] === null))
            throw new Error('The original row is missing its primary key. No changes were saved.')
          // Lock by primary key, then compare the entire original row using lossless transport values.
          const where = keys
            .map((key) => `${quoteIdentifier(key, dialect)} = ${bind(original[key])}`)
            .join(' AND ')
          const current = await this.raw(
            session,
            profile.engine,
            `SELECT * FROM ${table} WHERE ${where} FOR UPDATE`,
            values,
            2,
          )
          const row = current[0]?.rows[0]
          if (!row || current[0].rows.length !== 1)
            throw new Error(
              'Conflict: the row was removed or its primary key changed. No changes were saved.',
            )
          const actual = Object.fromEntries(current[0].columns.map((col, index) => [col.name, row[index]]))
          if (
            structure.columns.some(
              (col) =>
                !(col.name in original) ||
                JSON.stringify(actual[col.name]) !== JSON.stringify(original[col.name]),
            )
          )
            throw new Error(
              'Conflict: this row changed on the server since it was loaded. No changes were saved. Reload and review the row.',
            )
          values.length = 0
          if (change.kind === 'delete')
            sql = `DELETE FROM ${table} WHERE ${keys.map((key) => `${quoteIdentifier(key, dialect)} = ${bind(original[key])}`).join(' AND ')}`
          else {
            if (!entries.length) continue
            const assignments = entries
              .map(([name, value]) => `${quoteIdentifier(name, dialect)} = ${bind(value)}`)
              .join(', ')
            sql = `UPDATE ${table} SET ${assignments} WHERE ${keys.map((key) => `${quoteIdentifier(key, dialect)} = ${bind(original[key])}`).join(' AND ')}`
          }
        }
        const sets = await this.raw(session, profile.engine, sql, values, 1)
        const affected = sets.reduce((count, set) => count + set.affectedRows, 0)
        if (affected !== 1)
          throw new Error(`Write affected ${affected} rows instead of one. The transaction was rolled back.`)
        affectedRows += affected
      }
      await this.raw(session, profile.engine, 'COMMIT')
      await this.syncTransaction(session)
      return { affectedRows }
    } catch (error) {
      await this.raw(session, profile.engine, 'ROLLBACK').catch(() => undefined)
      await this.syncTransaction(session).catch(() => undefined)
      throw readableError(error, connection.secrets)
    } finally {
      session.busy = undefined
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.disconnect(id)))
  }
}
