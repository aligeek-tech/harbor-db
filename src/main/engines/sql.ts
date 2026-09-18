import { assertManagedSession } from '../../shared/managed-deployment'
import { isKeyValueEngine } from '../../shared/key-value'
import pg, { type Client as PgClient, type QueryResult as PgResult, type QueryArrayConfig } from 'pg'
import mariadb, { type Connection as MariaConnection } from 'mariadb'
import PgCursor from 'pg-cursor'
import type { EventEmitter } from 'node:events'
import net from 'node:net'
import { isLosslessNumber, isSafeNumber, parse as parseLosslessJson } from 'lossless-json'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  EditsInput,
  ObjectInfo,
  QueryInput,
  QueryResult,
  ResultSet,
  ResultColumn,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import {
  qualifiedName,
  quoteIdentifier,
  requiredSqlConfirmation,
  sqlSafety,
  splitStatements,
} from '../../shared/sql'
import { parameterValue, redactParameterError } from '../../shared/parameters'
import type { ForeignKeyInfo } from '../../shared/related-records'
import type {
  DiagnosticInput,
  DiagnosticResult,
  ExplainInput,
  ExplainResult,
  ObjectInspection,
  ObjectInspectionInput,
} from '../../shared/inspection'
import { buildTableQuery } from '../../shared/table-query'
import { openTransport } from './transport'
import { importTargetConfirmation, type ImportTarget } from '../../shared/imports'
import { ImportBatchError, validateImportNumber, type ImportWriter } from '../persistence/import-writer'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS = 32
const MAX_RESULT_SETS = 100
export const EXPORT_CONSISTENCY =
  'Fresh dedicated read-only transaction; PostgreSQL and InnoDB use repeatable read, SQLite and DuckDB use their native transaction snapshots. Uncommitted tab changes are excluded. Nontransactional MariaDB/MySQL tables are not snapshot-stable.'
export type { StreamQueryInput, QueryStreamSink } from './adapter'
import type { StreamQueryInput, QueryStreamSink } from './adapter'
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
  mariaSocket?: net.Socket
  backendId: number
  transaction: Tx
  busy?: string
  cancelRequested: boolean
  dead: boolean
  messages: string[]
  mysqlTimeout?: number
  onTimeout?: () => void
  lastErrorPosition?: number
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
function assertMysqlJsonNumbers(value: unknown): void {
  if (isLosslessNumber(value)) {
    const raw = value.value
    if (/^-?\d+$/.test(raw)) {
      const integer = BigInt(raw)
      if (integer >= -9223372036854775808n && integer <= 18446744073709551615n) return
    } else if (isSafeNumber(raw)) return
    throw new Error(
      'MySQL JSON would round a numeric token. Store that value as a JSON string or use an exact numeric/text destination before importing.',
    )
  }
  if (value && typeof value === 'object')
    for (const child of Object.values(value)) assertMysqlJsonNumbers(child)
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
function foreignKeyMetadata(rows: Record<string, Cell>[], database?: string): ForeignKeyInfo[] {
  const keys = new Map<string, ForeignKeyInfo>()
  for (const row of rows) {
    const name = text(row.name)
    let key = keys.get(name)
    if (!key) {
      key = {
        name,
        columns: [],
        referencedDatabase: database || text(row.referenced_schema),
        referencedSchema: text(row.referenced_schema),
        referencedTable: text(row.referenced_table),
        referencedColumns: [],
        ...(row.on_update == null ? {} : { onUpdate: text(row.on_update) }),
        ...(row.on_delete == null ? {} : { onDelete: text(row.on_delete) }),
      }
      keys.set(name, key)
    }
    key.columns.push(text(row.source_column))
    key.referencedColumns.push(text(row.referenced_column))
  }
  return [...keys.values()]
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
    if (isKeyValueEngine(profile.engine)) throw new Error('Use the Redis adapter for Redis connections.')
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
    errorLocation?: { position: number }
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
    return {
      state: transaction,
      connected: true,
      running: !!session.busy,
      ...(session.lastErrorPosition === undefined
        ? {}
        : { errorLocation: { position: session.lastErrorPosition } }),
    }
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
    assertManagedSession(profile, database)
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
        const options = {
          host: transport.host,
          port: transport.port,
          user: profile.username || undefined,
          password: secrets.password,
          database: profile.database || undefined,
          ssl: transport.tls,
          connectTimeout: profile.connectTimeout,
          // Connector queryTimeout uses MariaDB-only max_statement_time. Apply
          // the appropriate server setting after checking the actual engine.
          queryTimeout: 0,
          rowsAsArray: true,
          dateStrings: true,
          autoJsonMap: false,
          // Supported by the pinned driver's MySQL JSON decoder but omitted
          // from its type declarations; retain exact JSON numeric literals.
          jsonStrings: true,
          bigIntAsNumber: false,
          decimalAsNumber: false,
          multipleStatements: true,
          permitLocalInfile: false,
          timezone: '+00:00',
          trace: false,
          logParam: false,
          stream: (callback: (error?: Error, stream?: net.Socket) => void) => {
            if (session.mariaSocket) {
              callback(new Error('The driver attempted to open an unreviewed extra database session.'))
              return
            }
            session.mariaSocket = net.connect({ host: transport.host, port: transport.port })
            session.mariaSocket.setNoDelay(true)
            session.mariaSocket.on('error', () => { session.dead = true })
            callback(undefined, session.mariaSocket)
          },
        }
        const client = await mariadb.createConnection(options)
        session.maria = client
        client.on('error', () => {
          session.dead = true
          if (connection.sessions.get('_metadata') === session)
            connection.status = {
              state: 'failed',
              error: 'Database connection was lost. Reconnect to continue.',
            }
        })
        const version = client.serverVersion()
        const mariaServer = /mariadb/i.test(version)
        if ((profile.engine === 'mysql' && mariaServer) || (profile.engine === 'mariadb' && !mariaServer))
          throw new Error(
            `This server reports ${mariaServer ? 'MariaDB' : 'MySQL'}. Choose the matching engine in the connection profile.`,
          )
        if (profile.engine === 'mysql') {
          if (!/^8\.4\./.test(version))
            throw new Error(
              'This MySQL adapter supports MySQL 8.4. Other server versions require separate compatibility verification.',
            )
          const vendor = await client.query('SELECT @@version_comment')
          if (!/MySQL/i.test(String(vendor[0]?.[0])))
            throw new Error(
              'This endpoint does not identify itself as MySQL. Compatible server products require separate verification.',
            )
          session.mysqlTimeout = profile.queryTimeout
          session.onTimeout = () => {
            if (connection.sessions.get('_metadata') === session)
              connection.status = {
                state: 'failed',
                error: 'The MySQL metadata session timed out. Reconnect to continue.',
              }
          }
        }
        if (client.threadId === null) throw new Error('The SQL server did not provide a session identifier.')
        session.backendId = client.threadId
        await client.query("SET time_zone = '+00:00'")
        await client.query(
          profile.engine === 'mysql'
            ? `SET SESSION max_execution_time = ${profile.queryTimeout}`
            : `SET SESSION max_statement_time = ${profile.queryTimeout / 1000}`,
        )
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
      this.stopMariaWire(session)
      return
    }
    if (session.pg) await session.pg.end().catch(() => undefined)
  }

  private stopMariaWire(session: Session): void {
    // Connector destroy() authenticates another KILL connection. Closing our
    // original wire cannot bypass temporary-credential expiry or replay work.
    // EOF settles the connector's pending command; do not inject a TCP error
    // that a detached TLS wrapper could re-emit without a listener.
    if (session.mariaSocket && !session.mariaSocket.destroyed) {
      session.mariaSocket.emit('end')
      session.mariaSocket.destroy()
    }
  }

  private claim(session: Session, requestId: string): void {
    if (session.busy) throw new Error('This tab already has an operation running. Wait or cancel it first.')
    session.busy = requestId
    session.cancelRequested = false
    session.messages = []
    session.lastErrorPosition = undefined
  }

  private async raw(
    session: Session,
    engine: ConnectionProfile['engine'],
    sql: string,
    values: unknown[] = [],
    maxRows = 1000,
  ): Promise<ResultSet[]> {
    if (!session.mysqlTimeout) return this.rawQuery(session, engine, sql, values, maxRows)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.rawQuery(session, engine, sql, values, maxRows),
        new Promise<never>((_resolve, reject) => {
          // MySQL's max_execution_time only covers read-only SELECT. A bounded
          // client deadline also covers writes, scripts and prepared operations.
          timer = setTimeout(() => {
            session.dead = true
            session.onTimeout?.()
            reject(
              Object.assign(
                new Error(
                  'MySQL operation timed out. This tab session was closed; a write may have reached the server. Inspect its outcome before reconnecting and retrying. No operation was replayed.',
                ),
                { code: 'HARBOR_MYSQL_TIMEOUT' },
              ),
            )
            this.stopMariaWire(session)
          }, session.mysqlTimeout! + 250)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async rawQuery(
    session: Session,
    engine: ConnectionProfile['engine'],
    sql: string,
    values: unknown[],
    maxRows: number,
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
    const prepared = values.length ? await session.maria!.prepare({ sql, rowsAsArray: true }) : undefined
    return new Promise<ResultSet[]>((resolve, reject) => {
      const sets: ResultSet[] = []
      let current: ResultSet | undefined
      let resultCount = 0
      let conversionError: unknown
      const stream = prepared
        ? prepared.executeStream(values)
        : session.maria!.queryStream({ sql, rowsAsArray: true })
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
    }).finally(() => prepared?.close())
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
    const values = (input.parameters || []).map((parameter) => {
      const value = parameterValue(parameter)
      return value instanceof Uint8Array ? Buffer.from(value) : value
    })
    if (
      values.length &&
      splitStatements(
        input.sql,
        this.connection(input.connectionId).profile.engine === 'postgres' ? 'postgres' : 'mariadb',
      ).length !== 1
    )
      throw new Error(
        'Parameterized execution requires exactly one statement. Run each statement explicitly.',
      )
    try {
      return await this.executeSql(input, values)
    } catch (error) {
      let message = redactParameterError(
        error instanceof Error ? error.message : 'Query failed',
        input.parameters,
      )
      if (input.parameters?.some((parameter) => parameter.secret)) {
        if (errorCode(error) === 'HARBOR_MYSQL_TIMEOUT')
          message +=
            ' The operation timed out and its tab session was closed. A write may have reached the server; inspect its outcome before reconnecting. No operation was replayed.'
        else if (
          [
            'ECONNRESET',
            'EPIPE',
            'PROTOCOL_CONNECTION_LOST',
            'ER_CMD_CONNECTION_CLOSED',
            '57P01',
            '08006',
          ].includes(errorCode(error))
        )
          message +=
            ' The connection was lost. A write may have reached the server; inspect its outcome before reconnecting. No operation was replayed.'
      }
      throw new Error(message)
    }
  }

  /** Explicit export rerun on an isolated read-only session. Never buffers the full result. */
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (!['postgres', 'mariadb', 'mysql'].includes(profile.engine))
      throw new Error('Full-result SQL streaming is not available for this engine.')
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
    const safety = sqlSafety(input.sql, dialect)
    if (!safety.readOnly || safety.controlsTransaction || safety.statementCount !== 1)
      throw new Error(
        'Full-result export requires one read-only statement. Mutating statements and scripts are never rerun for export.',
      )
    const values = (input.parameters || []).map((value) => {
      const bound = parameterValue(value)
      return bound instanceof Uint8Array ? Buffer.from(bound) : bound
    })
    const id = `_export:${crypto.randomUUID()}`
    let session: Session | undefined
    let cursor: PgCursor<unknown[]> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let oversized = false
    let closing: Promise<void> | undefined
    const interrupted = () => {
      if (oversized)
        throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
      if (timedOut)
        throw new Error('The export exceeded its query timeout. Partial output was not finalized.')
      if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
      if (session?.dead)
        throw new Error('The export database session ended. Partial output was not finalized.')
    }
    const abort = () => {
      if (session && !closing) closing = this.end(session)
    }
    const exceedsRowLimit = (row: unknown[]) => {
      let size = 2 + row.length
      for (const value of row) {
        size +=
          typeof value === 'string'
            ? Buffer.byteLength(value, 'utf8')
            : Buffer.isBuffer(value) || value instanceof Uint8Array
              ? Math.ceil(value.length / 3) * 4
              : 24
        if (size > MAX_BYTES) return true
      }
      return false
    }
    const emit = async (row: unknown[]) => {
      interrupted()
      if (exceedsRowLimit(row)) {
        oversized = true
        interrupted()
      }
      const cells = row.map(losslessCell)
      if (Buffer.byteLength(JSON.stringify(cells), 'utf8') > MAX_BYTES)
        throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
      await sink.onRow(cells)
      interrupted()
    }
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      interrupted()
      session = await this.session(connection, id, input.database)
      interrupted()
      this.claim(session, id)
      timeout = setTimeout(() => {
        timedOut = true
        abort()
      }, profile.queryTimeout)
      timeout.unref()
      if (profile.engine === 'postgres') {
        await this.raw(session, profile.engine, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await this.raw(session, profile.engine, 'SELECT 1')
        cursor = session.pg!.query(new PgCursor<unknown[]>(input.sql, values, { rowMode: 'array' }))
        // Reject oversized values as each driver row arrives, before a 50-row batch can accumulate them.
        cursor.on('row', (row: unknown[]) => {
          if (exceedsRowLimit(row)) {
            oversized = true
            abort()
          }
        })
        let announced = false
        while (true) {
          interrupted()
          const batch = await new Promise<{ rows: unknown[][]; columns: ResultColumn[] }>(
            (resolve, reject) => {
              const ended = () =>
                reject(new Error('The export database session ended. Partial output was not finalized.'))
              session!.pg!.once('end', ended)
              cursor!.read(50, (error, rows, result) => {
                session!.pg!.off('end', ended)
                if (error) reject(error)
                else
                  resolve({
                    rows,
                    columns: result.fields.map((field) => ({
                      name: field.name,
                      type: PG_TYPES[field.dataTypeID] ?? `oid:${field.dataTypeID}`,
                    })),
                  })
              })
            },
          )
          if (!announced) {
            await sink.onColumns(batch.columns)
            announced = true
          }
          for (const row of batch.rows) await emit(row)
          if (batch.rows.length < 50) break
        }
        await cursor.close()
        cursor = undefined
      } else {
        await this.raw(session, profile.engine, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await this.raw(session, profile.engine, 'START TRANSACTION READ ONLY')
        const prepared = values.length
          ? await session.maria!.prepare({ sql: input.sql, rowsAsArray: true })
          : undefined
        try {
          const stream = prepared
            ? prepared.executeStream(values)
            : session.maria!.queryStream({ sql: input.sql, rowsAsArray: true })
          let columns: ResultColumn[] = []
          let fieldSets = 0
          let announced = false
          stream.on('fields', (fields: { name: () => string; type: string; flags: number }[]) => {
            fieldSets++
            columns = fields.map((field) => ({
              name: field.name(),
              type: field.type,
              nullable: !(field.flags & 1),
            }))
          })
          for await (const row of stream) {
            if (fieldSets !== 1 || !Array.isArray(row))
              throw new Error('Full-result export requires a single row result.')
            if (!announced) {
              await sink.onColumns(columns)
              announced = true
            }
            await emit(row)
          }
          if (!announced) await sink.onColumns(columns)
        } finally {
          prepared?.close()
        }
      }
      interrupted()
      await this.raw(session, profile.engine, 'COMMIT')
      interrupted()
    } catch (error) {
      if (oversized)
        throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
      if (timedOut)
        throw new Error('The export exceeded its query timeout. Partial output was not finalized.')
      if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
      const normalized = readableError(error, connection.secrets)
      throw new Error(redactParameterError(normalized.message, input.parameters))
    } finally {
      if (timeout) clearTimeout(timeout)
      sink.signal.removeEventListener('abort', abort)
      if (cursor && session && !session.dead) await cursor.close().catch(() => undefined)
      if (session) await (closing ?? this.end(session))
      connection.sessions.delete(id)
      connection.databases.delete(id)
    }
  }

  private async executeSql(input: QueryInput, values: unknown[]): Promise<QueryResult> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
    const safety = sqlSafety(input.sql, dialect)
    if (safety.statementCount > 100)
      throw new Error('A script can contain at most 100 statements. Run smaller sections explicitly.')
    assertTabSession(input.sessionId)
    if (profile.readOnly && (!safety.readOnly || safety.controlsTransaction))
      throw new Error(
        'This connection is read-only. Only read statements are allowed; use transaction controls for Begin / Commit / Rollback.',
      )
    const confirmation = requiredSqlConfirmation(input.sql, dialect, profile)
    if (!profile.readOnly && confirmation && input.confirm !== confirmation)
      throw new Error(
        `Type "${confirmation}" to confirm this ${safety.destructive ? 'destructive' : 'production write'} operation on ${profile.name}.`,
      )
    if (dialect === 'mariadb' && /^\s*DELIMITER\b/im.test(input.sql))
      throw new Error(
        'DELIMITER is a command-line client directive. Select the complete routine without DELIMITER lines.',
      )
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, input.requestId)
    const started = performance.now()
    let readonlyWrapper = false
    let executingInput = false
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
      executingInput = true
      const sets = await this.raw(session, profile.engine, input.sql, values, input.maxRows)
      executingInput = false
      if (readonlyWrapper) await this.raw(session, profile.engine, 'COMMIT')
      await this.syncTransaction(session)
      const messages = [...session.messages]
      if (sets.some((set) => set.truncated))
        messages.push(
          `Display capped at ${input.maxRows.toLocaleString()} rows or 8 MiB. The original SQL ran unchanged; remaining result rows were drained without retention.`,
        )
      if (dialect === 'mariadb')
        messages.push(
          `${profile.engine === 'mysql' ? 'MySQL' : 'MariaDB'} DDL can implicitly commit; transaction state reflects the server. Nontransactional storage engines cannot roll back writes.`,
        )
      if (profile.engine === 'mysql')
        messages.push(
          'MySQL server timeouts cover read-only SELECT; the client deadline closes the tab session for other timed-out operations. Writes are never replayed.',
        )
      return {
        requestId: input.requestId,
        sets,
        durationMs: Math.round(performance.now() - started),
        messages,
        transaction: session.transaction,
      }
    } catch (error) {
      if (executingInput && session.pg && typeof error === 'object' && error && 'position' in error) {
        const position = Number(error.position)
        const characters = [...input.sql]
        if (Number.isSafeInteger(position) && position > 0 && position <= characters.length) {
          // PostgreSQL counts Unicode characters; editor model offsets use UTF-16.
          session.lastErrorPosition = characters.slice(0, position - 1).join('').length + 1
        }
      }
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

  async inspectObject(input: ObjectInspectionInput): Promise<ObjectInspection> {
    const connection = this.connection(input.connectionId)
    const postgres = connection.profile.engine === 'postgres'
    const dialect = postgres ? 'postgres' : 'mariadb'
    const database = postgres ? this.database(connection, input.database) : undefined
    const schema = input.schema || (postgres ? 'public' : connection.profile.database)
    if (!schema) throw new Error('Choose a schema or database to inspect this object.')
    const result: ObjectInspection = {
      properties: [
        { name: 'Engine', value: connection.profile.engine },
        { name: 'Schema', value: schema },
        { name: 'Name', value: input.name },
        { name: 'Kind', value: input.kind },
      ],
      warnings: [],
    }
    const query = (statement: string, values: unknown[] = []) =>
      this.metadata(input.connectionId, statement, values, database)
    const properties = (row: Record<string, Cell>) =>
      Object.entries(row)
        .filter(([name]) => !['identity', 'definition'].includes(name))
        .map(([name, value]) => ({ name, value: value === null ? 'Unavailable' : text(value) }))
    if (input.kind === 'table' || input.kind === 'view') {
      result.structure = await this.structure({
        connectionId: input.connectionId,
        database,
        schema,
        table: input.name,
      })
      if (postgres) {
        const rows = await query(
          `SELECT c.relkind AS relation_kind,pg_catalog.pg_get_userbyid(c.relowner) AS owner,
          c.reltuples::bigint::text AS estimated_rows,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
          CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) END AS definition
          FROM pg_catalog.pg_class c WHERE c.oid=$1::regclass`,
          [qualifiedName(schema, input.name, dialect)],
        )
        if (!rows.length) throw new Error('This object is missing or is not visible to this account.')
        result.properties.push(...properties(rows[0]))
        result.definition = rows[0].definition
          ? { text: text(rows[0].definition), source: 'server' }
          : { text: result.structure.ddl, source: 'summary' }
        if (!rows[0].definition)
          result.warnings.push(
            'PostgreSQL table DDL is a structural summary; ownership, policies and dependencies are not a complete migration or backup.',
          )
      } else {
        const rows = await query(
          'SELECT table_type AS object_type,engine AS storage_engine,table_rows AS estimated_rows,table_collation AS collation_name FROM information_schema.tables WHERE table_schema=? AND table_name=?',
          [schema, input.name],
        )
        if (!rows.length) throw new Error('This object is missing or is not visible to this account.')
        result.properties.push(...properties(rows[0]))
        result.definition = { text: result.structure.ddl, source: 'server' }
      }
      result.warnings.push('Estimated row counts may be stale; inspection does not run an exact table count.')
      return result
    }
    if (input.kind === 'function') {
      if (postgres) {
        const rows = await query(
          `SELECT p.oid::text AS identity,p.prokind AS routine_kind,
          pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,l.lanname AS language,
          pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS security_definer,p.provolatile AS volatility
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=$2 ORDER BY p.oid LIMIT 501`,
          [schema, input.name],
        )
        if (!rows.length) throw new Error('This routine is missing or is not visible to this account.')
        if (rows.length > 500)
          throw new Error('Too many routine overloads to inspect safely. Narrow the target.')
        result.choices = rows.map((row) => ({
          identity: text(row.identity),
          label: `${input.name}(${text(row.arguments)})`,
        }))
        const chosen = input.identity
          ? rows.find((row) => text(row.identity) === input.identity)
          : rows.length === 1
            ? rows[0]
            : undefined
        if (!chosen) {
          if (input.identity)
            throw new Error(
              'That routine identity no longer matches this schema and name. Refresh the catalog.',
            )
          result.warnings.push('Choose a specific routine signature. Overloads are separate objects.')
          return result
        }
        result.properties.push(...properties(chosen))
        if (chosen.routine_kind === 'a')
          result.warnings.push(
            'Aggregate definitions require aggregate-specific inspection; no function DDL is inferred.',
          )
        else
          result.definition = {
            text: text(
              (
                await query('SELECT pg_catalog.pg_get_functiondef($1::oid) AS definition', [chosen.identity])
              )[0]?.definition,
            ),
            source: 'server',
          }
      } else {
        const rows = await query(
          'SELECT routine_type AS routine_kind,security_type,sql_data_access,is_deterministic,definer FROM information_schema.routines WHERE routine_schema=? AND routine_name=? ORDER BY routine_type',
          [schema, input.name],
        )
        if (!rows.length)
          throw new Error('This routine is missing or is not visible with current catalog privileges.')
        result.choices = rows.map((row) => ({
          identity: text(row.routine_kind),
          label: `${text(row.routine_kind)} ${input.name}`,
        }))
        const chosen = input.identity
          ? rows.find((row) => text(row.routine_kind) === input.identity)
          : rows.length === 1
            ? rows[0]
            : undefined
        if (!chosen) {
          result.warnings.push('Choose FUNCTION or PROCEDURE to inspect the exact routine.')
          return result
        }
        const kind = text(chosen.routine_kind)
        if (!['FUNCTION', 'PROCEDURE'].includes(kind)) throw new Error('Unsupported routine kind.')
        result.properties.push(...properties(chosen))
        const definition = Object.entries(
          (await query(`SHOW CREATE ${kind} ${qualifiedName(schema, input.name, dialect)}`))[0] ?? {},
        ).find(([name]) => /^create /i.test(name))?.[1]
        if (definition) result.definition = { text: text(definition), source: 'server' }
        else result.warnings.push('The server did not expose this routine definition to the current account.')
      }
      return result
    }
    if (postgres) {
      const rows = await query(
        `SELECT t.oid::text AS identity,c.relname AS table_name,t.tgenabled AS enabled,
        pg_catalog.pg_get_triggerdef(t.oid,true) AS definition FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND t.tgname=$2 AND NOT t.tgisinternal ORDER BY c.relname LIMIT 501`,
        [schema, input.name],
      )
      if (!rows.length) throw new Error('This trigger is missing or is not visible to this account.')
      result.choices = rows.map((row) => ({
        identity: text(row.identity),
        label: `${input.name} on ${text(row.table_name)}`,
      }))
      const chosen = input.identity
        ? rows.find((row) => text(row.identity) === input.identity)
        : rows.length === 1
          ? rows[0]
          : undefined
      if (!chosen) {
        result.warnings.push('Choose the trigger target table; names may repeat across tables.')
        return result
      }
      result.properties.push(...properties(chosen))
      result.definition = { text: text(chosen.definition), source: 'server' }
    } else {
      const rows = await query(
        'SELECT event_object_table AS table_name,event_manipulation AS event_name,action_timing AS timing,action_statement AS definition,definer FROM information_schema.triggers WHERE trigger_schema=? AND trigger_name=?',
        [schema, input.name],
      )
      if (!rows.length) throw new Error('This trigger is missing or hidden by current TRIGGER privileges.')
      result.properties.push(...properties(rows[0]))
      const ddl = await query(`SHOW CREATE TRIGGER ${qualifiedName(schema, input.name, dialect)}`)
      const definition = Object.entries(ddl[0] ?? {}).find(([name]) =>
        /sql original statement/i.test(name),
      )?.[1]
      if (definition) result.definition = { text: text(definition), source: 'server' }
      else {
        result.definition = { text: text(rows[0].definition), source: 'server' }
        result.warnings.push(
          'Only the trigger body is available; it is not a complete CREATE TRIGGER statement.',
        )
      }
    }
    return result
  }

  async explainQuery(input: ExplainInput): Promise<ExplainResult> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (!['postgres', 'mariadb', 'mysql'].includes(profile.engine))
      throw new Error('Query plans are not supported for this engine.')
    if (input.mode === 'analyze' && input.consentAnalyze !== true)
      throw new Error('Execution analysis runs the statement. Confirm analysis explicitly before continuing.')
    const safety = sqlSafety(input.sql, profile.engine === 'postgres' ? 'postgres' : 'mariadb')
    if (!safety.readOnly || safety.controlsTransaction || safety.statementCount !== 1)
      throw new Error('Plan inspection requires one read-only statement. Write analysis is not supported.')
    if (connection.sessions.has(input.sessionId) || connection.creating.has(input.sessionId))
      throw new Error(
        'Use a new dedicated plan session; existing tab transactions cannot be reused for analysis.',
      )
    const values = (input.parameters || []).map((value) => {
      const bound = parameterValue(value)
      return bound instanceof Uint8Array ? Buffer.from(bound) : bound
    })
    const format = profile.engine === 'mysql' && input.mode === 'analyze' ? 'text' : 'json'
    const prefix =
      profile.engine === 'postgres'
        ? `EXPLAIN (FORMAT JSON${input.mode === 'analyze' ? ', ANALYZE TRUE, BUFFERS TRUE' : ''}) `
        : profile.engine === 'mariadb'
          ? input.mode === 'analyze'
            ? 'ANALYZE FORMAT=JSON '
            : 'EXPLAIN FORMAT=JSON '
          : input.mode === 'analyze'
            ? 'EXPLAIN ANALYZE FORMAT=TREE '
            : 'EXPLAIN FORMAT=JSON '
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, input.requestId)
    const started = performance.now()
    const warnings = [
      'Plans use a new read-only transaction and exclude uncommitted work or temporary objects in other tabs.',
      input.mode === 'analyze'
        ? 'Execution analysis runs the statement and adds measurement overhead; it is not a production performance benchmark.'
        : 'Estimates depend on current statistics and planner settings. Native optimizers may evaluate expressions or functions; the dedicated transaction remains read-only. No runtime measurement was requested.',
    ]
    try {
      await this.raw(
        session,
        profile.engine,
        profile.engine === 'postgres' ? 'BEGIN READ ONLY' : 'START TRANSACTION READ ONLY',
      )
      if (profile.engine === 'postgres') await this.raw(session, profile.engine, 'SELECT 1')
      const sets = await this.raw(session, profile.engine, prefix + input.sql, values, 1000)
      if (session.cancelRequested && profile.engine === 'mysql') {
        // MySQL can return a partial EXPLAIN ANALYZE tree plus warning 1317
        // instead of rejecting the query. Only that server warning confirms interruption.
        const diagnostics = await this.raw(session, profile.engine, 'SHOW WARNINGS', [], 100)
        if (diagnostics.some((set) => set.rows.some((row) => String(row[1]) === '1317')))
          return {
            engine: profile.engine,
            mode: input.mode,
            format,
            raw: '',
            durationMs: Math.round(performance.now() - started),
            warnings: [
              'The server confirmed query cancellation. The partial MySQL analysis plan is not presented as completed.',
            ],
            cancelled: true,
          }
        warnings.push(
          'Cancellation was requested, but the server returned a plan without confirming interruption.',
        )
      }
      if (sets.some((set) => set.truncated))
        throw new Error('The plan exceeds the 8 MiB / 1,000 row limit. Narrow the statement.')
      const raw = sets.flatMap((set) => set.rows.map((row) => text(row[0]))).join('\n')
      return {
        engine: profile.engine,
        mode: input.mode,
        format,
        raw,
        durationMs: Math.round(performance.now() - started),
        warnings,
      }
    } catch (error) {
      if (
        session.cancelRequested &&
        ['57014', 'ER_QUERY_INTERRUPTED', 'ER_STATEMENT_TIMEOUT', 'ER_QUERY_TIMEOUT'].includes(
          errorCode(error),
        )
      )
        return {
          engine: profile.engine,
          mode: input.mode,
          format,
          raw: '',
          durationMs: Math.round(performance.now() - started),
          warnings: ['The server confirmed plan analysis cancellation.'],
          cancelled: true,
        }
      throw new Error(
        redactParameterError(readableError(error, connection.secrets).message, input.parameters),
      )
    } finally {
      if (!session.dead) await this.raw(session, profile.engine, 'ROLLBACK').catch(() => undefined)
      session.busy = undefined
      await this.closeSession(input)
    }
  }

  async diagnostics(input: DiagnosticInput): Promise<DiagnosticResult> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const postgres = profile.engine === 'postgres'
    const started = performance.now()
    const warnings = [
      'Manual snapshot only. Visibility depends on server privileges; missing rows do not prove that no other sessions, locks or grants exist.',
    ]
    const result: DiagnosticResult = { kind: input.kind, available: true, sets: [], durationMs: 0, warnings }
    const id = `_diagnostics:${crypto.randomUUID()}`
    let session: Session | undefined
    const read = async (statement: string, values: unknown[] = [], label: string = input.kind) => {
      const sets = await this.raw(session!, profile.engine, statement, values, 200)
      for (const set of sets) {
        set.command = label
        if (set.truncated) warnings.push(`${label}: display capped at 200 rows or 8 MiB.`)
      }
      result.sets.push(...sets)
      return sets
    }
    try {
      if (!['postgres', 'mariadb', 'mysql'].includes(profile.engine))
        throw new Error('SQL diagnostics are not available for this engine.')
      session = await this.session(connection, id, input.database)
      this.claim(session, id)
      await this.raw(session, profile.engine, postgres ? 'BEGIN READ ONLY' : 'START TRANSACTION READ ONLY')
      if (input.kind === 'activity') {
        if (postgres)
          await read(`SELECT pid::text AS session_id,usename AS username,datname AS database_name,application_name,state,
          wait_event_type,wait_event,backend_start::text,xact_start::text,query_start::text,
          pg_catalog.pg_blocking_pids(pid)::text AS blocking_sessions${input.includeQueryText ? ',left(query,2000) AS query_preview' : ''}
          FROM pg_catalog.pg_stat_activity WHERE backend_type='client backend' AND datname=current_database() ORDER BY pid LIMIT 201`)
        else {
          const database = input.database || profile.database || null
          await read(
            `SELECT ID AS session_id,USER AS username,HOST AS client,DB AS database_name,COMMAND AS command_name,TIME AS elapsed_seconds,STATE AS state_name${input.includeQueryText ? ',LEFT(INFO,2000) AS query_preview' : ''}
            FROM information_schema.PROCESSLIST WHERE (? IS NULL OR DB=?) ORDER BY ID LIMIT 201`,
            [database, database],
          )
        }
        warnings.push(
          input.includeQueryText
            ? 'Query previews may contain application data and are truncated at 2,000 characters.'
            : 'Query text is omitted by default. Request it explicitly only when needed.',
        )
      } else if (input.kind === 'locks') {
        if (postgres)
          await read(`SELECT l.pid::text AS session_id,l.locktype,l.mode,l.granted,l.relation::regclass::text AS relation_name,
          l.transactionid::text,pg_catalog.pg_blocking_pids(l.pid)::text AS blocking_sessions
          FROM pg_catalog.pg_locks l WHERE l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) OR l.database IS NULL
          ORDER BY l.granted,l.pid LIMIT 201`)
        else if (profile.engine === 'mysql')
          await read(`SELECT w.REQUESTING_ENGINE_TRANSACTION_ID AS waiting_transaction,w.BLOCKING_ENGINE_TRANSACTION_ID AS blocking_transaction,
          requested.OBJECT_SCHEMA AS schema_name,requested.OBJECT_NAME AS table_name,requested.LOCK_TYPE AS lock_type,requested.LOCK_MODE AS lock_mode,requested.LOCK_STATUS AS lock_status
          FROM performance_schema.data_lock_waits w LEFT JOIN performance_schema.data_locks requested ON requested.ENGINE=w.ENGINE AND requested.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID LIMIT 201`)
        else
          await read(`SELECT w.requesting_trx_id AS waiting_transaction,w.blocking_trx_id AS blocking_transaction,
          requested.lock_table AS table_name,requested.lock_index AS index_name,requested.lock_type,requested.lock_mode
          FROM information_schema.INNODB_LOCK_WAITS w LEFT JOIN information_schema.INNODB_LOCKS requested ON requested.lock_id=w.requested_lock_id LIMIT 201`)
        warnings.push('This is a point-in-time lock snapshot. No sessions were cancelled or terminated.')
      } else if (input.kind === 'indexes') {
        if (postgres)
          await read(
            `SELECT n.nspname AS schema_name,t.relname AS table_name,c.relname AS index_name,i.indisunique AS is_unique,
          i.indisprimary AS is_primary,i.indisvalid AS is_valid,pg_catalog.pg_get_indexdef(c.oid) AS definition,
          pg_catalog.pg_relation_size(c.oid)::text AS bytes,s.idx_scan::text AS scans
          FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid=c.oid
          WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND ($1::text IS NULL OR n.nspname=$1) AND ($2::text IS NULL OR t.relname=$2)
          ORDER BY n.nspname,t.relname,c.relname LIMIT 201`,
            [input.schema || null, input.table || null],
          )
        else {
          const schema = input.schema || profile.database
          if (!schema) throw new Error('Choose a database before inspecting indexes.')
          await read(
            `SELECT table_schema AS schema_name,table_name,index_name,seq_in_index,column_name,non_unique,index_type,nullable,cardinality
            FROM information_schema.statistics WHERE table_schema=? AND (? IS NULL OR table_name=?) ORDER BY table_name,index_name,seq_in_index LIMIT 201`,
            [schema, input.table || null, input.table || null],
          )
        }
        warnings.push(
          'Index statistics and cardinalities may be stale. No indexes are created, rebuilt or removed by inspection.',
        )
      } else if (input.kind === 'permissions') {
        if (postgres)
          await read(
            `SELECT grantee,table_schema,table_name,privilege_type,is_grantable FROM information_schema.table_privileges
          WHERE ($1::text IS NULL OR table_schema=$1) AND ($2::text IS NULL OR table_name=$2) ORDER BY table_schema,table_name,grantee,privilege_type LIMIT 201`,
            [input.schema || null, input.table || null],
          )
        else {
          const schema = input.schema || profile.database
          if (!schema) throw new Error('Choose a database before inspecting grants.')
          await read(
            `SELECT 'global' AS scope,grantee,'' AS schema_name,'' AS table_name,privilege_type,is_grantable FROM information_schema.user_privileges
            UNION ALL SELECT 'schema',grantee,table_schema,'',privilege_type,is_grantable FROM information_schema.schema_privileges WHERE table_schema=?
            UNION ALL SELECT 'table',grantee,table_schema,table_name,privilege_type,is_grantable FROM information_schema.table_privileges WHERE table_schema=? AND (? IS NULL OR table_name=?) LIMIT 201`,
            [schema, schema, input.table || null, input.table || null],
          )
        }
        warnings.push(
          'Visible grants are not a complete effective-access calculation: roles, ownership, row policies, column privileges and session state can affect access. The profile read-only switch does not grant or revoke server privileges.',
        )
      } else if (input.kind === 'extensions') {
        if (!postgres) throw new Error('PostgreSQL extension inspection is not available for this engine.')
        await read(
          'SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema_name FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname LIMIT 201',
        )
        warnings.push('No extensions were installed, upgraded or configured.')
      } else {
        if (!postgres)
          throw new Error('Timescale inspection requires a PostgreSQL connection with TimescaleDB installed.')
        const extension = await this.raw(
          session,
          profile.engine,
          "SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname='timescaledb'",
          [],
          1,
        )
        if (!extension[0]?.rows.length)
          throw new Error('TimescaleDB is not installed in this selected database.')
        const owned = records(
          (
            await this.raw(
              session,
              profile.engine,
              `SELECT c.relname AS name FROM pg_catalog.pg_extension e
          JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_class'::regclass
          JOIN pg_catalog.pg_class c ON c.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE e.extname='timescaledb' AND n.nspname='timescaledb_information' AND c.relname IN ('hypertables','chunks','continuous_aggregates','jobs')
          AND pg_catalog.has_schema_privilege(n.oid,'USAGE') AND pg_catalog.has_table_privilege(c.oid,'SELECT')`,
              [],
              10,
            )
          )[0],
        )
        const names = new Set(owned.map((row) => text(row.name)))
        const scope = [input.schema || null, input.table || null]
        if (names.has('hypertables'))
          await read(
            `SELECT hypertable_schema,hypertable_name,owner,num_dimensions,num_chunks,compression_enabled FROM timescaledb_information.hypertables WHERE ($1::text IS NULL OR hypertable_schema=$1) AND ($2::text IS NULL OR hypertable_name=$2) ORDER BY hypertable_schema,hypertable_name LIMIT 201`,
            scope,
            'hypertables',
          )
        if (names.has('chunks'))
          await read(
            `SELECT hypertable_schema,hypertable_name,chunk_schema,chunk_name,range_start::text,range_end::text,is_compressed FROM timescaledb_information.chunks WHERE ($1::text IS NULL OR hypertable_schema=$1) AND ($2::text IS NULL OR hypertable_name=$2) ORDER BY hypertable_schema,hypertable_name,chunk_name LIMIT 201`,
            scope,
            'chunks',
          )
        if (names.has('continuous_aggregates'))
          await read(
            `SELECT view_schema,view_name,hypertable_schema,hypertable_name,materialized_only FROM timescaledb_information.continuous_aggregates WHERE ($1::text IS NULL OR hypertable_schema=$1) AND ($2::text IS NULL OR hypertable_name=$2) ORDER BY view_schema,view_name LIMIT 201`,
            scope,
            'continuous aggregates',
          )
        if (names.has('jobs'))
          await read(
            `SELECT job_id,application_name,proc_schema,proc_name,schedule_interval::text,max_runtime::text,scheduled,hypertable_schema,hypertable_name FROM timescaledb_information.jobs WHERE ($1::text IS NULL OR hypertable_schema=$1) AND ($2::text IS NULL OR hypertable_name=$2) ORDER BY job_id LIMIT 201`,
            scope,
            'jobs and policies',
          )
        if (!result.sets.length)
          throw new Error(
            'TimescaleDB is installed, but its supported informational views are not visible to this account.',
          )
        warnings.push(
          `TimescaleDB ${text(extension[0].rows[0][0])}. Only available extension-owned views were read; no policies, chunks, jobs or extensions were changed.`,
        )
      }
    } catch (error) {
      result.available = false
      result.warnings.push(readableError(error, connection.secrets).message)
    } finally {
      if (session) {
        if (!session.dead) await this.raw(session, profile.engine, 'ROLLBACK').catch(() => undefined)
        await this.end(session)
      }
      connection.sessions.delete(id)
      connection.databases.delete(id)
      result.durationMs = Math.round(performance.now() - started)
    }
    return result
  }

  async structure(input: {
    connectionId: string
    schema: string
    table: string
    database?: string
  }): Promise<TableStructure & { foreignKeys: ForeignKeyInfo[] }> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
    const database = dialect === 'postgres' ? this.database(connection, input.database) : undefined
    const schema = input.schema || (dialect === 'postgres' ? 'public' : profile.database)
    if (dialect === 'postgres') {
      const name = qualifiedName(schema, input.table, dialect)
      const columns = await this.metadata(
        input.connectionId,
        `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attgenerated AS generated,a.attidentity AS identity,
          (SELECT k.ordinality FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality)
           WHERE i.indrelid=a.attrelid AND i.indisprimary AND k.attnum=a.attnum
             AND k.ordinality <= i.indnkeyatts) AS primary_key_position
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
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
      const foreignKeys = await this.metadata(
        input.connectionId,
        `SELECT c.conname AS name,source.attname AS source_column,target.attname AS referenced_column,
          namespace.nspname AS referenced_schema,relation.relname AS referenced_table,
          CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
          CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
         FROM pg_catalog.pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS pair(source_number,target_number,position)
         JOIN pg_catalog.pg_attribute source ON source.attrelid=c.conrelid AND source.attnum=pair.source_number
         JOIN pg_catalog.pg_attribute target ON target.attrelid=c.confrelid AND target.attnum=pair.target_number
         JOIN pg_catalog.pg_class relation ON relation.oid=c.confrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE c.conrelid=$1::regclass AND c.contype='f'
         ORDER BY c.conname,pair.position`,
        [name],
        database,
      )
      // Check extension ownership before referring to optional Timescale views.
      const hypertableView = await this.metadata(
        input.connectionId,
        `SELECT c.oid FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass
           AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_class'::regclass
         JOIN pg_catalog.pg_class c ON c.oid=d.objid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE e.extname='timescaledb' AND n.nspname='timescaledb_information'
           AND c.relname='hypertables' AND pg_catalog.has_schema_privilege(n.oid,'USAGE')
           AND pg_catalog.has_table_privilege(c.oid,'SELECT')`,
        [],
        database,
      )
      const hypertable = hypertableView.length
        ? await this.metadata(
            input.connectionId,
            'SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema=$1 AND hypertable_name=$2',
            [schema, input.table],
            database,
          )
        : []
      const result: TableStructure & { foreignKeys: ForeignKeyInfo[] } = {
        foreignKeys: foreignKeyMetadata(foreignKeys, database),
        isHypertable: hypertable.length > 0,
        columns: columns.map((row) => ({
          name: text(row.name),
          type: text(row.type),
          nullable: ['t', 'true'].includes(text(row.nullable)),
          defaultValue: row.default_value === null ? null : text(row.default_value),
          ...(text(row.generated) ? { generated: true } : {}),
          ...(text(row.identity) ? { identity: text(row.identity) === 'a' ? 'always' as const : 'by-default' as const } : {}),
          primaryKey: row.primary_key_position != null,
          ...(row.primary_key_position != null
            ? { primaryKeyPosition: Number(row.primary_key_position) }
            : {}),
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
    const foreignKeys = await this.metadata(
      input.connectionId,
      `SELECT k.constraint_name AS name,k.column_name AS source_column,
        k.referenced_table_schema AS referenced_schema,k.referenced_table_name AS referenced_table,
        k.referenced_column_name AS referenced_column,r.update_rule AS on_update,r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       LEFT JOIN information_schema.referential_constraints r
         ON r.constraint_schema=k.constraint_schema AND r.table_name=k.table_name AND r.constraint_name=k.constraint_name
       WHERE k.table_schema=? AND k.table_name=? AND k.referenced_table_name IS NOT NULL
       ORDER BY k.constraint_name,k.ordinal_position`,
      [schema, input.table],
    )
    const ddlRows = await this.metadata(
      input.connectionId,
      `SHOW CREATE TABLE ${qualifiedName(schema, input.table, dialect)}`,
    )
    return {
      foreignKeys: foreignKeyMetadata(foreignKeys),
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
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
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
    if (structure.isHypertable && !input.sort)
      result.messages.push(
        'Unsorted hypertable preview: row order and offset page boundaries may change. Choose a column to sort; sorting large histories can be expensive.',
      )
    else if (!keys.length)
      result.messages.push('No primary key: rows are read-only and pagination order may change.')
    else
      result.messages.push(
        'Offset pagination uses primary-key tie breakers. Concurrent inserts and deletes can move page boundaries.',
      )
    return result
  }

  async openImport(input: ImportTarget & { columns: string[] }, signal: AbortSignal): Promise<ImportWriter> {
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (profile.readOnly) throw new Error('This connection is read-only.')
    if (
      profile.environment.toLowerCase() === 'production' &&
      input.confirm !== importTargetConfirmation(input)
    )
      throw new Error(
        `Type "${importTargetConfirmation(input)}" to confirm the exact production import target.`,
      )
    if (
      !input.columns.length ||
      input.columns.length > 200 ||
      new Set(input.columns).size !== input.columns.length
    )
      throw new Error('Choose 1–200 unique destination columns.')
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
    const database = this.database(connection, input.database)
    const structure = await this.structure(input)
    if (input.columns.some((column) => !structure.columns.some((candidate) => candidate.name === column)))
      throw new Error('A destination column no longer exists. Refresh the table structure.')
    const table = qualifiedName(input.schema, input.table, dialect)
    if (dialect === 'postgres') {
      const kinds = await this.metadata(
        input.connectionId,
        `WITH RECURSIVE relations AS (SELECT oid,relkind FROM pg_catalog.pg_class WHERE oid=$1::regclass
         UNION ALL SELECT child.oid,child.relkind FROM relations parent JOIN pg_catalog.pg_inherits i ON i.inhparent=parent.oid JOIN pg_catalog.pg_class child ON child.oid=i.inhrelid)
         SELECT relkind FROM relations`,
        [table],
        database,
      )
      if (!kinds.length || kinds.some((row) => !['r', 'p'].includes(text(row.relkind))))
        throw new Error(
          'Batch import requires a transactional base table; views and foreign-table partitions are unsupported.',
        )
    } else {
      const kind = await this.metadata(
        input.connectionId,
        'SELECT engine AS storage_engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',
        [input.schema, input.table],
      )
      if (!['INNODB', 'XTRADB'].includes(text(kind[0]?.storage_engine).toUpperCase()))
        throw new Error(
          'Batch import requires an InnoDB table; views and nontransactional tables are unsupported.',
        )
    }
    const sessionId = `_import:${crypto.randomUUID()}`
    const session = await this.session(connection, sessionId, database)
    this.claim(session, 'import')
    // Read the same native metadata on the dedicated writer connection before each
    // batch, after its table metadata lock is held. Otherwise ALTER between commits
    // could make a previously exact DECIMAL binding round silently.
    const columnSql = dialect === 'postgres'
      ? `SELECT a.attname,format_type(a.atttypid,a.atttypmod),CASE WHEN a.attnotnull THEN 'false' ELSE 'true' END,pg_get_expr(d.adbin,d.adrelid),a.attgenerated,a.attidentity,a.attrelid::text,a.attnum::text
         FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
         WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`
      : `SELECT column_name,column_type,CASE WHEN is_nullable='YES' THEN 'true' ELSE 'false' END,column_default,extra,generation_expression,ordinal_position,column_key
         FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`
    const columnParameters = dialect === 'postgres' ? [table] : [input.schema, input.table]
    const readColumns = async () => {
      const sets = await this.raw(session, profile.engine, columnSql, columnParameters, 2001)
      if (sets.length !== 1 || sets[0].truncated || !sets[0].rows.length)
        throw new Error('Import column metadata is unavailable or exceeds its bound.')
      return sets[0].rows
    }
    let reviewedColumns: string
    try {
      const columns = await readColumns()
      const expected = structure.columns.map((column) => [column.name, column.type, String(column.nullable), column.defaultValue])
      if (JSON.stringify(columns.map((row) => row.slice(0, 4))) !== JSON.stringify(expected))
        throw new Error('The destination columns changed while opening the import writer. Preview again.')
      reviewedColumns = JSON.stringify(columns)
    } catch (error) {
      await this.end(session)
      connection.sessions.delete(sessionId)
      connection.databases.delete(sessionId)
      throw error
    }
    let phase: 'idle' | 'writing' | 'committing' | 'rollback' | 'closed' = 'idle'
    let cancellation: Promise<void> | undefined
    const interrupt = () => {
      if (phase !== 'writing' || cancellation) return
      cancellation = (async () => {
        const control = await this.createSession(connection, session.database)
        try {
          if (phase !== 'writing') return
          if (profile.engine === 'postgres')
            await this.raw(control, 'postgres', 'SELECT pg_cancel_backend($1)', [session.backendId], 1)
          else await this.raw(control, profile.engine, `KILL QUERY ${session.backendId}`)
        } finally {
          await this.end(control)
        }
      })().catch(() => {
        // A definer-rights trigger can temporarily prevent the same login from
        // killing its own query. Let the bounded statement finish, then roll
        // back; the connector's active destroy path issues a second KILL.
      })
    }
    signal.addEventListener('abort', interrupt)
    const statement = `INSERT INTO ${table} (${input.columns.map((name) => quoteIdentifier(name, dialect)).join(',')}) VALUES (${input.columns.map((_name, index) => (dialect === 'postgres' ? `$${index + 1}` : '?')).join(',')})`
    return {
      columns: structure.columns,
      writeBatch: async (rows) => {
        if (phase !== 'idle' || session.dead)
          throw new ImportBatchError(
            'The dedicated import session ended. No retry was attempted; inspect earlier batches before restarting.',
            'uncertain',
            0,
          )
        if (signal.aborted)
          throw new ImportBatchError('Import cancelled before this batch started.', 'rolled-back', 0)
        if (
          !rows.length ||
          rows.length > 500 ||
          rows.some((row) => row.length !== input.columns.length) ||
          Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_BYTES
        )
          throw new Error(
            'An import batch must contain 1–500 rows / at most 8 MiB with the reviewed column count.',
          )
        for (const row of rows)
          row.forEach((value, index) =>
            validateImportNumber(
              value,
              structure.columns.find((column) => column.name === input.columns[index])!,
              profile.engine,
            ),
          )
        if (profile.engine === 'mysql') {
          const jsonColumns = input.columns.map((name) =>
            /^json$/i.test(structure.columns.find((column) => column.name === name)!.type),
          )
          for (const row of rows)
            row.forEach((value, index) => {
              if (!jsonColumns[index] || value === null) return
              if (typeof value !== 'string') throw new Error('Map a JSON destination from valid JSON text.')
              let parsed: unknown
              try {
                parsed = parseLosslessJson(value)
              } catch {
                throw new Error('The source contains invalid JSON. Imported values were omitted.')
              }
              assertMysqlJsonNumbers(parsed)
            })
        }
        let commitSent = false
        try {
          phase = 'writing'
          await this.raw(session, profile.engine, dialect === 'postgres' ? 'BEGIN' : 'START TRANSACTION')
          // Pin the table's metadata lock before checking its transactional engine.
          // A concurrent ALTER cannot switch it to a nontransactional engine mid-batch.
          await this.raw(session, profile.engine, `SELECT 1 FROM ${table} LIMIT 0`, [], 1)
          if (JSON.stringify(await readColumns()) !== reviewedColumns)
            throw new Error('The destination schema changed after review. This batch was not inserted.')
          if (profile.engine !== 'postgres') {
            const actual = await this.raw(
              session,
              profile.engine,
              'SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',
              [input.schema, input.table],
              1,
            )
            if (!['INNODB', 'XTRADB'].includes(text(actual[0]?.rows[0]?.[0]).toUpperCase()))
              throw new Error('The destination engine changed.')
          }
          for (const row of rows) {
            if (signal.aborted) throw new Error('Import cancelled.')
            session.messages = []
            const result = await this.raw(session, profile.engine, statement, row.map(parameter), 1)
            if (result.reduce((total, set) => total + set.affectedRows, 0) !== 1)
              throw new Error('Unexpected imported row count.')
            if (profile.engine !== 'postgres' && session.messages.length)
              throw new Error('The server reported a value conversion warning.')
          }
          // A cancellation control socket must finish before COMMIT, so a late KILL cannot hit it.
          if (cancellation) await cancellation
          if (signal.aborted) throw new Error('Import cancelled.')
          phase = 'committing'
          commitSent = true
          await this.raw(session, profile.engine, 'COMMIT')
          phase = 'idle'
        } catch {
          if (cancellation) await cancellation
          phase = 'rollback'
          let rolledBack = false
          if (!commitSent && !session.dead) {
            try {
              await this.raw(session, profile.engine, 'ROLLBACK')
              rolledBack = true
              if (profile.engine !== 'postgres') {
                const nativeWarnings = await this.raw(session, profile.engine, 'SHOW WARNINGS', [], 20)
                if (nativeWarnings.some((set) => set.rows.some((row) => Number(row[1]) === 1196)))
                  rolledBack = false
              }
            } catch {
              /* No rollback acknowledgment: retain an uncertain outcome. */
            }
          }
          phase = 'idle'
          throw new ImportBatchError(
            rolledBack
              ? signal.aborted
                ? 'Import cancelled. The current batch was rolled back; earlier acknowledged batches remain committed.'
                : 'The database rejected this batch or reported a conversion warning. The batch was rolled back. Imported values and driver details were omitted; no retry was attempted.'
              : 'The current batch outcome is uncertain because COMMIT or rollback could not be confirmed. Earlier acknowledged batches remain committed. Inspect the destination before retrying; no writes were replayed.',
            rolledBack ? 'rolled-back' : 'uncertain',
            rows.length,
          )
        } finally {
          cancellation = undefined
        }
      },
      close: async () => {
        signal.removeEventListener('abort', interrupt)
        if (cancellation) await cancellation
        phase = 'closed'
        await this.end(session)
        connection.sessions.delete(sessionId)
        connection.databases.delete(sessionId)
      },
    }
  }

  async applyEdits(input: EditsInput): Promise<{ affectedRows: number }> {
    assertTabSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const { profile } = connection
    if (profile.readOnly) throw new Error('This connection is read-only.')
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
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
        'SELECT engine AS storage_engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',
        [schema, input.table],
      )
      if (!['INNODB', 'XTRADB'].includes(text(engine[0]?.storage_engine).toUpperCase()))
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
