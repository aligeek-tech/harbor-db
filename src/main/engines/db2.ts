import { randomUUID } from 'node:crypto'
import type {
  ConnectionProfile,
  ConnectionStatus,
  HarborAPI,
  ObjectInfo,
  QueryInput,
  QueryResult,
  Secrets,
  TableInput,
  TableStructure,
} from '../../shared/contracts'
import { assertDb2Profile, assertDb2Query, db2ConnectionValue, db2Quote } from '../../shared/db2'
import { parameterValue, type QueryParameter } from '../../shared/parameters'
import type { QueryStreamSink, StreamQueryInput } from './adapter'
import type { Transport } from './transport'
import { openDb2Transport } from './db2-transport'
import { Db2Process, DB2_INTERRUPTED } from './db2-process'
import type { Db2Parameter } from './db2-protocol'
import type { Db2Encoding } from './db2-values'

interface Session {
  process: Db2Process
  busy?: string
}
interface Connection {
  profile: ConnectionProfile
  secrets: Secrets
  transport: Transport
  status: ConnectionStatus
  sessions: Map<string, Session>
  creating: Map<string, Promise<Session>>
  queue: Promise<unknown>
  closed: boolean
}
const hex = (expression: string) => `HEX(${expression})`
const textEncoding: Db2Encoding = { type: 'VARCHAR', format: 'hex-text' }
const intEncoding: Db2Encoding = { type: 'INTEGER', format: 'native' }
function tab(id: string): void {
  if (!id || id.startsWith('_'))
    throw new Error('A nonempty Db2 tab identifier without a leading underscore is required.')
}
function parameters(values: QueryParameter[] = []): Db2Parameter[] {
  return values.map((value) => {
    const parsed = parameterValue(value)
    if (typeof parsed === 'string' && parsed.includes('\0'))
      throw new Error(
        'Db2 text parameters containing NUL are unavailable; use a binary parameter and an explicit server cast.',
      )
    return parsed instanceof Uint8Array ? { binary: Buffer.from(parsed).toString('base64') } : parsed
  })
}
function privateError(error: unknown, values: QueryParameter[] = []): Error {
  if (values.some((value) => value.secret))
    return new Error(
      'Db2 query failed while using a private parameter. Check parameter types, permissions and server status.',
    )
  return error instanceof Error ? error : new Error('Db2 operation failed.')
}

export class Db2Service {
  private connections = new Map<string, Connection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    let transport: Transport | undefined, connection: Connection | undefined
    this.states.set(profile.id, { state: 'connecting' })
    try {
      assertDb2Profile(profile)
      for (const value of [
        profile.database,
        profile.schema,
        profile.username,
        profile.host,
        secrets.password ?? '',
      ])
        db2ConnectionValue(value)
      transport = await openDb2Transport(profile, secrets)
      if (generation !== this.generations.get(profile.id)) {
        await transport.close()
        return { state: 'disconnected' }
      }
      connection = {
        profile: structuredClone(profile),
        secrets: { ...secrets },
        transport,
        status: { state: 'connecting' },
        sessions: new Map(),
        creating: new Map(),
        queue: Promise.resolve(),
        closed: false,
      }
      this.connections.set(profile.id, connection)
      const session = await this.session(connection, '_metadata')
      if (connection.closed || generation !== this.generations.get(profile.id))
        return { state: 'disconnected' }
      const version = (session as Session & { version?: string }).version
      connection.status = {
        state: 'connected',
        version,
        transport: `${profile.ssh.enabled ? 'SSH + ' : ''}${profile.tls.enabled ? 'Verified TLS bridge' : 'TCP'} · Db2 LUW`,
        durationMs: Math.round(performance.now() - started),
        lastConnectedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      const stale = generation !== this.generations.get(profile.id)
      if (connection && this.connections.get(profile.id) === connection) await this.disconnect(profile.id)
      else await transport?.close()
      if (stale) return { state: 'disconnected' }
      let message = error instanceof Error ? error.message : 'Db2 connection failed.'
      for (const secret of Object.values(secrets))
        if (secret) message = message.replaceAll(secret, '[redacted]')
      const status: ConnectionStatus = {
        state: 'failed',
        error: message,
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private connection(id: string, database?: string): Connection {
    const connection = this.connections.get(id)
    if (!connection || connection.closed || connection.status.state !== 'connected')
      throw new Error('Db2 is disconnected. Connect explicitly to continue.')
    if (database && database !== connection.profile.database)
      throw new Error('Db2 operations must use the explicitly connected database.')
    return connection
  }
  private session(connection: Connection, id: string): Promise<Session> {
    if (connection.closed) return Promise.reject(new Error(DB2_INTERRUPTED))
    const existing = connection.sessions.get(id)
    if (existing)
      return existing.process.dead ? Promise.reject(new Error(DB2_INTERRUPTED)) : Promise.resolve(existing)
    const pending = connection.creating.get(id)
    if (pending) return pending
    if (connection.sessions.size + connection.creating.size >= 5)
      return Promise.reject(
        new Error(
          'Db2 supports four query sessions plus its metadata session. Close a tab before opening another.',
        ),
      )
    const create = (async () => {
      const process = new Db2Process(undefined, () => {
        if (id === '_metadata' && !connection.closed)
          connection.status = { state: 'failed', error: DB2_INTERRUPTED }
      })
      const session: Session & { version?: string } = { process }
      connection.sessions.set(id, session)
      try {
        const p = connection.profile
        const connectionString = `DATABASE=${db2ConnectionValue(p.database)};HOSTNAME=${db2ConnectionValue(connection.transport.host)};PORT=${connection.transport.port};PROTOCOL=TCPIP;UID=${db2ConnectionValue(p.username)};PWD=${db2ConnectionValue(connection.secrets.password ?? '')};CURRENTSCHEMA=${db2ConnectionValue(p.schema)};`
        const result = await process.request(
          { action: 'open', connectionString, timeout: p.connectTimeout },
          p.connectTimeout + 1000,
        )
        session.version = result.version
        if (connection.closed) {
          await process.close()
          throw new Error(DB2_INTERRUPTED)
        }
        return session
      } catch (error) {
        await process.close()
        throw error
      }
    })()
    connection.creating.set(id, create)
    void create.finally(() => connection.creating.delete(id)).catch(() => {})
    return create
  }
  private async query(
    connection: Connection,
    session: Session,
    sql: string,
    values: Db2Parameter[],
    maxRows: number,
    encodings?: Db2Encoding[],
    sink?: QueryStreamSink,
  ) {
    assertDb2Query(sql)
    if (
      values.length > 100 ||
      Buffer.byteLength(JSON.stringify(values)) > 4 * 1024 * 1024 ||
      values.some((value) => typeof value === 'string' && value.includes('\0'))
    )
      throw new Error('Db2 parameters exceed the bounded input contract or contain unsupported NUL text.')
    const result = await session.process.request(
      {
        action: 'query',
        sql,
        parameters: values,
        maxRows,
        encodings,
        timeout: connection.profile.queryTimeout,
        stream: !!sink,
      },
      connection.profile.queryTimeout + 1000,
      sink,
    )
    if (!result.set) throw new Error('Db2 returned no result descriptor.')
    return result.set
  }
  private metadata<T>(connection: Connection, operation: (session: Session) => Promise<T>): Promise<T> {
    const value = connection.queue.then(async () => {
      if (connection.closed) throw new Error(DB2_INTERRUPTED)
      return operation(await this.session(connection, '_metadata'))
    })
    connection.queue = value.catch(() => {})
    return value
  }
  private schema(connection: Connection, schema?: string): string {
    if (schema && schema !== connection.profile.schema)
      throw new Error('Choose a separate Db2 profile to browse a different schema.')
    return connection.profile.schema
  }
  async listDatabases(id: string): Promise<string[]> {
    return [this.connection(id).profile.database]
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    const connection = this.connection(input.connectionId, input.database)
    const schema = this.schema(connection, input.schema)
    return this.metadata(connection, async (session) => {
      const set = await this.query(
        connection,
        session,
        `SELECT HEX(TABNAME), HEX(TYPE), HEX(CAST(CARD AS VARCHAR(32))) FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TYPE IN ('T','V','S') ORDER BY TABNAME FETCH FIRST 1001 ROWS ONLY`,
        [schema],
        1001,
        [textEncoding, textEncoding, textEncoding],
      )
      if (set.truncated || set.rows.length > 1000)
        throw new Error('Db2 schema contains more than 1000 catalog objects. Select a narrower schema.')
      return set.rows.map((row) => ({
        name: String(row[0]),
        schema,
        database: connection.profile.database,
        kind: row[1] === 'V' ? 'view' : row[1] === 'S' ? 'materialized view' : 'table',
        ...(row[2] !== null && Number(row[2]) >= 0 ? { estimatedRows: String(row[2]) } : {}),
      }))
    })
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    const connection = this.connection(input.connectionId, input.database)
    const schema = this.schema(connection, input.schema)
    return this.metadata(connection, async (session) => {
      const sql = `SELECT HEX(C.COLNAME), HEX(C.TYPENAME), C.LENGTH, C.SCALE, HEX(C.NULLS), HEX(C.GENERATED), HEX(C.IDENTITY), K.COLSEQ, C.CODEPAGE FROM SYSCAT.COLUMNS C LEFT JOIN (SELECT K.TABSCHEMA, K.TABNAME, K.COLNAME, K.COLSEQ FROM SYSCAT.KEYCOLUSE K JOIN SYSCAT.TABCONST T ON T.TABSCHEMA=K.TABSCHEMA AND T.TABNAME=K.TABNAME AND T.CONSTNAME=K.CONSTNAME WHERE T.TYPE='P') K ON K.TABSCHEMA=C.TABSCHEMA AND K.TABNAME=C.TABNAME AND K.COLNAME=C.COLNAME WHERE C.TABSCHEMA=? AND C.TABNAME=? ORDER BY C.COLNO FETCH FIRST 129 ROWS ONLY`
      const set = await this.query(connection, session, sql, [schema, input.table], 129, [
        textEncoding,
        textEncoding,
        intEncoding,
        intEncoding,
        textEncoding,
        textEncoding,
        textEncoding,
        intEncoding,
        intEncoding,
      ])
      if (!set.rows.length) throw new Error('Db2 table was not found or its metadata is not visible.')
      if (set.truncated || set.rows.length > 128)
        throw new Error('Db2 tables with more than 128 columns are outside this bounded slice.')
      return {
        columns: set.rows.map((row) => {
          const type = String(row[1]).trim()
          const decorated = ['CHARACTER', 'CHAR', 'VARCHAR', 'BINARY', 'VARBINARY'].includes(type)
            ? `${type}(${row[2]})${Number(row[8]) === 0 && ['CHARACTER', 'CHAR', 'VARCHAR'].includes(type) ? ' FOR BIT DATA' : ''}`
            : ['DECIMAL', 'NUMERIC'].includes(type)
              ? `${type}(${row[2]},${row[3]})`
              : type === 'TIMESTAMP'
                ? `${type}(${row[3]})`
                : type
          return {
            name: String(row[0]),
            type: decorated,
            nullable: row[4] === 'Y',
            defaultValue: null,
            primaryKey: row[7] !== null,
            ...(row[7] !== null ? { primaryKeyPosition: Number(row[7]) } : {}),
            generated: row[5] === 'A',
            ...(row[6] === 'Y'
              ? { identity: row[5] === 'A' ? ('always' as const) : ('by-default' as const) }
              : {}),
          }
        }),
        indexes: [],
        constraints: [],
        ddl: '-- Db2 column and primary-key metadata only. Defaults, indexes, foreign keys and complete DDL were not inspected; empty lists do not prove absence.',
      }
    })
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    tab(input.sessionId)
    assertDb2Query(input.sql)
    const connection = this.connection(input.connectionId, input.database)
    const session = await this.session(connection, input.sessionId)
    if (session.busy) throw new Error('The Db2 tab is busy.')
    session.busy = input.requestId
    const started = performance.now()
    try {
      return {
        requestId: input.requestId,
        sets: [await this.query(connection, session, input.sql, parameters(input.parameters), input.maxRows)],
        durationMs: Math.round(performance.now() - started),
        messages: ['Guarded Db2 reads; database grants remain the security boundary.'],
        transaction: 'idle',
      }
    } catch (error) {
      throw privateError(error, input.parameters)
    } finally {
      session.busy = undefined
    }
  }
  async table(input: TableInput): Promise<QueryResult> {
    tab(input.sessionId)
    const connection = this.connection(input.connectionId, input.database)
    this.schema(connection, input.schema)
    const structure = await this.structure(input)
    const plan = db2TablePlan(input, structure)
    const session = await this.session(connection, input.sessionId)
    if (session.busy) throw new Error('The Db2 tab is busy.')
    const requestId = randomUUID(),
      started = performance.now()
    session.busy = requestId
    try {
      return {
        requestId,
        sets: [await this.query(connection, session, plan.sql, plan.parameters, input.limit, plan.encodings)],
        durationMs: Math.round(performance.now() - started),
        messages: [
          'Db2 table values use bounded lossless projections. Large text, LOB, XML and unsupported types must be queried explicitly as bounded binary values.',
        ],
        transaction: 'idle',
      }
    } finally {
      session.busy = undefined
    }
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    assertDb2Query(input.sql)
    const connection = this.connection(input.connectionId, input.database)
    if (sink.signal.aborted) throw new Error('Db2 export cancelled before execution.')
    // Exports always get a fresh physical session; cancellation cannot kill a user's tab.
    const id = `export-${randomUUID()}`
    let session: Session | undefined
    const abort = () => (session ?? connection.sessions.get(id))?.process.cancel()
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      const creating = this.session(connection, id)
      if (sink.signal.aborted) abort()
      session = await creating
      session.busy = randomUUID()
      if (sink.signal.aborted) abort()
      await this.query(connection, session, input.sql, parameters(input.parameters), 1, undefined, sink)
    } catch (error) {
      throw privateError(error, input.parameters)
    } finally {
      sink.signal.removeEventListener('abort', abort)
      const final = session ?? connection.sessions.get(id)
      if (final) {
        final.busy = undefined
        await final.process.close()
      }
      connection.sessions.delete(id)
    }
  }
  cancel: HarborAPI['cancel'] = async (input) => {
    const session = this.connection(input.connectionId).sessions.get(input.sessionId)
    if (session?.busy !== input.requestId)
      return { requested: false, message: 'No matching Db2 request is running.' }
    session.process.cancel()
    return { requested: true, message: DB2_INTERRUPTED }
  }
  closeSession: HarborAPI['closeSession'] = async (input) => {
    tab(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    if (!connection) return
    const session =
      connection.sessions.get(input.sessionId) ??
      (await connection.creating.get(input.sessionId)?.catch(() => undefined))
    await session?.process.close()
    connection.sessions.delete(input.sessionId)
  }
  getSessionState: HarborAPI['getSessionState'] = async (input) => {
    tab(input.sessionId)
    const session = this.connection(input.connectionId).sessions.get(input.sessionId)
    return {
      state: session?.process.dead ? 'failed' : 'idle',
      connected: !session?.process.dead,
      running: !!session?.busy,
    }
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    connection.closed = true
    await Promise.allSettled([...connection.sessions.values()].map((session) => session.process.close()))
    await connection.transport.close()
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}

export function db2TablePlan(
  input: TableInput,
  structure: TableStructure,
): { sql: string; parameters: Db2Parameter[]; encodings: Db2Encoding[] } {
  const encodings: Db2Encoding[] = []
  const projections = structure.columns.map((column) => {
    const quoted = db2Quote(column.name),
      type = column.type.toUpperCase()
    let format: Db2Encoding['format'] = 'native',
      expression = quoted
    const text = /^(?:CHARACTER|CHAR|VARCHAR|BINARY|VARBINARY)\((\d+)\)( FOR BIT DATA)?$/.exec(type)
    if (text) {
      if (Number(text[1]) > 511)
        throw new Error(
          `Db2 column ${column.name} exceeds the 511 declared-byte preview limit. Use an explicit bounded binary query.`,
        )
      format = /BINARY|FOR BIT DATA/.test(type) ? 'hex-binary' : 'hex-text'
      expression = hex(quoted)
    } else if (/^(?:DECIMAL|NUMERIC)\(\d+,\d+\)$|^(?:DECFLOAT|TIMESTAMP(?:\(\d+\))?|DATE|TIME)$/.test(type)) {
      format = 'hex-text'
      expression = hex(`CAST(${quoted} AS VARCHAR(128))`)
    } else if (!/^(?:INTEGER|SMALLINT|BIGINT|REAL|DOUBLE|FLOAT|BOOLEAN)$/.test(type))
      throw new Error(`Db2 ${type} is outside this exact bounded table preview.`)
    encodings.push({ type: column.type, format })
    return `${expression} AS ${quoted}`
  })
  if (!projections.length || projections.length > 128) throw new Error('Db2 preview requires 1–128 columns.')
  let sql = `SELECT ${projections.join(', ')} FROM ${db2Quote(input.schema)}.${db2Quote(input.table)}`
  const names = new Set(structure.columns.map((column) => column.name))
  const values: Db2Parameter[] = []
  if (input.filters && input.filter) throw new Error('Choose one table filter representation.')
  const filters = input.filters?.conditions ?? (input.filter ? [input.filter] : [])
  if (filters.length > 20) throw new Error('At most twenty filters are supported.')
  const predicates = filters.map((filter) => {
    if (!names.has(filter.column)) throw new Error('Unknown Db2 filter column.')
    const name = db2Quote(filter.column)
    if (filter.operator === 'is null' || filter.operator === 'is not null')
      return `${name} ${filter.operator === 'is null' ? 'IS NULL' : 'IS NOT NULL'}`
    if (filter.operator === 'contains')
      throw new Error(
        'Db2 contains filters are unavailable in this initial slice; use an explicit LIKE query.',
      )
    const operator = { equals: '=', 'not equals': '<>', 'greater than': '>', 'less than': '<' }[
      filter.operator
    ]
    if (!operator) throw new Error('Unsupported Db2 filter.')
    values.push(filter.value)
    return `${name} ${operator} ?`
  })
  if (predicates.length)
    sql += ` WHERE (${predicates.join(input.filters?.match === 'any' ? ' OR ' : ' AND ')})`
  if (input.sorts && input.sort) throw new Error('Choose one sort representation.')
  const sorts = [...(input.sorts ?? (input.sort ? [{ column: input.sort, direction: input.direction }] : []))]
  if (sorts.length > 8 || new Set(sorts.map((sort) => sort.column)).size !== sorts.length)
    throw new Error('Choose up to eight distinct Db2 sort columns.')
  for (const key of structure.columns
    .filter((column) => column.primaryKey)
    .sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0)))
    if (!sorts.some((sort) => sort.column === key.name)) sorts.push({ column: key.name, direction: 'asc' })
  if (sorts.some((sort) => !names.has(sort.column) || !['asc', 'desc'].includes(sort.direction)))
    throw new Error('Invalid Db2 sort column or direction.')
  if (sorts.length)
    sql +=
      ' ORDER BY ' +
      sorts.map((sort) => `${db2Quote(sort.column)} ${sort.direction.toUpperCase()}`).join(', ')
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 10000000 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1000
  )
    throw new Error('Invalid Db2 pagination bounds.')
  sql += ` OFFSET ${input.offset} ROWS FETCH NEXT ${input.limit} ROWS ONLY`
  return { sql, parameters: values, encodings }
}
