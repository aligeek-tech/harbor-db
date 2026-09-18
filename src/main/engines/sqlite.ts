import { Worker } from 'node:worker_threads'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
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
import { requiredSqlConfirmation, sqlSafety } from '../../shared/sql'
import { parameterValue, redactParameterError } from '../../shared/parameters'
import { buildTableQuery } from '../../shared/table-query'
import type { SqliteWorkerOptions, SqliteWorkerRequest, SqliteWorkerResponse } from './sqlite-worker'
import type { StreamQueryInput, QueryStreamSink } from './sql'

interface WorkerSession {
  worker: Worker
  state: 'idle' | 'open'
  dead: boolean
  closing: boolean
  cancelled: boolean
  busy?: string
  pending?: {
    id: number
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
  exited: Promise<number>
  version: string
  sink?: QueryStreamSink
}
interface Connection {
  profile: ConnectionProfile
  options: SqliteWorkerOptions
  sessions: Map<string, WorkerSession>
  creating: Map<string, Promise<WorkerSession>>
  status: ConnectionStatus
  closed: boolean
}
function assertSession(id: string): void {
  if (!id || id.startsWith('_'))
    throw new Error('Session identifiers beginning with an underscore are reserved.')
}
function assertDatabase(database?: string, schema?: string): void {
  if ((database && database !== 'main') || (schema && schema !== 'main'))
    throw new Error(
      'SQLite profiles address one selected file in the main namespace; attached databases are unsupported.',
    )
}
function parameter(cell: Cell): SQLInputValue {
  if (cell !== null && typeof cell === 'object') return Buffer.from(cell.base64, 'base64')
  return typeof cell === 'boolean' ? (cell ? 1 : 0) : cell
}

/** Each tab owns one SQLite connection in a worker. No SQL is replayed after a worker exits. */
export class SqliteService {
  private connections = new Map<string, Connection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  private sequence = 0
  constructor(private readonly metadataPath: string) {}

  private async file(profile: ConnectionProfile): Promise<SqliteWorkerOptions> {
    const input = profile.sqlite
    if (!input.path || !isAbsolute(input.path) || input.path.includes('\0') || input.path.startsWith('file:'))
      throw new Error(
        'Select an absolute local SQLite file path. URLs and in-memory profiles are unsupported.',
      )
    if (input.mode === 'create' && profile.readOnly)
      throw new Error('Creating a SQLite file requires writes enabled.')
    const target = resolve(input.path)
    const metadata = resolve(this.metadataPath)
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      if (target === metadata + suffix)
        throw new Error('Harbor application metadata cannot be opened as a managed database.')
    let canonical: string
    if (input.mode === 'create') {
      canonical = join(await realpath(dirname(target)), basename(target))
      const canonicalMetadata = join(await realpath(dirname(metadata)), basename(metadata))
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        if (canonical === canonicalMetadata + suffix)
          throw new Error('Harbor application metadata cannot be created as a managed database.')
      const handle = await open(canonical, 'wx', 0o600)
      await handle.close()
    } else {
      try {
        canonical = await realpath(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new Error('The SQLite file does not exist. Use Create new file explicitly.')
        throw error
      }
    }
    const identity = await stat(canonical)
    if (!identity.isFile()) throw new Error('The selected SQLite path must be a regular file.')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const protectedPath = metadata + suffix
      try {
        const protectedIdentity = await stat(protectedPath)
        if (
          (protectedIdentity.dev === identity.dev && protectedIdentity.ino === identity.ino) ||
          (await realpath(protectedPath)) === canonical
        )
          throw new Error(
            'Harbor application metadata cannot be opened as a managed database, including links.',
          )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      path: canonical,
      metadataPath: metadata,
      device: identity.dev,
      inode: identity.ino,
      readOnly: profile.readOnly,
      busyTimeoutMs: input.busyTimeoutMs,
    }
  }

  private async worker(options: SqliteWorkerOptions): Promise<WorkerSession> {
    const url = new URL(
      import.meta.url.endsWith('.ts') ? './sqlite-worker.ts' : './sqlite-worker.js',
      import.meta.url,
    )
    const worker = new Worker(url, {
      workerData: options,
      execArgv: url.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    })
    const session: WorkerSession = {
      worker,
      state: 'idle',
      dead: false,
      closing: false,
      cancelled: false,
      version: '',
      exited: new Promise((done) => worker.once('exit', done)),
    }
    const failed = (message: string) => {
      session.dead = true
      const pending = session.pending
      session.pending = undefined
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(message))
      }
    }
    worker.on('error', (error) => failed(error.message))
    worker.on('exit', () =>
      failed(
        session.cancelled
          ? 'SQLite worker terminated. The current session was closed; statements were not replayed.'
          : 'SQLite session closed. Reconnect before continuing.',
      ),
    )
    worker.on('message', (response: SqliteWorkerResponse) => {
      const pending = session.pending
      if (!pending || response.id !== pending.id) return
      if (response.stream) {
        const stream = response.stream
        void (async () => {
          let error: string | undefined
          try {
            if (!session.sink || session.sink.signal.aborted)
              throw new Error('Export cancelled. Partial output was not finalized.')
            if (stream.columns) await session.sink.onColumns(stream.columns)
            if (stream.row) await session.sink.onRow(stream.row)
            if (session.sink.signal.aborted)
              throw new Error('Export cancelled. Partial output was not finalized.')
          } catch (failure) {
            error = failure instanceof Error ? failure.message : 'Export consumer failed.'
          }
          if (!session.dead && !session.closing)
            worker.postMessage({ id: response.id, action: 'ack', error } satisfies SqliteWorkerRequest)
        })()
        return
      }
      session.pending = undefined
      session.state = response.transaction
      clearTimeout(pending.timer)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response.value)
    })
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error('SQLite worker initialization timed out.'))
      }, 15000)
      const error = (failure: Error) => {
        clearTimeout(timer)
        reject(failure)
      }
      worker.once('error', error)
      worker.once('message', (response: { ready: boolean; version?: string; error?: string }) => {
        clearTimeout(timer)
        worker.off('error', error)
        if (!response.ready) {
          void worker.terminate()
          reject(new Error(response.error || 'SQLite could not start.'))
        } else {
          session.version = response.version!
          done()
        }
      })
    })
    return session
  }

  async connect(profile: ConnectionProfile, _secrets?: Secrets): Promise<ConnectionStatus> {
    if (profile.engine !== 'sqlite') throw new Error('Use the matching engine adapter for this profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let connection: Connection | undefined
    try {
      const options = await this.file(profile)
      connection = {
        profile: { ...profile },
        options,
        sessions: new Map(),
        creating: new Map(),
        status: { state: 'connecting' },
        closed: false,
      }
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      this.connections.set(profile.id, connection)
      const metadata = await this.session(connection, '_metadata')
      if (connection.closed || this.generations.get(profile.id) !== generation)
        return { state: 'disconnected' }
      connection.status = {
        state: 'connected',
        version: `SQLite ${metadata.version}`,
        durationMs: Math.round(performance.now() - started),
        transport: 'Local file',
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      if (connection) await this.disconnect(profile.id)
      const status: ConnectionStatus = {
        state: 'failed',
        error: error instanceof Error ? error.message : 'SQLite connection failed.',
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private connection(id: string): Connection {
    const value = this.connections.get(id)
    if (!value || value.closed)
      throw new Error('SQLite is disconnected. Connect explicitly before running a query.')
    return value
  }
  private async session(connection: Connection, id: string): Promise<WorkerSession> {
    const existing = connection.sessions.get(id)
    if (existing) {
      if (existing.dead || existing.closing)
        throw new Error(
          'This SQLite tab session was closed. Reconnect before continuing; no statements were replayed.',
        )
      return existing
    }
    const creating = connection.creating.get(id)
    if (creating) return creating
    if (connection.closed) throw new Error('SQLite connection closed.')
    if (connection.sessions.size + connection.creating.size >= 32)
      throw new Error('SQLite allows at most 32 sessions per connection. Close unused tabs.')
    const promise = this.worker(connection.options)
      .then(async (session) => {
        if (connection.closed) {
          session.closing = true
          await session.worker.terminate()
          throw new Error('SQLite connection closed during startup.')
        }
        connection.sessions.set(id, session)
        return session
      })
      .finally(() => connection.creating.delete(id))
    connection.creating.set(id, promise)
    return promise
  }
  private async request<T>(
    session: WorkerSession,
    request: Omit<SqliteWorkerRequest, 'id'>,
    requestId: string,
    timeout: number,
  ): Promise<T> {
    if (session.dead || session.closing) throw new Error('SQLite session is disconnected.')
    if (session.busy) throw new Error('This tab already has a running operation.')
    session.busy = requestId
    try {
      return await new Promise<T>((resolve, reject) => {
        const id = ++this.sequence
        const timer = setTimeout(() => {
          session.closing = true
          // Node SQLite has no interrupt API. A long native step may finish before termination.
          // Never call this a confirmed cancellation or reopen/replay the tab automatically.
          void session.worker.terminate()
          session.pending = undefined
          reject(
            new Error(
              'SQLite operation timed out. Session termination was requested; a native step may still finish. Inspect write outcomes before reconnecting.',
            ),
          )
        }, timeout)
        session.pending = { id, resolve: (value) => resolve(value as T), reject, timer }
        try {
          session.worker.postMessage({ ...request, id })
        } catch (error) {
          clearTimeout(timer)
          session.pending = undefined
          reject(error)
        }
      })
    } finally {
      session.busy = undefined
    }
  }
  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: 'idle' | 'open'
    connected: boolean
    running: boolean
  } {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    const session = connection?.sessions.get(input.sessionId)
    return {
      state: session && !session.dead && !session.closing ? session.state : 'idle',
      connected: !!connection && !connection.closed && !session?.dead && !session?.closing,
      running: !!session?.busy || !!connection?.creating.has(input.sessionId),
    }
  }

  async execute(input: QueryInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    const connection = this.connection(input.connectionId)
    const safety = sqlSafety(input.sql, 'sqlite')
    if (safety.statementCount > 100) throw new Error('A script can contain at most 100 statements.')
    if (connection.profile.readOnly && (!safety.readOnly || safety.controlsTransaction))
      throw new Error(
        'This connection is read-only. Only read statements are allowed; use the dedicated transaction controls.',
      )
    const confirmation = requiredSqlConfirmation(input.sql, 'sqlite', connection.profile)
    if (!connection.profile.readOnly && confirmation && input.confirm !== confirmation)
      throw new Error(`Type "${confirmation}" to confirm this operation on ${connection.profile.name}.`)
    const values = (input.parameters || []).map((value): SQLInputValue => {
      const bound = parameterValue(value)
      if (value.type === 'integer') return BigInt(String(bound))
      if (typeof bound === 'boolean') return bound ? 1 : 0
      return bound
    })
    return this.run(input, values)
  }
  private async run(input: QueryInput, values: SQLInputValue[]): Promise<QueryResult> {
    const connection = this.connection(input.connectionId)
    const session = await this.session(connection, input.sessionId)
    const started = performance.now()
    try {
      const sets = await this.request<ResultSet[]>(
        session,
        { action: 'query', sql: input.sql, values, maxRows: input.maxRows },
        input.requestId,
        connection.profile.queryTimeout,
      )
      return {
        requestId: input.requestId,
        sets,
        durationMs: Math.round(performance.now() - started),
        transaction: session.state,
        messages: [
          'SQLite integers are exact strings. REAL values use SQLite floating-point storage; DECIMAL affinity does not guarantee arbitrary precision.',
          ...(sets.some((set) => set.truncated)
            ? [
                `Display capped at ${input.maxRows} rows or 8 MiB; remaining rows were drained without retention.`,
              ]
            : []),
        ],
      }
    } catch (error) {
      if (session.cancelled && session.dead)
        return {
          requestId: input.requestId,
          sets: [],
          durationMs: Math.round(performance.now() - started),
          transaction: 'idle',
          cancelled: true,
          messages: [
            'The SQLite worker exited and its session was closed. Uncommitted work is rolled back; earlier committed statements may have completed. Nothing was replayed. Reconnect before continuing.',
          ],
        }
      throw new Error(
        redactParameterError(
          error instanceof Error ? error.message : 'SQLite query failed.',
          input.parameters,
        ),
      )
    }
  }
  async listDatabases(id: string): Promise<string[]> {
    this.connection(id)
    return ['main']
  }
  async listObjects(input: {
    connectionId: string
    database?: string
    schema?: string
  }): Promise<ObjectInfo[]> {
    assertDatabase(input.database, input.schema)
    const connection = this.connection(input.connectionId)
    return this.request(
      await this.session(connection, '_metadata'),
      { action: 'objects' },
      `catalog:${randomUUID()}`,
      connection.profile.queryTimeout,
    )
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    assertDatabase(input.database, input.schema)
    const connection = this.connection(input.connectionId)
    return this.request(
      await this.session(connection, '_metadata'),
      { action: 'structure', table: input.table },
      `structure:${randomUUID()}`,
      connection.profile.queryTimeout,
    )
  }
  async table(input: TableInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    assertDatabase(input.database, input.schema)
    const structure = await this.structure(input)
    const query = buildTableQuery({ ...input, schema: 'main' }, structure, 'sqlite')
    const result = await this.run(
      {
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        requestId: `table:${randomUUID()}`,
        sql: query.sql,
        maxRows: input.limit,
        privateSession: false,
      },
      query.parameters.map(parameter),
    )
    result.tableQuery = query
    for (const set of result.sets)
      set.columns = set.columns.map((column) => ({
        ...column,
        key: structure.columns.some((item) => item.name === column.name && item.primaryKey),
      }))
    result.messages.push(
      structure.columns.some((column) => column.primaryKey)
        ? 'Offset pages use primary-key ordering by default; concurrent writes can shift page boundaries.'
        : 'No primary key: reviewed edits are disabled and page order can change.',
    )
    return result
  }
  async applyEdits(input: EditsInput): Promise<{ affectedRows: number }> {
    assertSession(input.sessionId)
    assertDatabase(input.database, input.schema)
    const connection = this.connection(input.connectionId)
    if (connection.profile.readOnly) throw new Error('This connection is read-only.')
    return this.request(
      await this.session(connection, input.sessionId),
      { action: 'edits', edits: input },
      `edits:${randomUUID()}`,
      connection.profile.queryTimeout,
    )
  }
  async transaction(input: {
    connectionId: string
    sessionId: string
    database?: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: 'idle' | 'open' }> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    const connection = this.connection(input.connectionId)
    return this.request(
      await this.session(connection, input.sessionId),
      { action: 'transaction', transaction: input.action },
      `transaction:${randomUUID()}`,
      connection.profile.queryTimeout,
    )
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<{ requested: boolean; message: string }> {
    assertSession(input.sessionId)
    const session = this.connection(input.connectionId).sessions.get(input.sessionId)
    if (!session || session.dead || session.closing || session.busy !== input.requestId)
      return { requested: false, message: 'This request is no longer running.' }
    session.cancelled = true
    session.closing = true
    void session.worker.terminate()
    return {
      requested: true,
      message:
        'SQLite worker termination requested. A native SQLite step may finish first; cancellation is confirmed only when the worker exits. The tab session will be closed and no statements replayed.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    if (!connection) return
    await connection.creating.get(input.sessionId)?.catch(() => undefined)
    const session = connection.sessions.get(input.sessionId)
    if (!session) return
    await this.end(session)
    connection.sessions.delete(input.sessionId)
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    assertDatabase(input.database)
    const safety = sqlSafety(input.sql, 'sqlite')
    if (!safety.readOnly || safety.controlsTransaction || safety.statementCount !== 1)
      throw new Error(
        'Full-result export requires one read-only statement; writes and scripts are never rerun.',
      )
    const connection = this.connection(input.connectionId)
    const id = `_export:${randomUUID()}`
    if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
    if (connection.sessions.size + connection.creating.size >= 32)
      throw new Error('Close unused tabs before starting another SQLite export.')
    const creating = this.worker({ ...connection.options, readOnly: true })
    connection.creating.set(id, creating)
    let session: WorkerSession | undefined
    const abort = () => {
      if (session) {
        session.closing = true
        session.cancelled = true
        void session.worker.terminate()
      }
    }
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      session = await creating
      connection.creating.delete(id)
      connection.sessions.set(id, session)
      session.sink = sink
      if (connection.closed || sink.signal.aborted) {
        abort()
        throw new Error('Export cancelled. Partial output was not finalized.')
      }
      const values = (input.parameters || []).map((value): SQLInputValue => {
        const bound = parameterValue(value)
        if (value.type === 'integer') return BigInt(String(bound))
        return typeof bound === 'boolean' ? (bound ? 1 : 0) : bound
      })
      await this.request(
        session,
        { action: 'stream', sql: input.sql, values },
        id,
        connection.profile.queryTimeout,
      )
      if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
    } catch (error) {
      throw new Error(
        redactParameterError(
          sink.signal.aborted
            ? 'Export cancelled. Partial output was not finalized.'
            : error instanceof Error
              ? error.message
              : 'SQLite export failed.',
          input.parameters,
        ),
      )
    } finally {
      sink.signal.removeEventListener('abort', abort)
      connection.creating.delete(id)
      connection.sessions.delete(id)
      if (session) {
        session.sink = undefined
        await this.end(session)
      }
    }
  }
  private async end(session: WorkerSession): Promise<void> {
    if (session.dead) return
    if (!session.busy && !session.closing) {
      try {
        await this.request(session, { action: 'close' }, 'close', 1000)
        await session.exited
        return
      } catch {
        /* Termination remains the fallback; no replay. */
      }
    }
    session.closing = true
    await session.worker.terminate()
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    connection.closed = true
    await Promise.allSettled([...connection.creating.values()])
    await Promise.allSettled([...connection.sessions.values()].map((session) => this.end(session)))
    connection.sessions.clear()
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
