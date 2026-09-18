import { assertManagedSession } from '../../shared/managed-deployment'
import { randomUUID } from 'node:crypto'
import { Connection as DriverConnection, Request, TYPES, type ConnectionConfiguration } from 'tedious'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  EditsInput,
  ForeignKeyInfo,
  ObjectInfo,
  QueryInput,
  QueryResult,
  ResultColumn,
  ResultSet,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import { redactParameterError } from '../../shared/parameters'
import { openTransport, type Transport } from './transport'
import type { QueryStreamSink, StreamQueryInput } from './sql'
import {
  cellParameter,
  losslessBatch,
  mssqlCell,
  mssqlConfirmation,
  mssqlDeclarations,
  mssqlLiteral,
  mssqlParameters,
  mssqlQuote,
  mssqlSafety,
  mssqlVisible,
  type DescribedColumn,
  type MssqlParameter,
} from './mssql-values'

type State = 'idle' | 'open' | 'failed'
interface Session {
  db: DriverConnection
  database: string
  state: State
  dead: boolean
  busy?: string
  request?: Request
  closed: Promise<void>
}
interface Connection {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  sessions: Map<string, Session>
  creating: Map<string, Promise<Session>>
  metadataQueues: Map<string, Promise<void>>
  closed: boolean
  status: ConnectionStatus
}
interface NativeOptions {
  columns?: ResultColumn[]
  maxRows?: number
  sink?: QueryStreamSink
  batch?: boolean
}
function assertSession(id: string): void {
  if (!id || id.startsWith('_'))
    throw new Error('Session identifiers beginning with an underscore are reserved.')
}
function databaseName(connection: Connection, database?: string): string {
  const value = database || connection.profile.database || 'master'
  if (value.includes('\0') || value.length > 128) throw new Error('Invalid SQL Server database name.')
  return value
}
function values(set: ResultSet): Record<string, Cell>[] {
  return set.rows.map((row) =>
    Object.fromEntries(set.columns.map((column, index) => [column.name, row[index]])),
  )
}
function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((error) => errorMessage(error)).join('; ')
  return error instanceof Error ? error.message : 'SQL Server operation failed.'
}
function tableProjection(structure: TableStructure): string {
  return structure.columns
    .map((column) => {
      const name = mssqlQuote(column.name)
      const type = column.type.toLowerCase().split('(')[0]
      if (['money', 'smallmoney', 'datetime', 'smalldatetime'].includes(type))
        return `CONVERT(nvarchar(max),${name},${type.includes('money') ? 2 : 126}) AS ${name}`
      return name
    })
    .join(',')
}

/** SQL authentication over asynchronous TDS. Each tab has a dedicated connection. */
export class MssqlService {
  private connections = new Map<string, Connection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()

  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (String(profile.engine) !== 'mssql')
      throw new Error('Use the matching engine adapter for this profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let transport: Transport | undefined
    let connection: Connection | undefined
    try {
      if (!profile.username) throw new Error('SQL Server SQL authentication requires a username.')
      transport = await openTransport(profile, secrets)
      connection = {
        profile,
        secrets,
        transport,
        sessions: new Map(),
        creating: new Map(),
        metadataQueues: new Map(),
        closed: false,
        status: { state: 'connecting' },
      }
      if (this.generations.get(profile.id) !== generation) {
        await transport.close()
        return { state: 'disconnected' }
      }
      this.connections.set(profile.id, connection)
      const metadata = await this.session(connection, '_metadata', undefined)
      const result = await this.records(
        metadata,
        "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS version",
      )
      if (connection.closed || this.generations.get(profile.id) !== generation)
        return { state: 'disconnected' }
      connection.status = {
        state: 'connected',
        version: `SQL Server ${result[0].version}`,
        transport: `${profile.ssh.enabled ? 'SSH tunnel + ' : ''}${profile.tls.enabled ? 'TLS' : 'TCP (TLS not required)'}`,
        durationMs: Math.round(performance.now() - started),
        lastConnectedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      const stale = this.generations.get(profile.id) !== generation
      if (connection && this.connections.get(profile.id) === connection) await this.disconnect(profile.id)
      else if (connection) {
        connection.closed = true
        await Promise.allSettled(connection.creating.values())
        await Promise.allSettled([...connection.sessions.values()].map((session) => this.end(session)))
        await connection.transport.close()
      } else await transport?.close()
      if (stale) return { state: 'disconnected' }
      const status: ConnectionStatus = {
        state: 'failed',
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
        lastConnectedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private connection(id: string): Connection {
    const result = this.connections.get(id)
    if (!result || result.closed)
      throw new Error('SQL Server is disconnected. Connect explicitly before continuing.')
    return result
  }
  private async session(connection: Connection, id: string, database?: string): Promise<Session> {
    const target = databaseName(connection, database)
    const existing = connection.sessions.get(id)
    if (existing) {
      if (existing.dead)
        throw new Error(
          'This SQL Server tab session ended. Reconnect explicitly; no statements were replayed.',
        )
      if (existing.database !== target)
        throw new Error(
          'This tab is bound to another database. Close it or open a new tab before changing databases.',
        )
      return existing
    }
    const pending = connection.creating.get(id)
    if (pending) return pending
    if (connection.closed) throw new Error('SQL Server connection is closing.')
    if (connection.sessions.size + connection.creating.size >= 32)
      throw new Error('Close unused tabs before opening another SQL Server session.')
    const creating = (async () => {
      const { profile, transport } = connection
      assertManagedSession(profile, target)
      const config: ConnectionConfiguration = {
        server: transport.host,
        authentication: {
          type: 'default',
          options: { userName: profile.username, password: connection.secrets.password },
        },
        options: {
          port: transport.port,
          database: target,
          encrypt: profile.tls.enabled,
          trustServerCertificate: !profile.tls.rejectUnauthorized,
          serverName: profile.host,
          cryptoCredentialsDetails: {
            ca: transport.tls?.ca,
            cert: transport.tls?.cert,
            key: transport.tls?.key,
            minVersion: 'TLSv1.2',
          },
          connectTimeout: profile.connectTimeout,
          requestTimeout: profile.queryTimeout,
          cancelTimeout: 5000,
          maxRetriesOnTransientErrors: 0,
          rowCollectionOnDone: false,
          rowCollectionOnRequestCompletion: false,
          useColumnNames: false,
          useUTC: true,
          appName: 'Harbor DB',
          workstationId: 'Harbor DB',
          // Intent affects Availability Group routing; permissions and Harbor guards
          // enforce the actual allowed operations. It is not a read-only database role.
          readOnlyIntent: profile.readOnly,
        },
      }
      const db = new DriverConnection(config)
      const current: Session = {
        db,
        database: target,
        state: 'idle',
        dead: false,
        closed: new Promise((done) => db.once('end', done)),
      }
      db.on('error', () => {
        current.dead = true
      })
      db.once('end', () => {
        current.dead = true
        current.state = 'idle'
      })
      try {
        await new Promise<void>((done, reject) => {
          db.once('connect', (error) => (error ? reject(error) : done()))
          db.connect()
        })
        if (connection.closed) throw new Error('SQL Server connection closed during startup.')
        connection.sessions.set(id, current)
        return current
      } catch (error) {
        db.close()
        await current.closed
        throw error
      }
    })().finally(() => connection.creating.delete(id))
    connection.creating.set(id, creating)
    return creating
  }
  private async native(
    session: Session,
    sql: string,
    parameters: MssqlParameter[] = [],
    options: NativeOptions = {},
  ): Promise<ResultSet[]> {
    if (session.dead) throw new Error('SQL Server session ended; write outcomes may be uncertain.')
    if (session.request) throw new Error('This SQL Server session already has a running request.')
    const sets: ResultSet[] = []
    let active: ResultSet | undefined
    let failure: Error | undefined
    let retained = 0
    let bytes = 0
    let callbacks = Promise.resolve()
    return new Promise<ResultSet[]>((resolve, reject) => {
      const ended = () =>
        finish(
          new Error('SQL Server disconnected during the request. Inspect write outcomes before retrying.'),
        )
      let finished = false
      const finish = (error?: Error | null) => {
        if (finished) return
        finished = true
        session.db.off('end', ended)
        session.request = undefined
        void callbacks.then(() => {
          if (failure || error) reject(failure || error)
          else resolve(sets)
        }, reject)
      }
      const request = new Request(sql, (error) => finish(error))
      session.request = request
      session.db.once('end', ended)
      const fail = (error: unknown) => {
        failure ||= error instanceof Error ? error : new Error(errorMessage(error))
        request.cancel()
        request.resume()
      }
      const consume = (callback: () => Promise<void>) => {
        request.pause()
        callbacks = callbacks
          .then(async () => {
            if (failure || options.sink?.signal.aborted)
              throw failure || new Error('Export cancelled. Partial output was not finalized.')
            await callback()
            if (options.sink?.signal.aborted)
              throw new Error('Export cancelled. Partial output was not finalized.')
          })
          .then(() => request.resume(), fail)
      }
      request.on('error', fail)
      request.on('columnMetadata', (metadata) => {
        try {
          if (!Array.isArray(metadata)) throw new Error('SQL Server returned unexpected named-column mode.')
          if (options.columns && sets.some((set) => set.columns.length))
            throw new Error(
              'The statement returned more result sets than its described shape; no lossy fallback is allowed.',
            )
          if (options.columns && options.columns.length !== metadata.length)
            throw new Error(
              'SQL Server result schema changed after description. Run the query again explicitly.',
            )
          active = {
            columns:
              options.columns || metadata.map((column) => ({ name: column.colName, type: column.type.name })),
            rows: [],
            command: 'RESULT',
            affectedRows: 0,
            truncated: false,
          }
          sets.push(active)
          if (sets.length > 100) throw new Error('At most 100 result sets are supported per request.')
          if (options.sink) {
            const columns = active.columns
            consume(() => options.sink!.onColumns(columns))
          }
        } catch (error) {
          fail(error)
        }
      })
      request.on('row', (columns) => {
        if (failure) return
        try {
          if (!Array.isArray(columns) || !active)
            throw new Error('SQL Server row arrived without ordered metadata.')
          active.affectedRows++
          if (!options.sink && (retained >= (options.maxRows ?? 10000) || bytes >= 8 * 1024 * 1024)) {
            active.truncated = true
            return
          }
          const row = columns.map((column) => mssqlCell(column.value, column.metadata.type.name))
          const size = Buffer.byteLength(JSON.stringify(row))
          if (options.sink) {
            if (size > 8 * 1024 * 1024)
              throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
            consume(() => options.sink!.onRow(row))
          } else if (bytes + size > 8 * 1024 * 1024) active.truncated = true
          else {
            active.rows.push(row)
            bytes += size
            retained++
          }
        } catch (error) {
          fail(error)
        }
      })
      const done = (count: number | undefined) => {
        if (active) {
          active = undefined
        } else if (count !== undefined)
          sets.push({ columns: [], rows: [], affectedRows: count, command: 'COMMAND', truncated: false })
      }
      request.on('done', done)
      request.on('doneInProc', done)
      try {
        for (const parameter of parameters)
          request.addParameter(
            parameter.name,
            Buffer.isBuffer(parameter.value)
              ? TYPES.VarBinary
              : typeof parameter.value === 'boolean'
                ? TYPES.Bit
                : TYPES.NVarChar,
            parameter.value,
            { length: Infinity },
          )
        if (options.batch && !parameters.length) session.db.execSqlBatch(request)
        else session.db.execSql(request)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(errorMessage(error)))
      }
    })
  }
  private async records(
    session: Session,
    sql: string,
    parameters: MssqlParameter[] = [],
  ): Promise<Record<string, Cell>[]> {
    const sets = await this.native(session, sql, parameters)
    return sets.filter((set) => set.columns.length).flatMap(values)
  }
  private async refreshState(session: Session): Promise<void> {
    if (session.dead) {
      session.state = 'idle'
      return
    }
    const state = await this.records(session, 'SELECT XACT_STATE() AS state, @@TRANCOUNT AS depth')
    session.state = Number(state[0].state) === -1 ? 'failed' : Number(state[0].depth) > 0 ? 'open' : 'idle'
  }
  private async described(
    session: Session,
    sql: string,
    parameters: MssqlParameter[],
  ): Promise<DescribedColumn[]> {
    const result = await this.records(
      session,
      'EXEC sys.sp_describe_first_result_set @tsql=@sql, @params=@parameters, @browse_information_mode=0',
      [cellParameter('sql', sql), cellParameter('parameters', mssqlDeclarations(parameters))],
    )
    return result
      .filter((row) => !row.is_hidden)
      .map((row) => {
        if (!row.system_type_name)
          throw new Error(
            'This result shape cannot be transported losslessly. Explicitly CONVERT custom values in the query.',
          )
        return {
          name: row.name === null ? '' : String(row.name),
          type: String(row.system_type_name),
          nullable: !!row.is_nullable,
        }
      })
  }
  private async executeNative(
    session: Session,
    sql: string,
    parameters: MssqlParameter[],
    maxRows: number,
    sink?: QueryStreamSink,
  ): Promise<ResultSet[]> {
    const safety = mssqlSafety(sql)
    if (safety.readOnly && safety.statementCount === 1) {
      const columns = await this.described(session, sql, parameters)
      if (!columns.length) throw new Error('The SELECT did not describe a result set.')
      const wrapped = losslessBatch(sql, parameters, columns)
      return this.native(session, wrapped.sql, wrapped.parameters, {
        maxRows,
        columns: wrapped.columns,
        sink,
      })
    }
    if (parameters.length) {
      const wrapped = losslessBatch(sql, parameters)
      return this.native(session, wrapped.sql, wrapped.parameters, { maxRows })
    }
    return this.native(session, sql, [], { maxRows, batch: true })
  }
  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: State
    connected: boolean
    running: boolean
  } {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    const session = connection?.sessions.get(input.sessionId)
    return {
      state: session?.state || 'idle',
      connected: !!connection && !connection.closed && !session?.dead,
      running: !!session?.busy || !!connection?.creating.has(input.sessionId),
    }
  }
  private claim(session: Session, id: string): void {
    if (session.busy) throw new Error('This tab already has a running operation.')
    if (session.dead) throw new Error('This SQL Server session ended. Reconnect before continuing.')
    session.busy = id
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const safety = mssqlSafety(input.sql)
    if (/\bUSE\b/i.test(mssqlVisible(input.sql)))
      throw new Error(
        'Choose a database in the tab controls and open a new tab; USE cannot silently change this tab’s database context.',
      )
    if (connection.profile.readOnly && (!safety.readOnly || safety.controlsTransaction))
      throw new Error('This connection is read-only. Use the dedicated transaction controls.')
    if (safety.statementCount > 100) throw new Error('A request supports at most 100 statements.')
    const confirmation = mssqlConfirmation(input.sql, connection.profile)
    if (!connection.profile.readOnly && confirmation && confirmation !== input.confirm)
      throw new Error(`Type "${confirmation}" to confirm this operation on ${connection.profile.name}.`)
    const parameters = mssqlParameters(input.parameters)
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, input.requestId)
    const started = performance.now()
    try {
      const sets = await this.executeNative(session, input.sql, parameters, input.maxRows)
      await this.refreshState(session)
      return {
        requestId: input.requestId,
        sets,
        durationMs: Math.round(performance.now() - started),
        transaction: session.state,
        messages: [
          'A single describable SELECT converts exact values on the server before TDS decoding; original ordered result metadata is preserved. Scripts containing unsupported raw exact types fail rather than silently round values. Display retains at most the requested rows and 8 MiB.',
        ],
      }
    } catch (error) {
      await this.refreshState(session).catch(() => {
        session.dead = true
      })
      if ((error as { code?: string }).code === 'ECANCEL')
        return {
          requestId: input.requestId,
          sets: [],
          durationMs: Math.round(performance.now() - started),
          transaction: session.state,
          cancelled: true,
          messages: [
            'SQL Server acknowledged request cancellation. Earlier committed statements may have completed. Review and roll back any open transaction; nothing was replayed.',
          ],
        }
      throw new Error(redactParameterError(errorMessage(error), input.parameters))
    } finally {
      session.busy = undefined
    }
  }
  private async metadata<T>(
    id: string,
    database: string | undefined,
    action: (session: Session) => Promise<T>,
  ): Promise<T> {
    const connection = this.connection(id)
    const target = databaseName(connection, database)
    const previous = connection.metadataQueues.get(target) || Promise.resolve()
    let release!: () => void
    const own = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = previous.then(() => own)
    connection.metadataQueues.set(target, pending)
    await previous
    try {
      if (connection.closed) throw new Error('SQL Server is disconnected.')
      const session = await this.session(connection, `_metadata:${target}`, target)
      this.claim(session, randomUUID())
      try {
        return await action(session)
      } finally {
        session.busy = undefined
      }
    } finally {
      release()
      if (connection.metadataQueues.get(target) === pending) connection.metadataQueues.delete(target)
    }
  }
  async listDatabases(id: string): Promise<string[]> {
    return this.metadata(id, undefined, async (session) =>
      (
        await this.records(
          session,
          'SELECT name FROM sys.databases WHERE state=0 AND HAS_DBACCESS(name)=1 ORDER BY name',
        )
      ).map((row) => String(row.name)),
    )
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    return this.metadata(input.connectionId, input.database, async (session) =>
      (
        await this.records(
          session,
          "SELECT s.name AS schema_name,o.name,o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 AND o.type IN ('U','V','FN','IF','TF','SO','TR') AND (@schema IS NULL OR s.name=@schema) ORDER BY s.name,o.type,o.name",
          [cellParameter('schema', input.schema || null)],
        )
      ).map((row) => ({
        schema: String(row.schema_name),
        name: String(row.name),
        kind:
          String(row.type).trim() === 'U'
            ? 'table'
            : String(row.type).trim() === 'V'
              ? 'view'
              : String(row.type).trim() === 'SO'
                ? 'sequence'
                : String(row.type).trim() === 'TR'
                  ? 'trigger'
                  : 'function',
      })),
    )
  }
  private async tableStructure(session: Session, schema: string, table: string): Promise<TableStructure> {
    const name = `${mssqlQuote(schema)}.${mssqlQuote(table)}`
    const parameters = [cellParameter('object', name)]
    const objects = await this.records(
      session,
      'SELECT type,OBJECT_DEFINITION(object_id) AS definition FROM sys.objects WHERE object_id=OBJECT_ID(@object)',
      parameters,
    )
    if (!objects.length)
      throw new Error('The table or view is unavailable; refresh the catalog or check metadata permissions.')
    const columns = await this.records(
      session,
      'SELECT c.name,t.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,dc.definition AS default_value,pk.key_ordinal FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id LEFT JOIN (SELECT ic.object_id,ic.column_id,ic.key_ordinal FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id WHERE i.is_primary_key=1) pk ON pk.object_id=c.object_id AND pk.column_id=c.column_id WHERE c.object_id=OBJECT_ID(@object) ORDER BY c.column_id',
      parameters,
    )
    const type = (column: Record<string, Cell>) => {
      const name = String(column.type)
      if (['decimal', 'numeric'].includes(name)) return `${name}(${column.precision},${column.scale})`
      if (['datetime2', 'datetimeoffset', 'time'].includes(name)) return `${name}(${column.scale})`
      if (['varchar', 'char', 'nvarchar', 'nchar', 'varbinary', 'binary'].includes(name))
        return `${name}(${Number(column.max_length) === -1 ? 'max' : Number(column.max_length) / (name.startsWith('n') ? 2 : 1)})`
      return name
    }
    const indexes = await this.records(
      session,
      'SELECT i.name,i.type_desc,i.is_unique,c.name AS column_name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column,i.filter_definition FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE i.object_id=OBJECT_ID(@object) AND i.name IS NOT NULL ORDER BY i.index_id,ic.key_ordinal,ic.index_column_id',
      parameters,
    )
    const grouped = new Map<string, Record<string, Cell>[]>()
    for (const index of indexes)
      grouped.set(String(index.name), [...(grouped.get(String(index.name)) || []), index])
    const foreign = await this.records(
      session,
      'SELECT fk.name,fkc.constraint_column_id,c.name AS source_column,rs.name AS target_schema,rt.name AS target_table,rc.name AS target_column,fk.update_referential_action_desc AS on_update,fk.delete_referential_action_desc AS on_delete FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.columns c ON c.object_id=fkc.parent_object_id AND c.column_id=fkc.parent_column_id JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id WHERE fk.parent_object_id=OBJECT_ID(@object) ORDER BY fk.object_id,fkc.constraint_column_id',
      parameters,
    )
    const keys = new Map<string, ForeignKeyInfo>()
    for (const row of foreign) {
      const key = keys.get(String(row.name)) || {
        name: String(row.name),
        columns: [],
        referencedSchema: String(row.target_schema),
        referencedTable: String(row.target_table),
        referencedColumns: [],
        onUpdate: String(row.on_update).replaceAll('_', ' '),
        onDelete: String(row.on_delete).replaceAll('_', ' '),
      }
      key.columns.push(String(row.source_column))
      key.referencedColumns.push(String(row.target_column))
      keys.set(key.name, key)
    }
    const constraints = await this.records(
      session,
      'SELECT name,definition FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(@object)',
      parameters,
    )
    const keyConstraints = await this.records(
      session,
      'SELECT kc.name,kc.type,i.type_desc,c.name AS column_name,ic.is_descending_key FROM sys.key_constraints kc JOIN sys.indexes i ON i.object_id=kc.parent_object_id AND i.index_id=kc.unique_index_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE kc.parent_object_id=OBJECT_ID(@object) AND ic.key_ordinal>0 ORDER BY kc.object_id,ic.key_ordinal',
      parameters,
    )
    const constraintKeys = new Map<string, Record<string, Cell>[]>()
    for (const row of keyConstraints)
      constraintKeys.set(String(row.name), [...(constraintKeys.get(String(row.name)) || []), row])
    const descriptions = columns.map((column) => ({
      name: String(column.name),
      type: type(column),
      nullable: !!column.is_nullable,
      defaultValue: column.default_value === null ? null : String(column.default_value),
      primaryKey: Number(column.key_ordinal) > 0,
      ...(Number(column.key_ordinal) > 0 ? { primaryKeyPosition: Number(column.key_ordinal) } : {}),
    }))
    const indexDefinitions = [...grouped].map(([indexName, items]) => ({
      name: indexName,
      definition: `${items[0].is_unique ? 'UNIQUE ' : ''}${items[0].type_desc} INDEX ${mssqlQuote(indexName)} ON ${name} (${items
        .filter((item) => !item.is_included_column)
        .map((item) => `${mssqlQuote(String(item.column_name))}${item.is_descending_key ? ' DESC' : ' ASC'}`)
        .join(', ')})${
        items.some((item) => item.is_included_column)
          ? ` INCLUDE (${items
              .filter((item) => item.is_included_column)
              .map((item) => mssqlQuote(String(item.column_name)))
              .join(', ')})`
          : ''
      }${items[0].filter_definition ? ` WHERE ${items[0].filter_definition}` : ''}`,
    }))
    return {
      columns: descriptions,
      indexes: indexDefinitions,
      constraints: [
        ...constraints.map((row) => ({ name: String(row.name), definition: `CHECK ${row.definition}` })),
        ...[...constraintKeys].map(([keyName, rows]) => ({
          name: keyName,
          definition: `${rows[0].type === 'PK' ? 'PRIMARY KEY' : 'UNIQUE'} ${rows[0].type_desc} (${rows.map((row) => `${mssqlQuote(String(row.column_name))}${row.is_descending_key ? ' DESC' : ' ASC'}`).join(', ')})`,
        })),
        ...[...keys.values()].map((key) => ({
          name: key.name,
          definition: `FOREIGN KEY (${key.columns.map(mssqlQuote).join(', ')}) REFERENCES ${mssqlQuote(key.referencedSchema)}.${mssqlQuote(key.referencedTable)} (${key.referencedColumns.map(mssqlQuote).join(', ')}) ON UPDATE ${key.onUpdate} ON DELETE ${key.onDelete}`,
        })),
      ],
      foreignKeys: [...keys.values()],
      ddl: objects[0].definition
        ? String(objects[0].definition)
        : `-- Reconstructed column outline; not a complete migration (identity, computed expressions, constraints and table options require inspection).\nCREATE TABLE ${name} (\n${descriptions.map((column) => `  ${mssqlQuote(column.name)} ${column.type}${column.nullable ? ' NULL' : ' NOT NULL'}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ''}`).join(',\n')}\n);`,
    }
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    return this.metadata(input.connectionId, input.database, (session) =>
      this.tableStructure(session, input.schema, input.table),
    )
  }
  async table(input: TableInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const structure = await this.structure(input)
    const columns = new Set(structure.columns.map((column) => column.name))
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10000
    )
      throw new Error('Invalid table page limits.')
    const keys = structure.columns
      .filter((column) => column.primaryKey)
      .sort((a, b) => (a.primaryKeyPosition || 0) - (b.primaryKeyPosition || 0))
      .map((column) => column.name)
    const sorts =
      input.sorts ?? (input.sort ? [{ column: input.sort, direction: input.direction || 'asc' }] : [])
    if (
      sorts.length > 8 ||
      sorts.some((sort) => !columns.has(sort.column) || !['asc', 'desc'].includes(sort.direction))
    )
      throw new Error('A sort column is missing or the sort limit was exceeded.')
    if (new Set(sorts.map((sort) => sort.column)).size !== sorts.length)
      throw new Error('Each sort column must occur once.')
    const order = [
      ...sorts,
      ...keys
        .filter((key) => !sorts.some((sort) => sort.column === key))
        .map((column) => ({ column, direction: 'asc' as const })),
    ]
    const conditions = input.filters?.conditions ?? (input.filter ? [input.filter] : [])
    if (conditions.length > 20) throw new Error('At most 20 filter conditions are allowed.')
    const parameters: MssqlParameter[] = []
    const clauses = conditions.map((condition) => {
      if (!columns.has(condition.column)) throw new Error('The filter column no longer exists.')
      const column = mssqlQuote(condition.column)
      if (condition.operator === 'is null' || condition.operator === 'is not null')
        return `${column} ${condition.operator.toUpperCase()}`
      const operators = {
        equals: '=',
        'not equals': '<>',
        'greater than': '>',
        'less than': '<',
        contains: 'LIKE',
      }
      const operator = operators[condition.operator as keyof typeof operators]
      if (!operator) throw new Error('Unsupported SQL Server filter operator.')
      const contains = condition.operator === 'contains'
      const value = contains
        ? `%${condition.value.replace(/[~%_[]/g, (match) => '~' + match)}%`
        : condition.value
      const name = `p${parameters.length + 1}`
      parameters.push(cellParameter(name, value))
      return `${contains ? `CONVERT(nvarchar(max),${column})` : column} ${operator} @${name}${contains ? " ESCAPE N'~'" : ''}`
    })
    const where = clauses.length
      ? ` WHERE (${clauses.join(input.filters?.match === 'any' ? ' OR ' : ' AND ')})`
      : ''
    const sql = `SELECT ${tableProjection(structure)} FROM ${mssqlQuote(input.schema)}.${mssqlQuote(input.table)}${where} ORDER BY ${order.length ? order.map((sort) => `${mssqlQuote(sort.column)} ${sort.direction.toUpperCase()}`).join(', ') : '(SELECT NULL)'} OFFSET ${input.offset} ROWS FETCH NEXT ${input.limit} ROWS ONLY`
    let editorSql = sql
    for (const match of [...mssqlVisible(sql).matchAll(/@p(\d+)\b/g)].reverse()) {
      editorSql =
        editorSql.slice(0, match.index) +
        mssqlLiteral(parameters[Number(match[1]) - 1].value) +
        editorSql.slice(match.index + match[0].length)
    }
    const session = await this.session(connection, input.sessionId, input.database)
    const requestId = `table:${randomUUID()}`
    this.claim(session, requestId)
    const started = performance.now()
    try {
      const sets = await this.executeNative(session, sql, parameters, input.limit)
      for (const set of sets)
        set.columns = set.columns.map((column) => ({
          ...column,
          type: structure.columns.find((item) => item.name === column.name)?.type || column.type,
          key: keys.includes(column.name),
        }))
      return {
        requestId,
        sets,
        durationMs: Math.round(performance.now() - started),
        transaction: session.state,
        messages: [
          keys.length
            ? 'Offset pages use primary-key tie breakers; concurrent writes may move boundaries.'
            : 'No primary key: page order can change and reviewed edits are disabled.',
        ],
        tableQuery: {
          sql,
          parameters: parameters.map((parameter) =>
            Buffer.isBuffer(parameter.value)
              ? { type: 'binary', base64: parameter.value.toString('base64') }
              : parameter.value,
          ),
          editorSql,
        },
      }
    } finally {
      session.busy = undefined
    }
  }
  async transaction(input: {
    connectionId: string
    sessionId: string
    database?: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: State }> {
    assertSession(input.sessionId)
    const session = await this.session(this.connection(input.connectionId), input.sessionId, input.database)
    this.claim(session, randomUUID())
    try {
      await this.refreshState(session)
      if (input.action === 'begin' && session.state !== 'idle')
        throw new Error('This tab already has an open transaction.')
      if (input.action !== 'begin' && session.state === 'idle')
        throw new Error('This tab has no open transaction.')
      if (input.action === 'commit' && session.state === 'failed')
        throw new Error('The transaction cannot commit. Roll it back.')
      await this.native(
        session,
        input.action === 'begin' ? 'BEGIN TRANSACTION' : input.action.toUpperCase() + ' TRANSACTION',
        [],
        { batch: true },
      )
      await this.refreshState(session)
      return { state: session.state }
    } finally {
      session.busy = undefined
    }
  }
  async applyEdits(input: EditsInput): Promise<{ affectedRows: number }> {
    assertSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    if (connection.profile.readOnly) throw new Error('This connection is read-only.')
    const session = await this.session(connection, input.sessionId, input.database)
    this.claim(session, randomUUID())
    let started = false
    try {
      await this.refreshState(session)
      if (session.state !== 'idle')
        throw new Error('Commit or roll back the open transaction before applying staged edits.')
      const target = `${mssqlQuote(input.schema)}.${mssqlQuote(input.table)}`
      const object = await this.records(
        session,
        'SELECT type FROM sys.objects WHERE object_id=OBJECT_ID(@object)',
        [cellParameter('object', target)],
      )
      if (String(object[0]?.type).trim() !== 'U')
        throw new Error('Reviewed edits require an ordinary base table.')
      const description = await this.tableStructure(session, input.schema, input.table)
      const keys = description.columns.filter((column) => column.primaryKey).map((column) => column.name)
      if (!keys.length) throw new Error('Editing requires a declared primary key.')
      const writable = new Set(
        (
          await this.records(
            session,
            'SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@object) AND is_identity=0 AND is_computed=0 AND generated_always_type=0 AND system_type_id<>189',
            [cellParameter('object', target)],
          )
        ).map((row) => String(row.name)),
      )
      await this.native(session, 'BEGIN TRANSACTION', [], { batch: true })
      started = true
      let affectedRows = 0
      for (const change of input.changes) {
        const entries = Object.entries(change.values)
        if (entries.some(([name]) => !writable.has(name)))
          throw new Error('A changed column is missing, identity, computed or generated. Refresh structure.')
        let sql: string
        let parameters: MssqlParameter[]
        if (change.kind === 'insert') {
          sql = entries.length
            ? `INSERT INTO ${target} (${entries.map(([name]) => mssqlQuote(name)).join(',')}) VALUES (${entries.map((_, i) => `@p${i + 1}`).join(',')})`
            : `INSERT INTO ${target} DEFAULT VALUES`
          parameters = entries.map(([, value], index) => cellParameter(`p${index + 1}`, value))
        } else {
          const original = change.original
          if (!original || keys.some((key) => original[key] == null))
            throw new Error('The original row is missing its non-null primary key.')
          const where = keys.map((key, index) => `${mssqlQuote(key)}=@key${index}`).join(' AND ')
          const identities = keys.map((key, index) => cellParameter(`key${index}`, original[key]))
          const rows = (
            await this.executeNative(
              session,
              `SELECT TOP (2) ${tableProjection(description)} FROM ${target} WITH (UPDLOCK,HOLDLOCK) WHERE ${where}`,
              identities,
              2,
            )
          )
            .filter((set) => set.columns.length)
            .flatMap(values)
          if (
            rows.length !== 1 ||
            description.columns.some(
              (column) =>
                !(column.name in original) ||
                JSON.stringify(rows[0][column.name]) !== JSON.stringify(original[column.name]),
            )
          )
            throw new Error(
              'Conflict: the original row changed or was removed. No changes were saved; reload and review it.',
            )
          if (change.kind === 'delete') {
            sql = `DELETE FROM ${target} WHERE ${where}`
            parameters = identities
          } else {
            if (!entries.length) continue
            sql = `UPDATE ${target} SET ${entries.map(([name], i) => `${mssqlQuote(name)}=@p${i + 1}`).join(',')} WHERE ${where}`
            parameters = [
              ...entries.map(([, value], index) => cellParameter(`p${index + 1}`, value)),
              ...identities,
            ]
          }
        }
        const wrapped = losslessBatch(sql + '; SELECT @@ROWCOUNT AS affected', parameters)
        const affected = Number((await this.records(session, wrapped.sql, wrapped.parameters))[0]?.affected)
        if (affected !== 1)
          throw new Error('The write did not affect exactly one row. No changes were saved.')
        affectedRows += affected
      }
      await this.native(session, 'COMMIT TRANSACTION', [], { batch: true })
      started = false
      session.state = 'idle'
      return { affectedRows }
    } catch (error) {
      if (started)
        await this.native(session, 'IF @@TRANCOUNT>0 ROLLBACK TRANSACTION', [], { batch: true }).catch(() => {
          session.dead = true
        })
      await this.refreshState(session).catch(() => {
        session.dead = true
      })
      throw error
    } finally {
      session.busy = undefined
    }
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<{ requested: boolean; message: string }> {
    assertSession(input.sessionId)
    const session = this.connection(input.connectionId).sessions.get(input.sessionId)
    if (!session || session.dead || session.busy !== input.requestId || !session.request)
      return { requested: false, message: 'No matching SQL Server request is running.' }
    session.request.cancel()
    session.request.resume()
    return {
      requested: true,
      message:
        'SQL Server cancellation requested. Await the original request result; committed statements are not undone.',
    }
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    const safety = mssqlSafety(input.sql)
    if (!safety.readOnly || safety.controlsTransaction || safety.statementCount !== 1)
      throw new Error('Full-result export requires one read-only SELECT; scripts and writes are never rerun.')
    const connection = this.connection(input.connectionId)
    const id = `_export:${randomUUID()}`
    let session: Session | undefined
    const abort = () => {
      session?.request?.cancel()
      session?.request?.resume()
    }
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      if (sink.signal.aborted) throw new Error('Export cancelled.')
      session = await this.session(connection, id, input.database)
      this.claim(session, id)
      if (sink.signal.aborted) throw new Error('Export cancelled.')
      // Requires the database's existing ALLOW_SNAPSHOT_ISOLATION setting. Harbor
      // never changes a shared database setting merely to enable an export.
      await this.native(session, 'SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION', [], {
        batch: true,
      })
      await this.executeNative(session, input.sql, mssqlParameters(input.parameters), 0, sink)
      if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
    } catch (error) {
      throw new Error(redactParameterError(errorMessage(error), input.parameters))
    } finally {
      sink.signal.removeEventListener('abort', abort)
      if (session) {
        session.busy = undefined
        await this.end(session)
      }
      connection.sessions.delete(id)
    }
  }
  private async end(session: Session): Promise<void> {
    if (session.dead) {
      session.db.close()
      await session.closed
      return
    }
    if (session.request) {
      session.request.cancel()
      session.request.resume()
    }
    while (session.busy) await new Promise((done) => setTimeout(done, 5))
    if (!session.dead)
      await this.native(session, 'IF @@TRANCOUNT>0 ROLLBACK TRANSACTION', [], { batch: true }).catch(() => {})
    session.db.close()
    await session.closed
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    if (!connection) return
    await connection.creating.get(input.sessionId)?.catch(() => {})
    const session = connection.sessions.get(input.sessionId)
    if (session) await this.end(session)
    connection.sessions.delete(input.sessionId)
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    connection.closed = true
    await Promise.allSettled(connection.creating.values())
    await Promise.allSettled([...connection.sessions.values()].map((session) => this.end(session)))
    connection.sessions.clear()
    await connection.transport.close()
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
