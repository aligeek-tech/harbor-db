import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { EventEmitter } from 'node:events'
import pg, { type Client, type QueryResult as PgResult, type QueryArrayConfig } from 'pg'
import PgCursor from 'pg-cursor'
import mariadb, { type Connection as MariaConnection } from 'mariadb'
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
  assertCompatibleProfile,
  compatibleQuerySafety,
  compatibleSqlPolicies,
  verifyCompatibleProduct,
  type CompatibleSqlEngine,
} from '../../shared/compatible-sql'
import { parameterValue, redactParameterError } from '../../shared/parameters'
import type { QueryParameter } from '../../shared/parameters'
import { quoteIdentifier, requiredSqlConfirmation } from '../../shared/sql'
import { buildTableQuery } from '../../shared/table-query'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import { openTransport, type Transport } from './transport'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_SESSIONS = 16
type Transaction = 'idle' | 'open' | 'failed'
type ProductProfile = ConnectionProfile & { engine: CompatibleSqlEngine }
interface Session {
  pg?: Client
  maria?: MariaConnection
  socket?: net.Socket
  dead: boolean
  busy?: string
  state: Transaction
  interrupted?: string
}
interface Connection {
  profile: ProductProfile
  secrets: Secrets
  transport: Transport
  sessions: Map<string, Session>
  creating: Map<string, Promise<Session>>
  metadataQueue: Promise<unknown>
  status: ConnectionStatus
  closed: boolean
}
const pgTypes: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  114: 'json',
  3802: 'jsonb',
  2950: 'uuid',
}
function columns(fields: PgResult['fields']): ResultColumn[] {
  return fields.map((field) => ({
    name: field.name,
    type: pgTypes[field.dataTypeID] ?? `oid:${field.dataTypeID}`,
  }))
}
function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { type: 'binary', base64: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  throw new Error('The compatible-product driver returned an unsupported value; refusing a lossy conversion.')
}
function safeError(error: unknown, secrets: Secrets = {}): Error {
  let message = (error instanceof Error ? error.message : 'Compatible SQL operation failed.').split(
    /\n(?:sql:|parameters:)/i,
  )[0]
  for (const secret of Object.values(secrets)) if (secret) message = message.replaceAll(secret, '[redacted]')
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (code === '40001' || code === '40P01')
    message +=
      ' The transaction must be reviewed and restarted explicitly. Harbor did not replay any statement.'
  if (
    [
      'ECONNRESET',
      'EPIPE',
      '08006',
      '57P01',
      'PROTOCOL_CONNECTION_LOST',
      'ER_CMD_CONNECTION_CLOSED',
    ].includes(code)
  )
    message +=
      ' The connection was lost. A write may have reached the server; inspect the outcome before reconnecting. No statement was replayed.'
  return Object.assign(new Error(message), { code })
}
function assertTab(id: string): void {
  if (!id || id.startsWith('_'))
    throw new Error('Use a nonempty tab session identifier without a leading underscore.')
}
function parameters(profile: ProductProfile, values: QueryParameter[] = []): unknown[] {
  return values.map((item) => {
    const value = parameterValue(item)
    if (value instanceof Uint8Array) return Buffer.from(value)
    // MySQL-wire LIMIT/OFFSET require numeric binding. Convert only exactly safe
    // integers; arbitrary BIGINT and DECIMAL parameters remain their original strings.
    if (
      compatibleSqlPolicies[profile.engine].dialect === 'mysql' &&
      item.type === 'integer' &&
      Number.isSafeInteger(Number(value))
    )
      return Number(value)
    return value
  })
}
function state(session: Session): Transaction {
  if (session.pg) {
    const value = session.pg.getTransactionStatus()
    session.state = value === 'T' ? 'open' : value === 'E' ? 'failed' : 'idle'
  } else if (session.maria) session.state = (session.maria.info?.status ?? 0) & 1 ? 'open' : 'idle'
  return session.state
}

/** Explicit product adapters share only wire mechanics; product identity and policy are checked independently. */
export class CompatibleSqlService {
  private connections = new Map<string, Connection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()

  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let connection: Connection | undefined
    let transport: Transport | undefined
    try {
      assertCompatibleProfile(profile)
      transport = await openTransport(profile, secrets)
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      connection = {
        profile: structuredClone(profile),
        secrets: { ...secrets },
        transport,
        sessions: new Map(),
        creating: new Map(),
        metadataQueue: Promise.resolve(),
        status: { state: 'connecting' },
        closed: false,
      }
      this.connections.set(profile.id, connection)
      const session = await this.session(connection, '_metadata')
      const version = await this.raw(connection, session, 'SELECT version()', [], 1)
      if (connection.closed || this.generations.get(profile.id) !== generation)
        return { state: 'disconnected' }
      connection.status = {
        state: 'connected',
        version: String(version.rows[0]?.[0] ?? compatibleSqlPolicies[profile.engine].name),
        transport: `${profile.ssh.enabled ? 'SSH + ' : ''}${profile.tls.enabled ? 'TLS' : 'TCP'} · ${compatibleSqlPolicies[profile.engine].name}`,
        durationMs: Math.round(performance.now() - started),
        lastConnectedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      const stale = this.generations.get(profile.id) !== generation
      if (connection && this.connections.get(profile.id) === connection) await this.disconnect(profile.id)
      else await transport?.close()
      if (stale) return { state: 'disconnected' }
      const result: ConnectionStatus = {
        state: 'failed',
        error: safeError(error, secrets).message,
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, result)
      return result
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private connection(id: string): Connection {
    const value = this.connections.get(id)
    if (!value || value.closed)
      throw new Error('Connection is disconnected. Connect explicitly before continuing.')
    if (value.status.state !== 'connected')
      throw new Error('The product connection is not ready. Reconnect explicitly; no operation was replayed.')
    return value
  }
  private target(connection: Connection, database?: string): void {
    if (database && database !== connection.profile.database)
      throw new Error(
        'This product profile is bound to another database or keyspace. Open a separate profile for that target.',
      )
  }
  private stop(session: Session, message?: string): void {
    session.dead = true
    if (message) session.interrupted = message
    // The pinned MariaDB driver's destroy() opens a second authenticated
    // connection and sends KILL. VTGate rejects it; credentials may also have
    // expired. Own the original wire so cancellation never creates a session.
    if (session.socket && !session.socket.destroyed) {
      // Connector 3.5.4 observes EOF rather than the socket's close event.
      // Notify it before destruction so pending commands reject. Injecting an
      // Error into the lower TCP socket can re-emit on a TLS wrapper after the
      // connector has removed that wrapper's listeners, causing an uncaught error.
      session.socket.emit('end')
      session.socket.destroy()
    }
    if (session.pg) void session.pg.end().catch(() => undefined)
  }
  private async end(session: Session): Promise<void> {
    this.stop(session)
    await session.pg?.end().catch(() => undefined)
  }
  private async createSession(connection: Connection): Promise<Session> {
    const { profile, transport } = connection
    assertCompatibleProfile(profile)
    const session: Session = { dead: false, state: 'idle' }
    try {
      if (compatibleSqlPolicies[profile.engine].dialect === 'postgres') {
        const client = new pg.Client({
          host: transport.host,
          port: transport.port,
          database: profile.database,
          user: profile.username,
          password: connection.secrets.password,
          ssl: transport.tls ?? false,
          connectionTimeoutMillis: profile.connectTimeout,
          application_name: 'Harbor DB',
          types: {
            getTypeParser: (oid: number) =>
              oid === 17 ? pg.types.getTypeParser(17, 'text') : (value: string) => value,
          },
        })
        session.pg = client
        const ended = () => {
          session.dead = true
          if (!connection.closed && connection.sessions.get('_metadata') === session)
            connection.status = {
              state: 'failed',
              error: 'The metadata session ended. Reconnect explicitly; no operation was replayed.',
            }
        }
        client.on('error', ended)
        client.on('end', ended)
        await client.connect()
        const identity = await this.raw(connection, session, 'SELECT version()', [], 1)
        verifyCompatibleProduct(profile.engine, String(identity.rows[0]?.[0] ?? ''))
        await this.raw(connection, session, `SET statement_timeout = ${profile.queryTimeout}`)
        await this.raw(connection, session, "SET TIME ZONE 'UTC'")
        if (profile.schema)
          await this.raw(
            connection,
            session,
            `SET search_path TO ${quoteIdentifier(profile.schema, 'postgres')}`,
          )
        if (profile.readOnly && profile.engine !== 'redshift')
          await this.raw(connection, session, 'SET default_transaction_read_only = on')
      } else {
        const options = {
          host: transport.host,
          port: transport.port,
          database: profile.database,
          user: profile.username,
          password: connection.secrets.password,
          ssl: transport.tls,
          connectTimeout: profile.connectTimeout,
          queryTimeout: 0,
          rowsAsArray: true,
          dateStrings: true,
          autoJsonMap: false,
          jsonStrings: true,
          bigIntAsNumber: false,
          decimalAsNumber: false,
          multipleStatements: false,
          permitLocalInfile: false,
          timezone: '+00:00',
          trace: false,
          logParam: false,
          stream: (callback: (error?: Error, stream?: net.Socket) => void) => {
            if (session.socket) {
              callback(new Error('The product driver attempted to open an unreviewed extra session.'))
              return
            }
            session.socket = net.connect({ host: transport.host, port: transport.port })
            session.socket.setNoDelay(true)
            session.socket.on('error', () => {
              session.dead = true
            })
            callback(undefined, session.socket)
          },
        }
        session.maria = await mariadb.createConnection(options)
        session.maria.on('error', () => {
          session.dead = true
          if (!connection.closed && connection.sessions.get('_metadata') === session)
            connection.status = {
              state: 'failed',
              error: 'The metadata session ended. Reconnect explicitly; no operation was replayed.',
            }
        })
        const identity = await this.raw(connection, session, 'SELECT @@version, @@version_comment', [], 1)
        verifyCompatibleProduct(
          profile.engine,
          String(identity.rows[0]?.[0] ?? ''),
          String(identity.rows[0]?.[1] ?? ''),
        )
        await this.raw(connection, session, "SET time_zone = '+00:00'")
        if (profile.engine === 'tidb') {
          await this.raw(
            connection,
            session,
            `SET SESSION max_execution_time = ${profile.queryTimeout + 500}`,
          )
          // TiDB READ ONLY is a rejected no-op unless a server flag is enabled.
          // Do not enable it or claim enforcement: guarded SQL plus database grants apply.
        }
      }
      if (connection.closed) throw new Error('Connection closed while creating a product session.')
      return session
    } catch (error) {
      await this.end(session)
      throw safeError(error, connection.secrets)
    }
  }
  private async session(connection: Connection, id: string): Promise<Session> {
    const existing = connection.sessions.get(id)
    if (existing) {
      if (existing.dead)
        throw new Error(
          'This product session ended. Reconnect explicitly; no transaction or statement was replayed.',
        )
      return existing
    }
    const pending = connection.creating.get(id)
    if (pending) return pending
    if (connection.closed) throw new Error('Connection is closing.')
    if (connection.sessions.size + connection.creating.size >= MAX_SESSIONS)
      throw new Error('Close unused tabs before opening another product session (limit 16).')
    const creating = this.createSession(connection).then((session) => {
      connection.sessions.set(id, session)
      return session
    })
    connection.creating.set(id, creating)
    try {
      return await creating
    } finally {
      connection.creating.delete(id)
    }
  }
  private async raw(
    connection: Connection,
    session: Session,
    sql: string,
    values: unknown[] = [],
    maxRows = 1000,
  ): Promise<ResultSet> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.rawQuery(session, sql, values, maxRows),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const message =
              'The operation timed out and its session was closed. A write may have reached the server; inspect its outcome before reconnecting. No statement was replayed.'
            this.stop(session, message)
            reject(new Error(message))
          }, connection.profile.queryTimeout)
          timer.unref()
        }),
      ])
    } catch (error) {
      if (session.interrupted) throw new Error(session.interrupted)
      const failure = safeError(error, connection.secrets)
      if (session.dead)
        failure.message +=
          ' The session ended; a write or commit may have reached the server. Inspect the outcome before reconnecting. No operation was replayed.'
      throw failure
    } finally {
      if (timer) clearTimeout(timer)
      state(session)
    }
  }
  private async rawQuery(
    session: Session,
    sql: string,
    values: unknown[],
    maxRows: number,
  ): Promise<ResultSet> {
    const result: ResultSet = { columns: [], rows: [], affectedRows: 0, command: '', truncated: false }
    let bytes = 0
    let conversionError: unknown
    const append = (row: unknown[]) => {
      if (conversionError || result.rows.length >= maxRows || bytes >= MAX_BYTES) {
        result.truncated = true
        return
      }
      try {
        const cells = row.map(cell)
        const size = Buffer.byteLength(JSON.stringify(cells))
        if (bytes + size > MAX_BYTES) {
          result.truncated = true
          bytes = MAX_BYTES
          return
        }
        bytes += size
        result.rows.push(cells)
      } catch (error) {
        conversionError = error
      }
    }
    if (session.pg)
      return new Promise((resolve, reject) => {
        const config: QueryArrayConfig = {
          text: sql,
          values: values.length ? values : undefined,
          rowMode: 'array',
        }
        const query = new pg.Query(config)
        query.on('row', (row: unknown[]) => append(row))
        query.on('end', (response: PgResult) => {
          if (conversionError) {
            reject(conversionError)
            return
          }
          result.columns = columns(response.fields)
          result.command = response.command
          result.affectedRows = response.rowCount ?? 0
          resolve(result)
        })
        query.on('error', (error: Error & { severity?: string }) => {
          if (error.severity !== 'ERROR' || session.dead) {
            reject(error)
            return
          }
          // ErrorResponse precedes ReadyForQuery; do not expose a stale transaction state.
          const wire = (session.pg as unknown as { connection: EventEmitter }).connection
          const finish = () => {
            wire.off('readyForQuery', finish)
            session.pg!.off('end', finish)
            session.pg!.off('error', finish)
            reject(error)
          }
          wire.once('readyForQuery', finish)
          session.pg!.once('end', finish)
          session.pg!.once('error', finish)
        })
        session.pg!.query(query)
      })
    const prepared = values.length ? await session.maria!.prepare({ sql, rowsAsArray: true }) : undefined
    try {
      return await new Promise<ResultSet>((resolve, reject) => {
        const stream = prepared
          ? prepared.executeStream(values)
          : session.maria!.queryStream({ sql, rowsAsArray: true })
        stream.on('fields', (fields: { name: () => string; type: string; flags: number }[]) => {
          result.columns = fields.map((field) => ({
            name: field.name(),
            type: field.type,
            nullable: !(field.flags & 1),
          }))
        })
        stream.on('data', (row: unknown[] | { affectedRows?: number | bigint }) => {
          if (Array.isArray(row)) {
            result.affectedRows++
            append(row)
          } else result.affectedRows = Number(row.affectedRows ?? 0)
        })
        stream.on('error', reject)
        stream.on('end', () => {
          result.command = sql.trim().split(/\s/)[0].toUpperCase()
          if (conversionError) reject(conversionError)
          else resolve(result)
        })
      })
    } finally {
      await prepared?.close()
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    assertTab(input.sessionId)
    const connection = this.connection(input.connectionId)
    this.target(connection, input.database)
    const { profile } = connection
    const policy = compatibleSqlPolicies[profile.engine]
    const safety = compatibleQuerySafety(profile.engine, input.sql)
    if (profile.readOnly && !safety.readOnly)
      throw new Error(
        'Guarded browsing accepts read-only statements only. Use a restricted database role as the security boundary.',
      )
    const confirmation = requiredSqlConfirmation(input.sql, policy.dialect, profile)
    if (confirmation !== undefined && input.confirm !== confirmation)
      throw new Error(`Type ${confirmation} to confirm this operation.`)
    const values = parameters(profile, input.parameters)
    const session = await this.session(connection, input.sessionId)
    if (session.busy) throw new Error('This tab already has an operation in progress.')
    session.busy = input.requestId
    const started = performance.now()
    try {
      const result = await this.raw(connection, session, input.sql, values, input.maxRows)
      return {
        requestId: input.requestId,
        sets: [result],
        durationMs: Math.round(performance.now() - started),
        transaction: state(session),
        messages: [
          policy.limitation,
          ...(profile.readOnly
            ? [
                'Guarded query checks supplement database permissions; use a read-only role for an authorization boundary.',
              ]
            : []),
        ],
      }
    } catch (error) {
      const message = redactParameterError(safeError(error, connection.secrets).message, input.parameters)
      throw new Error(
        message +
          (session.dead
            ? ' The session ended; inspect the server outcome before reconnecting. No statement was replayed.'
            : ''),
      )
    } finally {
      session.busy = undefined
    }
  }
  async transaction(input: Parameters<HarborAPI['transaction']>[0]): ReturnType<HarborAPI['transaction']> {
    assertTab(input.sessionId)
    const connection = this.connection(input.connectionId)
    this.target(connection, input.database)
    if (!compatibleSqlPolicies[connection.profile.engine].transactions)
      throw new Error('Explicit transactions are unavailable for this product scope.')
    const session = await this.session(connection, input.sessionId)
    if (session.busy) throw new Error('Wait for this tab’s current operation.')
    const current = state(session)
    if (input.action === 'begin' && current !== 'idle')
      throw new Error('This tab already has an open or failed transaction.')
    if (input.action === 'commit' && current === 'failed')
      throw new Error('The transaction failed. Roll back explicitly before starting again.')
    session.busy = `transaction:${input.action}`
    try {
      await this.raw(
        connection,
        session,
        input.action === 'begin' ? 'BEGIN' : input.action === 'commit' ? 'COMMIT' : 'ROLLBACK',
      )
      return { state: state(session) }
    } finally {
      session.busy = undefined
    }
  }
  getSessionState(input: {
    connectionId: string
    sessionId: string
  }): Awaited<ReturnType<HarborAPI['getSessionState']>> {
    assertTab(input.sessionId)
    const connection = this.connections.get(input.connectionId),
      session = connection?.sessions.get(input.sessionId)
    return {
      state: session && !session.dead ? state(session) : 'idle',
      connected:
        !!connection &&
        connection.status.state === 'connected' &&
        !connection.closed &&
        (!session || !session.dead),
      running: !!session?.busy,
    }
  }
  async cancel(input: Parameters<HarborAPI['cancel']>[0]): ReturnType<HarborAPI['cancel']> {
    assertTab(input.sessionId)
    const session = this.connections.get(input.connectionId)?.sessions.get(input.sessionId)
    if (!session || session.busy !== input.requestId)
      return { requested: false, message: 'That request is no longer running.' }
    this.stop(
      session,
      'Cancellation closed this tab’s session. A write may have reached the server. Inspect its outcome before reconnecting; no statement was replayed.',
    )
    return {
      requested: true,
      message:
        'The client session was closed. Server rollback or cancellation is not confirmed; inspect the outcome before reconnecting.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    assertTab(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    if (!connection) return
    await connection.creating.get(input.sessionId)?.catch(() => undefined)
    const session = connection.sessions.get(input.sessionId)
    if (session) {
      await this.end(session)
      connection.sessions.delete(input.sessionId)
    }
  }
  private async metadata<T>(connection: Connection, operation: (session: Session) => Promise<T>): Promise<T> {
    const run = connection.metadataQueue
      .catch(() => undefined)
      .then(async () => operation(await this.session(connection, '_metadata')))
    connection.metadataQueue = run
    return run
  }
  async listDatabases(id: string): Promise<string[]> {
    return [this.connection(id).profile.database]
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const connection = this.connection(input.connectionId)
    this.target(connection, input.database)
    return this.metadata(connection, async (session) => {
      const { profile } = connection,
        mysql = compatibleSqlPolicies[profile.engine].dialect === 'mysql'
      const schema = mysql ? profile.database : input.schema
      if (mysql && input.schema && input.schema !== profile.database)
        throw new Error('Select objects only from this profile’s database or keyspace.')
      const source = profile.engine === 'redshift' ? 'svv_tables' : 'information_schema.tables'
      const sql = `SELECT table_schema,table_name,table_type FROM ${source} WHERE ${profile.engine === 'redshift' ? 'table_catalog = current_database() AND ' : ''}${schema ? `table_schema = ${mysql ? '?' : '$1'}` : "table_schema NOT IN ('pg_catalog','information_schema','crdb_internal')"} ORDER BY table_schema,table_name LIMIT 1001`
      const result = await this.raw(connection, session, sql, schema ? [schema] : [], 1001)
      if (result.rows.length > 1000 || result.truncated)
        throw new Error('Catalog exceeds 1,000 objects. Select a narrower schema before browsing.')
      return result.rows.map((row) => ({
        // VTGate rewrites the keyspace predicate to a physical shard schema,
        // whose name must not become a new user-selectable routing context.
        schema: mysql ? profile.database : String(row[0]),
        name: String(row[1]),
        database: profile.database,
        kind: /view/i.test(String(row[2])) ? 'view' : 'table',
      }))
    })
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const connection = this.connection(input.connectionId)
    this.target(connection, input.database)
    return this.metadata(connection, async (session) => {
      const mysql = compatibleSqlPolicies[connection.profile.engine].dialect === 'mysql'
      if (mysql && input.schema !== connection.profile.database)
        throw new Error('Select a table in the bound database or keyspace.')
      const source = connection.profile.engine === 'redshift' ? 'svv_columns' : 'information_schema.columns'
      const types = mysql ? 'column_type' : 'data_type'
      const result = await this.raw(
        connection,
        session,
        `SELECT column_name,${types},is_nullable,column_default,numeric_precision,numeric_scale,character_maximum_length FROM ${source} WHERE ${connection.profile.engine === 'redshift' ? 'table_catalog = current_database() AND ' : ''}table_schema=${mysql ? '?' : '$1'} AND table_name=${mysql ? '?' : '$2'} ORDER BY ordinal_position LIMIT 501`,
        [input.schema, input.table],
        501,
      )
      if (result.rows.length > 500 || result.truncated)
        throw new Error('This table exceeds the 500-column inspection limit.')
      if (!result.rows.length)
        throw new Error('No visible columns were found; check the selected target and permissions.')
      const structure: TableStructure = {
        columns: result.rows.map((row) => ({
          name: String(row[0]),
          type:
            !mysql && /^(numeric|decimal)$/i.test(String(row[1])) && row[4] !== null
              ? `${row[1]}(${row[4]},${row[5] ?? 0})`
              : String(row[1]),
          nullable: row[2] === 'YES',
          defaultValue: row[3] === null ? null : String(row[3]),
          primaryKey: false,
        })),
        indexes: [],
        constraints: [],
        ddl: '-- Product-specific table reconstruction and constraint/index inspection are unavailable in this initial scope.\n-- Empty index and constraint lists mean not inspected, not absent.',
      }
      return structure
    })
  }
  async table(input: TableInput): Promise<QueryResult> {
    const connection = this.connection(input.connectionId)
    const structure = await this.structure(input)
    const query = buildTableQuery(input, structure, compatibleSqlPolicies[connection.profile.engine].dialect)
    const result = await this.execute({
      connectionId: input.connectionId,
      database: input.database,
      sessionId: input.sessionId,
      requestId: randomUUID(),
      sql: query.sql,
      maxRows: input.limit,
      privateSession: false,
      parameters: query.parameters.map((value, index) => ({
        name: `table_${index}`,
        type: typeof value === 'number' ? 'integer' : 'text',
        value: String(value),
        secret: false,
      })),
    })
    return { ...result, tableQuery: query }
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const connection = this.connection(input.connectionId)
    this.target(connection, input.database)
    const safety = compatibleQuerySafety(connection.profile.engine, input.sql)
    if (!safety.readOnly) throw new Error('Export requires one explicit read-only statement.')
    if (sink.signal.aborted) throw new Error('Export cancelled before opening a session.')
    const values = parameters(connection.profile, input.parameters)
    const id = `_export:${randomUUID()}`
    let session: Session | undefined
    let cursor: PgCursor<unknown[]> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure = ''
    const abort = () => {
      failure ||= 'Export cancelled; partial output was not finalized.'
      if (session) this.stop(session, failure)
    }
    const interrupted = () => {
      if (failure || sink.signal.aborted || session?.dead)
        throw new Error(failure || 'The export session ended; partial output was not finalized.')
    }
    const emit = async (row: unknown[]) => {
      interrupted()
      const cells = row.map(cell)
      if (Buffer.byteLength(JSON.stringify(cells)) > MAX_BYTES)
        throw new Error('An export row exceeds 8 MiB. Partial output was not finalized.')
      await sink.onRow(cells)
      interrupted()
    }
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      session = await this.session(connection, id)
      interrupted()
      timer = setTimeout(() => {
        failure = 'Export timed out; partial output was not finalized.'
        abort()
      }, connection.profile.queryTimeout)
      timer.unref()
      if (session.pg) {
        await this.raw(
          connection,
          session,
          connection.profile.engine === 'redshift' ? 'BEGIN' : 'BEGIN READ ONLY',
        )
        cursor = session.pg.query(new PgCursor<unknown[]>(input.sql, values, { rowMode: 'array' }))
        // Read one row at a time so an allowed large row cannot multiply into an unbounded batch.
        let announced = false
        while (true) {
          interrupted()
          const batch = await new Promise<{ rows: unknown[][]; fields: PgResult['fields'] }>(
            (resolve, reject) => {
              const ended = () => reject(new Error('The export session ended.'))
              session!.pg!.once('end', ended)
              cursor!.read(1, (error, rows, result) => {
                session!.pg!.off('end', ended)
                if (error) reject(error)
                else resolve({ rows, fields: result.fields })
              })
            },
          )
          if (!announced) {
            await sink.onColumns(columns(batch.fields))
            announced = true
          }
          if (!batch.rows.length) break
          await emit(batch.rows[0])
        }
        await cursor.close()
        cursor = undefined
        await this.raw(connection, session, 'ROLLBACK')
      } else {
        if (connection.profile.engine === 'tidb') await this.raw(connection, session, 'START TRANSACTION')
        const prepared = values.length
          ? await session.maria!.prepare({ sql: input.sql, rowsAsArray: true })
          : undefined
        try {
          const stream = prepared
            ? prepared.executeStream(values)
            : session.maria!.queryStream({ sql: input.sql, rowsAsArray: true })
          let announced: Promise<void> = Promise.resolve()
          stream.once('fields', (fields: { name: () => string; type: string }[]) => {
            stream.pause()
            announced = sink.onColumns(fields.map((field) => ({ name: field.name(), type: field.type })))
            void announced.then(
              () => stream.resume(),
              () => stream.destroy(new Error('Export column consumer failed.')),
            )
          })
          for await (const row of stream) {
            await announced
            if (Array.isArray(row)) await emit(row)
          }
          await announced
          interrupted()
        } finally {
          await prepared?.close()
        }
        if (connection.profile.engine === 'tidb') await this.raw(connection, session, 'ROLLBACK')
      }
      interrupted()
    } catch (error) {
      throw new Error(
        redactParameterError(failure || safeError(error, connection.secrets).message, input.parameters),
      )
    } finally {
      if (timer) clearTimeout(timer)
      sink.signal.removeEventListener('abort', abort)
      if (session) await this.end(session)
      connection.sessions.delete(id)
    }
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    connection.closed = true
    for (const session of connection.sessions.values())
      this.stop(
        session,
        'The connection closed. Inspect any write outcome before reconnecting; no statement was replayed.',
      )
    await Promise.allSettled(connection.creating.values())
    await Promise.allSettled([...connection.sessions.values()].map((session) => this.end(session)))
    connection.sessions.clear()
    connection.secrets = {}
    await connection.transport.close()
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
