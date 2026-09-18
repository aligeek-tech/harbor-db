import { Worker } from 'node:worker_threads'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
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
import { requiredSqlConfirmation, sqlSafety, splitStatements } from '../../shared/sql'
import { parameterValue, redactParameterError } from '../../shared/parameters'
import { buildTableQuery } from '../../shared/table-query'
import type {
  BoundValue,
  DuckDBFileGrant,
  DuckDBWorkerOptions,
  DuckDBWorkerRequest,
  DuckDBWorkerResponse,
  TransactionState,
} from './duckdb-worker'
import type { StreamQueryInput, QueryStreamSink } from './sql'

interface Pending {
  id: number
  sessionId: string
  requestId: string
  timer?: ReturnType<typeof setTimeout>
  resolve: (response: DuckDBWorkerResponse) => void
  reject: (error: Error) => void
}
interface Connection {
  profile: ConnectionProfile
  worker: Worker
  status: ConnectionStatus
  closed: boolean
  states: Map<string, TransactionState>
  pending: Map<number, Pending>
  exited: Promise<number>
  sinks: Map<string, QueryStreamSink>
}
export interface DuckDBFileInput {
  connectionId: string
  sessionId: string
  requestId: string
  grant: DuckDBFileGrant
  maxRows?: number
}
function assertSession(id: string): void {
  if (!id || id.startsWith('_'))
    throw new Error('Session identifiers beginning with an underscore are reserved.')
}
function assertDatabase(database?: string): void {
  if (database && database !== 'main')
    throw new Error('DuckDB profiles address one selected database; attached databases are unsupported.')
}
export class DuckDBService {
  private connections = new Map<string, Connection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  private sequence = 0
  constructor(private readonly metadataPath: string) {}

  private async file(profile: ConnectionProfile): Promise<DuckDBWorkerOptions> {
    const input = profile.duckdb
    if (input.mode === 'memory')
      return { path: ':memory:', mode: 'memory', metadataPath: this.metadataPath, readOnly: profile.readOnly }
    if (!input.path || !isAbsolute(input.path) || input.path.includes('\0') || input.path.startsWith('file:'))
      throw new Error('Select an absolute local DuckDB file path. Network URLs are unsupported.')
    if (input.mode === 'create' && profile.readOnly)
      throw new Error('Creating a DuckDB file requires writes enabled.')
    const target = resolve(input.path)
    const metadata = resolve(this.metadataPath)
    const canonicalMetadata = join(await realpath(dirname(metadata)), basename(metadata))
    const canonical =
      input.mode === 'create'
        ? join(await realpath(dirname(target)), basename(target))
        : await realpath(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT')
              throw new Error('The DuckDB file does not exist. Use Create new file explicitly.')
            throw error
          })
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      if (canonical === canonicalMetadata + suffix)
        throw new Error('Harbor application metadata cannot be opened or created as a managed database.')
    if (input.mode === 'create') {
      try {
        await stat(canonical)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { path: canonical, mode: 'create', metadataPath: metadata, readOnly: false }
        throw error
      }
      throw new Error('The destination already exists. Open it explicitly; creation never overwrites files.')
    }
    const identity = await stat(canonical)
    if (!identity.isFile()) throw new Error('The selected path must be a regular DuckDB file.')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const protectedIdentity = await stat(metadata + suffix)
        if (protectedIdentity.dev === identity.dev && protectedIdentity.ino === identity.ino)
          throw new Error('Harbor application metadata cannot be opened, including links.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      path: canonical,
      mode: 'open',
      metadataPath: metadata,
      readOnly: profile.readOnly,
      device: identity.dev,
      inode: identity.ino,
    }
  }
  async connect(profile: ConnectionProfile, _secrets?: Secrets): Promise<ConnectionStatus> {
    if (profile.engine !== 'duckdb') throw new Error('Use the matching engine adapter for this profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let connection: Connection | undefined
    try {
      const options = await this.file(profile)
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      const url = new URL(
        import.meta.url.endsWith('.ts') ? './duckdb-worker.ts' : './duckdb-worker.js',
        import.meta.url,
      )
      const worker = new Worker(url, {
        workerData: options,
        execArgv: url.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
      })
      connection = {
        profile,
        worker,
        status: { state: 'connecting' },
        closed: false,
        states: new Map(),
        pending: new Map(),
        sinks: new Map(),
        exited: new Promise((done) => worker.once('exit', done)),
      }
      const current = connection
      this.connections.set(profile.id, connection)
      const fail = (error: Error) => {
        current.closed = true
        current.status = { state: 'failed', error: error.message }
        for (const pending of current.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        current.pending.clear()
      }
      worker.on('error', fail)
      worker.on('exit', () => {
        if (!current.closed)
          fail(new Error('DuckDB worker exited. Reconnect explicitly; no statements were replayed.'))
      })
      worker.on('message', (response: DuckDBWorkerResponse) => {
        const pending = current.pending.get(response.id)
        if (!pending) return
        if (response.stream) {
          const stream = response.stream
          void (async () => {
            let error: string | undefined
            try {
              const sink = current.sinks.get(pending.sessionId)
              if (!sink || sink.signal.aborted)
                throw new Error('Export cancelled. Partial output was not finalized.')
              if (stream.columns) await sink.onColumns(stream.columns)
              if (stream.row) await sink.onRow(stream.row)
              if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
            } catch (failure) {
              error = failure instanceof Error ? failure.message : 'Export consumer failed.'
            }
            if (!current.closed)
              worker.postMessage({
                id: ++this.sequence,
                action: 'ack',
                sessionId: pending.sessionId,
                targetId: response.id,
                error,
              } satisfies DuckDBWorkerRequest)
          })()
          return
        }
        current.pending.delete(response.id)
        clearTimeout(pending.timer)
        current.states.set(pending.sessionId, response.transaction)
        pending.resolve(response)
      })
      const version = await new Promise<string>((done, reject) => {
        const timer = setTimeout(() => {
          void worker.terminate()
          reject(new Error('DuckDB initialization timed out.'))
        }, 15000)
        worker.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        worker.once('message', (message: { ready: boolean; version?: string; error?: string }) => {
          clearTimeout(timer)
          if (message.ready) done(message.version!)
          else reject(new Error(message.error || 'DuckDB initialization failed.'))
        })
      })
      if (connection.closed || this.generations.get(profile.id) !== generation)
        return { state: 'disconnected' }
      connection.status = {
        state: 'connected',
        version: `DuckDB ${version}`,
        transport: options.mode === 'memory' ? 'Local memory' : 'Local file',
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, connection.status)
      return connection.status
    } catch (error) {
      if (connection) {
        connection.closed = true
        await connection.worker.terminate()
        this.connections.delete(profile.id)
      }
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      const status: ConnectionStatus = {
        state: 'failed',
        error: error instanceof Error ? error.message : 'DuckDB connection failed.',
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  private connection(id: string): Connection {
    const value = this.connections.get(id)
    if (!value || value.closed)
      throw new Error('DuckDB is disconnected. Connect explicitly before continuing.')
    return value
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }
  private request(
    connection: Connection,
    request: Omit<DuckDBWorkerRequest, 'id'>,
    requestId: string,
    concurrent = false,
  ): Promise<DuckDBWorkerResponse> {
    if (connection.closed) return Promise.reject(new Error('DuckDB is disconnected.'))
    if (
      !concurrent &&
      [...connection.pending.values()].some((pending) => pending.sessionId === request.sessionId)
    )
      return Promise.reject(new Error('This tab already has a running operation.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const pending: Pending = { id, sessionId: request.sessionId, requestId, resolve, reject }
      if (!concurrent)
        pending.timer = setTimeout(() => {
          // Keep the operation pending until DuckDB acknowledges completion. A timeout
          // requests native interrupt; it never pretends an uncertain write rolled back.
          connection.worker.postMessage({
            id: ++this.sequence,
            action: 'cancel',
            sessionId: request.sessionId,
            targetId: id,
          })
        }, connection.profile.queryTimeout)
      connection.pending.set(id, pending)
      try {
        connection.worker.postMessage({ ...request, id })
      } catch (error) {
        connection.pending.delete(id)
        clearTimeout(pending.timer)
        reject(error)
      }
    })
  }
  private async value<T>(
    connection: Connection,
    request: Omit<DuckDBWorkerRequest, 'id'>,
    requestId: string = randomUUID(),
    concurrent = false,
  ): Promise<T> {
    const response = await this.request(connection, request, requestId, concurrent)
    if (response.error) throw new Error(response.error)
    return response.value as T
  }
  getSessionState(input: { connectionId: string; sessionId: string }): {
    state: TransactionState
    connected: boolean
    running: boolean
  } {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    return {
      state: connection?.states.get(input.sessionId) || 'idle',
      connected: !!connection && !connection.closed,
      running:
        !!connection &&
        [...connection.pending.values()].some((pending) => pending.sessionId === input.sessionId),
    }
  }
  async execute(input: QueryInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    const connection = this.connection(input.connectionId)
    const safety = sqlSafety(input.sql, 'duckdb')
    if (connection.profile.readOnly && (!safety.readOnly || safety.controlsTransaction))
      throw new Error('This connection is read-only. Use the transaction toolbar for transaction control.')
    const confirmation = requiredSqlConfirmation(input.sql, 'duckdb', connection.profile)
    if (!connection.profile.readOnly && confirmation && input.confirm !== confirmation)
      throw new Error(`Type "${confirmation}" to confirm this operation on ${connection.profile.name}.`)
    const values = (input.parameters || []).map((value) =>
      value.type === 'integer' ? BigInt(String(parameterValue(value))) : parameterValue(value),
    )
    return this.run(input, values)
  }
  private async run(input: QueryInput, values: BoundValue[]): Promise<QueryResult> {
    const connection = this.connection(input.connectionId)
    const started = performance.now()
    const response = await this.request(
      connection,
      {
        action: 'query',
        sessionId: input.sessionId,
        parts: splitStatements(input.sql, 'duckdb').map((part) => part.text),
        values,
        maxRows: input.maxRows,
      },
      input.requestId,
    )
    if (response.error && !response.cancelled)
      throw new Error(redactParameterError(response.error, input.parameters))
    return {
      requestId: input.requestId,
      durationMs: Math.round(performance.now() - started),
      sets: response.cancelled ? [] : (response.value as ResultSet[]),
      transaction: response.transaction,
      ...(response.cancelled ? { cancelled: true } : {}),
      messages: [
        response.cancelled
          ? 'Native interruption completed. The open transaction was rolled back; earlier committed statements may have completed. Nothing was replayed.'
          : 'Integers, decimals, timestamps and nested values retain exact DuckDB notation. Results retain at most the requested rows and 8 MiB; excess rows are drained without retention. External files and extensions are disabled in editor sessions.',
      ],
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
    assertDatabase(input.database)
    return this.value(this.connection(input.connectionId), {
      action: 'objects',
      sessionId: '_metadata',
      schema: input.schema,
    })
  }
  async structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure> {
    assertDatabase(input.database)
    return this.value(this.connection(input.connectionId), {
      action: 'structure',
      sessionId: '_metadata',
      schema: input.schema,
      table: input.table,
    })
  }
  async table(input: TableInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    const structure = await this.structure(input)
    const query = buildTableQuery(input, structure, 'duckdb')
    const result = await this.run(
      {
        connectionId: input.connectionId,
        sessionId: input.sessionId,
        requestId: `table:${randomUUID()}`,
        sql: query.sql,
        maxRows: input.limit,
        privateSession: false,
      },
      query.parameters.map((value) =>
        value !== null && typeof value === 'object' ? Buffer.from(value.base64, 'base64') : value,
      ),
    )
    result.tableQuery = query
    for (const set of result.sets)
      set.columns = set.columns.map((column) => ({
        ...column,
        key: structure.columns.some((item) => item.name === column.name && item.primaryKey),
      }))
    return result
  }
  async applyEdits(input: EditsInput): Promise<{ affectedRows: number }> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    const connection = this.connection(input.connectionId)
    if (connection.profile.readOnly) throw new Error('This connection is read-only.')
    return this.value(connection, { action: 'edits', sessionId: input.sessionId, edits: input })
  }
  async transaction(input: {
    connectionId: string
    sessionId: string
    database?: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: TransactionState }> {
    assertSession(input.sessionId)
    assertDatabase(input.database)
    return this.value(this.connection(input.connectionId), {
      action: 'transaction',
      sessionId: input.sessionId,
      transaction: input.action,
    })
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<{ requested: boolean; message: string }> {
    assertSession(input.sessionId)
    const connection = this.connection(input.connectionId)
    const pending = [...connection.pending.values()].find(
      (pending) => pending.sessionId === input.sessionId && pending.requestId === input.requestId,
    )
    if (!pending) return { requested: false, message: 'No matching DuckDB operation is running.' }
    return this.value(
      connection,
      { action: 'cancel', sessionId: input.sessionId, targetId: pending.id },
      randomUUID(),
      true,
    )
  }
  /** Main-process only: grants must originate from the native picker, never renderer paths. */
  async previewFile(input: DuckDBFileInput): Promise<QueryResult> {
    assertSession(input.sessionId)
    const started = performance.now()
    const sets = await this.value<ResultSet[]>(
      this.connection(input.connectionId),
      {
        action: 'previewFile',
        sessionId: input.sessionId,
        grant: input.grant,
        maxRows: input.maxRows || 200,
      },
      input.requestId,
    )
    return {
      requestId: input.requestId,
      sets,
      durationMs: Math.round(performance.now() - started),
      transaction: this.getSessionState(input).state,
      messages: [
        'Preview samples a bounded prefix of the selected file. Type inference may sample; review the schema before importing. The file is not modified.',
      ],
    }
  }
  async importFile(
    input: DuckDBFileInput & { schema: string; table: string },
  ): Promise<{ affectedRows: number }> {
    assertSession(input.sessionId)
    return this.value(
      this.connection(input.connectionId),
      {
        action: 'importFile',
        sessionId: input.sessionId,
        grant: input.grant,
        schema: input.schema,
        table: input.table,
      },
      input.requestId,
    )
  }
  async streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void> {
    assertDatabase(input.database)
    const safety = sqlSafety(input.sql, 'duckdb')
    if (!safety.readOnly || safety.controlsTransaction || safety.statementCount !== 1)
      throw new Error(
        'Full-result export requires one read-only statement; writes and scripts are never rerun.',
      )
    const connection = this.connection(input.connectionId)
    const sessionId = `_export:${randomUUID()}`
    if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
    const values = (input.parameters || []).map((value) =>
      value.type === 'integer' ? BigInt(String(parameterValue(value))) : parameterValue(value),
    )
    connection.sinks.set(sessionId, sink)
    const abort = () => {
      const pending = [...connection.pending.values()].find((pending) => pending.sessionId === sessionId)
      if (pending && !connection.closed)
        connection.worker.postMessage({
          id: ++this.sequence,
          action: 'cancel',
          sessionId,
          targetId: pending.id,
        } satisfies DuckDBWorkerRequest)
    }
    sink.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.value(connection, { action: 'stream', sessionId, parts: [input.sql], values }, sessionId)
      if (sink.signal.aborted) throw new Error('Export cancelled. Partial output was not finalized.')
    } catch (error) {
      throw new Error(
        redactParameterError(
          error instanceof Error ? error.message : 'DuckDB export failed.',
          input.parameters,
        ),
      )
    } finally {
      sink.signal.removeEventListener('abort', abort)
      connection.sinks.delete(sessionId)
      connection.states.delete(sessionId)
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    assertSession(input.sessionId)
    const connection = this.connections.get(input.connectionId)
    if (!connection || connection.closed) return
    const busy = [...connection.pending.values()].find((pending) => pending.sessionId === input.sessionId)
    if (busy) throw new Error('Cancel and await the running query before closing this session.')
    await this.value(connection, { action: 'closeSession', sessionId: input.sessionId })
    connection.states.delete(input.sessionId)
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const connection = this.connections.get(id)
    this.states.set(id, { state: 'disconnected' })
    if (!connection) return
    if (!connection.closed)
      await this.value(connection, { action: 'close', sessionId: '_close' }, randomUUID(), true).catch(
        () => {},
      )
    connection.closed = true
    await connection.exited
    if (this.connections.get(id) === connection) this.connections.delete(id)
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
