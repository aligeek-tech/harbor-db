import { parentPort, workerData } from 'node:worker_threads'
import { realpath, stat, mkdtemp, link, rm, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DuckDBInstance,
  DuckDBBlobValue,
  blobValue,
  StatementType,
  ResultReturnType,
  type DuckDBConnection,
  type DuckDBValue,
  type DuckDBResult,
} from '@duckdb/node-api'
import type {
  Cell,
  EditsInput,
  ForeignKeyInfo,
  ObjectInfo,
  ResultColumn,
  ResultSet,
  TableStructure,
} from '../../shared/contracts'

export type TransactionState = 'idle' | 'open' | 'failed'
export type BoundValue = null | string | number | boolean | bigint | Uint8Array
export interface DuckDBFileGrant {
  path: string
  device: number
  inode: number
  size: number
  mtimeMs: number
  ctimeMs: number
  format: 'csv' | 'json' | 'parquet'
}
export interface DuckDBWorkerOptions {
  path: string
  mode: 'open' | 'create' | 'memory'
  metadataPath: string
  device?: number
  inode?: number
  readOnly: boolean
}
export interface DuckDBWorkerRequest {
  id: number
  sessionId: string
  action:
    | 'query'
    | 'objects'
    | 'structure'
    | 'edits'
    | 'transaction'
    | 'closeSession'
    | 'close'
    | 'cancel'
    | 'previewFile'
    | 'importFile'
    | 'stream'
    | 'ack'
  parts?: string[]
  values?: BoundValue[]
  maxRows?: number
  schema?: string
  table?: string
  edits?: EditsInput
  transaction?: 'begin' | 'commit' | 'rollback'
  grant?: DuckDBFileGrant
  targetId?: number
  error?: string
}
export interface DuckDBWorkerResponse {
  id: number
  value?: unknown
  error?: string
  cancelled?: boolean
  transaction: TransactionState
  stream?: { columns?: ResultColumn[]; row?: Cell[] }
}
interface Session {
  db: DuckDBConnection
  state: TransactionState
  busy?: number
  cancelled: boolean
  reader?: DuckDBConnection
  ack?: { resolve: () => void; reject: (error: Error) => void }
}
const port = parentPort!
const options = workerData as DuckDBWorkerOptions
const sessions = new Map<string, Session>()
const pendingSessions = new Map<string, Promise<Session>>()
const activeRequests = new Map<string, { id: number; cancelled: boolean }>()
const MAX_BYTES = 8 * 1024 * 1024
let instance!: DuckDBInstance
let closing = false

function config(readOnly: boolean): Record<string, string> {
  return {
    access_mode: readOnly ? 'READ_ONLY' : 'READ_WRITE',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    allow_community_extensions: 'false',
    allow_unsigned_extensions: 'false',
    allow_persistent_secrets: 'false',
    memory_limit: '256MB',
    threads: '2',
    temp_directory: '',
    max_temp_directory_size: '0B',
    enable_external_access: 'false',
  }
}
function quote(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid DuckDB identifier.')
  return '"' + value.replaceAll('"', '""') + '"'
}
function cell(value: DuckDBValue): Cell {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (value instanceof DuckDBBlobValue)
    return { type: 'binary', base64: Buffer.from(value.bytes).toString('base64') }
  // DuckDB value classes implement lossless engine notation, including DECIMAL,
  // nanosecond timestamps and nested containers. Never coerce them through Number/Date.
  return value.toString()
}
function bound(value: BoundValue | Cell): DuckDBValue {
  if (value instanceof Uint8Array) return blobValue(value)
  if (value !== null && typeof value === 'object') return blobValue(Buffer.from(value.base64, 'base64'))
  return value
}
function checkCancelled(session: Session): void {
  if (session.cancelled || closing) throw new Error('DuckDB operation cancelled.')
}
async function protectedFile(path: string, device?: number, inode?: number): Promise<void> {
  const identity = await stat(path)
  if (!identity.isFile() || (device !== undefined && (identity.dev !== device || identity.ino !== inode)))
    throw new Error('The selected file changed. Select it again before continuing.')
  const canonical = await realpath(path)
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const protectedIdentity = await stat(options.metadataPath + suffix)
      if (
        (protectedIdentity.dev === identity.dev && protectedIdentity.ino === identity.ino) ||
        (await realpath(options.metadataPath + suffix)) === canonical
      )
        throw new Error('Harbor application metadata cannot be opened or imported, including links.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
async function session(id: string): Promise<Session> {
  const existing = sessions.get(id)
  if (existing) return existing
  const pending = pendingSessions.get(id)
  if (pending) return pending
  if (sessions.size + pendingSessions.size >= 32)
    throw new Error('Close unused tabs: DuckDB allows at most 32 sessions.')
  const creating = instance
    .connect()
    .then((db) => {
      const value: Session = { db, state: 'idle', cancelled: false }
      sessions.set(id, value)
      return value
    })
    .finally(() => pendingSessions.delete(id))
  pendingSessions.set(id, creating)
  return creating
}
async function records(
  db: DuckDBConnection,
  sql: string,
  values: DuckDBValue[] = [],
): Promise<Record<string, DuckDBValue>[]> {
  return (await db.run(sql, values.length ? values : undefined)).getRowObjects()
}
async function structure(db: DuckDBConnection, schema: string, table: string): Promise<TableStructure> {
  const objects = await records(
    db,
    'SELECT sql FROM duckdb_tables() WHERE database_name=current_database() AND schema_name=? AND table_name=? UNION ALL SELECT sql FROM duckdb_views() WHERE database_name=current_database() AND schema_name=? AND view_name=?',
    [schema, table, schema, table],
  )
  if (objects.length !== 1) throw new Error('The selected DuckDB table or view no longer exists.')
  const keys = await records(
    db,
    'SELECT constraint_name,constraint_type,constraint_text,constraint_column_names,referenced_table,referenced_column_names FROM duckdb_constraints() WHERE database_name=current_database() AND schema_name=? AND table_name=? ORDER BY constraint_index',
    [schema, table],
  )
  const primary = keys.find((key) => String(key.constraint_text).startsWith('PRIMARY KEY'))
  const keyNames: string[] = primary
    ? (primary.constraint_column_names as { items: DuckDBValue[] }).items.map(String)
    : []
  const columns = await records(
    db,
    'SELECT column_name,data_type,is_nullable,column_default FROM duckdb_columns() WHERE database_name=current_database() AND schema_name=? AND table_name=? ORDER BY column_index',
    [schema, table],
  )
  const indexes = await records(
    db,
    'SELECT index_name,sql FROM duckdb_indexes() WHERE database_name=current_database() AND schema_name=? AND table_name=? ORDER BY index_name',
    [schema, table],
  )
  const references = await records(
    db,
    'SELECT constraint_name,unique_constraint_schema,update_rule,delete_rule FROM information_schema.referential_constraints WHERE constraint_catalog=current_database() AND constraint_schema=?',
    [schema],
  )
  const foreignKeys: ForeignKeyInfo[] = []
  for (const key of keys.filter((key) => key.constraint_type === 'FOREIGN KEY')) {
    const reference = references.filter((reference) => reference.constraint_name === key.constraint_name)
    if (reference.length !== 1 || !reference[0].unique_constraint_schema) continue
    const source = (key.constraint_column_names as { items: DuckDBValue[] }).items.map(String)
    const target = (key.referenced_column_names as { items: DuckDBValue[] }).items.map(String)
    if (!source.length || source.length !== target.length || !key.referenced_table) continue
    foreignKeys.push({
      name: String(key.constraint_name),
      columns: source,
      referencedSchema: String(reference[0].unique_constraint_schema),
      referencedTable: String(key.referenced_table),
      referencedColumns: target,
      onUpdate: String(reference[0].update_rule),
      onDelete: String(reference[0].delete_rule),
    })
  }
  return {
    columns: columns.map((column) => ({
      name: String(column.column_name),
      type: String(column.data_type),
      nullable: !!column.is_nullable,
      defaultValue: column.column_default === null ? null : String(column.column_default),
      primaryKey: keyNames.includes(String(column.column_name)),
      ...(keyNames.includes(String(column.column_name))
        ? { primaryKeyPosition: keyNames.indexOf(String(column.column_name)) + 1 }
        : {}),
    })),
    indexes: indexes.map((index) => ({ name: String(index.index_name), definition: String(index.sql) })),
    constraints: keys.map((key) => ({
      name: String(key.constraint_name),
      definition: String(key.constraint_text),
    })),
    foreignKeys,
    ddl: String(objects[0].sql),
  }
}
interface Budget {
  bytes: number
  rows: number
}
async function collect(
  result: DuckDBResult,
  current: Session,
  maxRows: number,
  budget: Budget,
): Promise<ResultSet> {
  const isRows = result.returnType === ResultReturnType.QUERY_RESULT
  const set: ResultSet = {
    columns: isRows
      ? result.columnNames().map((name, index) => ({ name, type: String(result.columnType(index)) }))
      : [],
    rows: [],
    affectedRows: 0,
    command: StatementType[result.statementType],
    truncated: false,
  }
  for await (const chunk of result) {
    checkCancelled(current)
    if (!isRows) continue
    set.affectedRows += chunk.rowCount
    for (let index = 0; index < chunk.rowCount; index++) {
      if (budget.rows >= maxRows || budget.bytes >= MAX_BYTES) {
        set.truncated = true
        continue
      }
      const row = set.columns.map((_, column) => cell(chunk.getColumnVector(column).getItem(index)))
      const size = Buffer.byteLength(JSON.stringify(row))
      if (budget.bytes + size > MAX_BYTES) {
        set.truncated = true
        continue
      }
      set.rows.push(row)
      budget.bytes += size
      budget.rows++
    }
  }
  if (!isRows) set.affectedRows = result.rowsChanged
  return set
}
function transactionCommand(sql: string): 'begin' | 'commit' | 'rollback' {
  const text = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ').trim()
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(text)) return 'begin'
  if (/^(COMMIT|END)\b/i.test(text)) return 'commit'
  if (/^ROLLBACK\b/i.test(text)) return 'rollback'
  throw new Error('Use the transaction toolbar for this transaction statement.')
}
async function execute(
  current: Session,
  parts: string[],
  values: BoundValue[],
  maxRows: number,
): Promise<ResultSet[]> {
  if (parts.length > 100 || (values.length && parts.length !== 1))
    throw new Error('Use at most 100 statements; parameterized execution requires one statement.')
  const sets: ResultSet[] = []
  const budget = { rows: 0, bytes: 0 }
  for (const sql of parts) {
    checkCancelled(current)
    const extracted = await current.db.extractStatements(sql)
    if (extracted.count !== 1)
      throw new Error('The native parser disagreed with the statement boundary. Run a single statement.')
    const statement = await extracted.prepare(0)
    try {
      const kind = statement.statementType
      if (
        [
          StatementType.ATTACH,
          StatementType.DETACH,
          StatementType.LOAD,
          StatementType.EXTENSION,
          StatementType.UPDATE_EXTENSIONS,
          StatementType.EXPORT,
          StatementType.COPY_DATABASE,
          StatementType.PREPARE,
          StatementType.EXECUTE,
        ].includes(kind)
      )
        throw new Error(
          'This operation requires external scope or execution context that is not supported. Use the reviewed local-file workflow.',
        )
      if (
        options.readOnly &&
        ![StatementType.SELECT, StatementType.EXPLAIN, StatementType.TRANSACTION].includes(kind)
      )
        throw new Error('This connection is read-only.')
      const transaction = kind === StatementType.TRANSACTION ? transactionCommand(sql) : undefined
      if (values.length !== statement.parameterCount)
        throw new Error(`Expected ${statement.parameterCount} parameters; received ${values.length}.`)
      if (values.length) statement.bind(values.map(bound))
      const result = await statement.stream()
      sets.push(await collect(result, current, maxRows, budget))
      if (transaction) current.state = transaction === 'begin' ? 'open' : 'idle'
    } finally {
      statement.destroySync()
    }
  }
  return sets
}
async function transact(
  current: Session,
  action: 'begin' | 'commit' | 'rollback',
): Promise<{ state: TransactionState }> {
  if (action === 'begin' && current.state !== 'idle')
    throw new Error('This tab already has an open transaction.')
  if (action !== 'begin' && current.state === 'idle') throw new Error('This tab has no open transaction.')
  if (current.state === 'failed' && action === 'commit')
    throw new Error('The transaction failed. Roll it back before continuing.')
  await current.db.run(action === 'begin' ? 'BEGIN TRANSACTION' : action.toUpperCase())
  current.state = action === 'begin' ? 'open' : 'idle'
  return { state: current.state }
}
async function edits(current: Session, input: EditsInput): Promise<{ affectedRows: number }> {
  if (options.readOnly) throw new Error('This connection is read-only.')
  if (current.state !== 'idle')
    throw new Error('Commit or roll back the open transaction before applying staged edits.')
  const objects = await records(
    current.db,
    'SELECT sql FROM duckdb_tables() WHERE database_name=current_database() AND schema_name=? AND table_name=?',
    [input.schema, input.table],
  )
  if (objects.length !== 1 || /\bGENERATED\b/i.test(String(objects[0].sql)))
    throw new Error('Reviewed edits require a base table without generated columns.')
  const description = await structure(current.db, input.schema, input.table)
  const keys = description.columns.filter((column) => column.primaryKey).map((column) => column.name)
  if (!keys.length) throw new Error('Editing requires a declared primary key.')
  if (!input.changes.length || input.changes.length > 200)
    throw new Error('Review between 1 and 200 changes at a time.')
  const table = `${quote(input.schema)}.${quote(input.table)}`
  await transact(current, 'begin')
  let affectedRows = 0
  try {
    for (const change of input.changes) {
      checkCancelled(current)
      const entries = Object.entries(change.values)
      if (entries.some(([name]) => !description.columns.some((column) => column.name === name)))
        throw new Error('A changed column no longer exists. Refresh table structure.')
      let sql: string
      let values: DuckDBValue[]
      if (change.kind === 'insert') {
        sql = entries.length
          ? `INSERT INTO ${table} (${entries.map(([name]) => quote(name)).join(',')}) VALUES (${entries.map(() => '?').join(',')})`
          : `INSERT INTO ${table} DEFAULT VALUES`
        values = entries.map(([, value]) => bound(value))
      } else {
        const original = change.original
        if (!original || keys.some((key) => original[key] == null))
          throw new Error('The original row is missing its non-null primary key.')
        const where = keys.map((key) => `${quote(key)} = ?`).join(' AND ')
        const identities = keys.map((key) => bound(original[key]))
        const found = await records(current.db, `SELECT * FROM ${table} WHERE ${where} LIMIT 2`, identities)
        if (
          found.length !== 1 ||
          description.columns.some(
            (column) =>
              !(column.name in original) ||
              JSON.stringify(cell(found[0][column.name])) !== JSON.stringify(original[column.name]),
          )
        )
          throw new Error(
            'Conflict: the original row changed or was removed. No changes were saved; reload and review it.',
          )
        if (change.kind === 'delete') {
          sql = `DELETE FROM ${table} WHERE ${where}`
          values = identities
        } else {
          if (!entries.length) continue
          sql = `UPDATE ${table} SET ${entries.map(([name]) => `${quote(name)}=?`).join(',')} WHERE ${where}`
          values = [...entries.map(([, value]) => bound(value)), ...identities]
        }
      }
      const result = await current.db.run(sql, values.length ? values : undefined)
      if (result.rowsChanged !== 1)
        throw new Error('The write did not affect exactly one row. No changes were saved.')
      affectedRows += result.rowsChanged
    }
    checkCancelled(current)
    await transact(current, 'commit')
    return { affectedRows }
  } catch (error) {
    await current.db.run('ROLLBACK').catch(() => {})
    current.state = 'idle'
    throw error
  }
}

async function localFile(current: Session, request: DuckDBWorkerRequest): Promise<unknown> {
  const grant = request.grant!
  if (!['csv', 'json', 'parquet'].includes(grant.format)) throw new Error('Unsupported local-file format.')
  if (request.action === 'importFile' && (options.readOnly || current.state !== 'idle'))
    throw new Error('Import requires writes enabled and an idle transaction.')
  await protectedFile(grant.path, grant.device, grant.inode)
  const sourceIdentity = await stat(grant.path)
  if (sourceIdentity.size !== grant.size || sourceIdentity.mtimeMs !== grant.mtimeMs || sourceIdentity.ctimeMs !== grant.ctimeMs)
    throw new Error('The granted source file changed. Select it again before preview or import.')
  // A separate instance receives only this exact native-picked path. Arbitrary editor
  // SQL never runs here and cannot amend the allowlist or reuse this reader connection.
  // allowed_paths is SQL-only configuration in this pinned driver. Enable access
  // only on a new empty memory instance while installing the trusted grant, then
  // disable and lock it before opening the file or executing any content.
  const readerInstance = await DuckDBInstance.create(':memory:', {
    ...config(false),
    enable_external_access: 'true',
  })
  let importing = false
  try {
    const reader = await readerInstance.connect()
    current.reader = reader
    await reader.run(
      `SET allowed_paths = ['${grant.path.replaceAll("'", "''")}']; SET allowed_directories = []; SET enable_logging=false; SET enable_external_access=false; SET lock_configuration=true`,
    )
    const fn = grant.format === 'csv' ? 'read_csv' : grant.format === 'json' ? 'read_json' : 'read_parquet'
    if (request.action === 'previewFile') {
      // LIMIT is part of the fixed preview query's work contract; do not scan a whole
      // enormous file just to display 200 rows.
      const preview = await reader.stream(`SELECT * FROM ${fn}(?) LIMIT ?`, [
        grant.path,
        Math.min(request.maxRows || 200, 1000) + 1,
      ])
      return [await collect(preview, current, Math.min(request.maxRows || 200, 1000), { bytes: 0, rows: 0 })]
    }
    const result = await reader.stream(`SELECT * FROM ${fn}(?)`, [grant.path])
    checkCancelled(current)
    const names = result.columnNames()
    const types = result.columnTypes()
    if (!names.length || new Set(names).size !== names.length)
      throw new Error('Import requires unique source column names.')
    await transact(current, 'begin')
    importing = true
    const schema = request.schema || 'main'
    const table = request.table!
    const ddl = `CREATE TABLE ${quote(schema)}.${quote(table)} (${names.map((name, index) => `${quote(name)} ${types[index]}`).join(',')})`
    const extracted = await current.db.extractStatements(ddl)
    if (extracted.count !== 1) throw new Error('Cannot safely represent the source schema.')
    await current.db.run(ddl)
    const appender = await current.db.createAppender(table, schema)
    let affectedRows = 0
    try {
      for await (const chunk of result) {
        checkCancelled(current)
        appender.appendDataChunk(chunk)
        affectedRows += chunk.rowCount
      }
      appender.closeSync()
    } catch (error) {
      appender.clear()
      appender.closeSync()
      throw error
    }
    checkCancelled(current)
    await protectedFile(grant.path, grant.device, grant.inode)
    const finalIdentity = await stat(grant.path)
    if (finalIdentity.size !== grant.size || finalIdentity.mtimeMs !== grant.mtimeMs || finalIdentity.ctimeMs !== grant.ctimeMs)
      throw new Error('The granted source file changed during import.')
    await transact(current, 'commit')
    importing = false
    return { affectedRows }
  } catch (error) {
    if (importing) {
      await current.db.run('ROLLBACK').catch(() => {})
      current.state = 'idle'
    }
    throw error
  } finally {
    current.reader?.closeSync()
    current.reader = undefined
    readerInstance.closeSync()
  }
}
async function stream(current: Session, request: DuckDBWorkerRequest): Promise<void> {
  checkCancelled(current)
  if (request.parts?.length !== 1) throw new Error('Export requires exactly one read-only statement.')
  await current.db.run('BEGIN TRANSACTION READ ONLY')
  current.state = 'open'
  const extracted = await current.db.extractStatements(request.parts[0])
  if (extracted.count !== 1) throw new Error('Export requires one native statement.')
  const prepared = await extracted.prepare(0)
  const emit = (value: NonNullable<DuckDBWorkerResponse['stream']>) =>
    new Promise<void>((resolve, reject) => {
      current.ack = { resolve, reject }
      port.postMessage({
        id: request.id,
        transaction: current.state,
        stream: value,
      } satisfies DuckDBWorkerResponse)
    })
  try {
    if (![StatementType.SELECT, StatementType.EXPLAIN].includes(prepared.statementType))
      throw new Error('Export requires a read-only SELECT or EXPLAIN statement.')
    const values = request.values || []
    if (prepared.parameterCount !== values.length)
      throw new Error('Export parameter count does not match the query.')
    if (values.length) prepared.bind(values.map(bound))
    const result = await prepared.stream()
    const columns = result
      .columnNames()
      .map((name, index) => ({ name, type: String(result.columnType(index)) }))
    await emit({ columns })
    checkCancelled(current)
    for await (const chunk of result) {
      for (let index = 0; index < chunk.rowCount; index++) {
        checkCancelled(current)
        const row = columns.map((_, column) => cell(chunk.getColumnVector(column).getItem(index)))
        if (Buffer.byteLength(JSON.stringify(row)) > MAX_BYTES)
          throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
        await emit({ row })
      }
    }
  } finally {
    prepared.destroySync()
  }
}
async function dispatch(request: DuckDBWorkerRequest): Promise<void> {
  if (request.action === 'ack') {
    const current = sessions.get(request.sessionId)
    if (current && current.busy === request.targetId && current.ack) {
      const ack = current.ack
      current.ack = undefined
      if (request.error) ack.reject(new Error(request.error))
      else ack.resolve()
    }
    return
  }
  if (request.action === 'cancel') {
    const current = sessions.get(request.sessionId)
    const active = activeRequests.get(request.sessionId)
    const requested = !!active && active.id === request.targetId
    if (requested) {
      active!.cancelled = true
      if (current) {
        current.cancelled = true
        current.db.interrupt()
        current.reader?.interrupt()
        current.ack?.reject(new Error('Export cancelled.'))
        current.ack = undefined
      }
    }
    port.postMessage({
      id: request.id,
      value: {
        requested,
        message: requested
          ? 'Native interruption requested. Await the query result for its outcome.'
          : 'No matching operation is running.',
      },
      transaction: current?.state || 'idle',
    } satisfies DuckDBWorkerResponse)
    return
  }
  if (request.action === 'close') {
    closing = true
    for (const current of sessions.values()) {
      current.cancelled = true
      current.db.interrupt()
      current.reader?.interrupt()
      current.ack?.reject(new Error('DuckDB connection closed.'))
      current.ack = undefined
    }
    while (activeRequests.size) await new Promise((done) => setTimeout(done, 5))
    await Promise.allSettled(pendingSessions.values())
    for (const current of sessions.values()) {
      if (current.state !== 'idle') await current.db.run('ROLLBACK').catch(() => {})
      current.db.closeSync()
    }
    sessions.clear()
    instance.closeSync()
    port.postMessage({ id: request.id, transaction: 'idle' } satisfies DuckDBWorkerResponse)
    port.close()
    return
  }
  let current: Session | undefined
  try {
    if (closing) throw new Error('DuckDB connection is closing.')
    if (activeRequests.has(request.sessionId)) throw new Error('This tab already has a running operation.')
    activeRequests.set(request.sessionId, { id: request.id, cancelled: false })
    current = await session(request.sessionId)
    if (current.busy) throw new Error('This tab already has a running operation.')
    current.busy = request.id
    current.cancelled = !!activeRequests.get(request.sessionId)?.cancelled
    if (request.action !== 'stream') checkCancelled(current)
    let value: unknown
    switch (request.action) {
      case 'query':
        value = await execute(current, request.parts || [], request.values || [], request.maxRows || 1000)
        break
      case 'stream':
        try {
          value = await stream(current, request)
        } finally {
          await current.db.run('ROLLBACK').catch(() => {})
          current.state = 'idle'
          current.db.closeSync()
          sessions.delete(request.sessionId)
        }
        break
      case 'objects':
        value = (
          await records(
            current.db,
            "SELECT schema_name,table_name AS name,'table' AS kind FROM duckdb_tables() WHERE database_name=current_database() AND NOT internal UNION ALL SELECT schema_name,view_name AS name,'view' AS kind FROM duckdb_views() WHERE database_name=current_database() AND NOT internal UNION ALL SELECT schema_name,sequence_name AS name,'sequence' AS kind FROM duckdb_sequences() WHERE database_name=current_database() ORDER BY schema_name,kind,name",
          )
        )
          .filter((row) => !request.schema || row.schema_name === request.schema)
          .map((row): ObjectInfo => ({
            schema: String(row.schema_name),
            name: String(row.name),
            kind: row.kind as ObjectInfo['kind'],
          }))
        break
      case 'structure':
        value = await structure(current.db, request.schema || 'main', request.table!)
        break
      case 'edits':
        value = await edits(current, request.edits!)
        break
      case 'transaction':
        value = await transact(current, request.transaction!)
        break
      case 'previewFile':
      case 'importFile':
        value = await localFile(current, request)
        break
      case 'closeSession':
        if (current.state !== 'idle') await current.db.run('ROLLBACK').catch(() => {})
        current.db.closeSync()
        sessions.delete(request.sessionId)
        current.state = 'idle'
        break
    }
    port.postMessage({ id: request.id, value, transaction: current.state } satisfies DuckDBWorkerResponse)
  } catch (error) {
    if (current?.cancelled) {
      if (current.state !== 'idle') await current.db.run('ROLLBACK').catch(() => {})
      current.state = 'idle'
    } else if (current?.state === 'open') current.state = 'failed'
    port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : 'DuckDB operation failed.',
      cancelled: !!current?.cancelled,
      transaction: current?.state || 'idle',
    } satisfies DuckDBWorkerResponse)
  } finally {
    if (activeRequests.get(request.sessionId)?.id === request.id) activeRequests.delete(request.sessionId)
    if (current?.busy === request.id) {
      current.busy = undefined
    }
  }
}

try {
  if (options.mode === 'memory') instance = await DuckDBInstance.create(':memory:', config(false))
  else {
    if (options.mode === 'create') {
      if (options.readOnly) throw new Error('Creating a DuckDB file requires writes enabled.')
      const temporary = await mkdtemp(join(dirname(options.path), '.harbor-duckdb-create-'))
      try {
        const tempPath = join(temporary, 'new.duckdb')
        const created = await DuckDBInstance.create(tempPath, config(false))
        created.closeSync()
        await chmod(tempPath, 0o600)
        // Exclusive hard-link creation cannot overwrite a pre-existing destination.
        await link(tempPath, options.path)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
    await protectedFile(options.path, options.device, options.inode)
    instance = await DuckDBInstance.create(options.path, config(options.readOnly))
  }
  const metadata = await session('_metadata')
  await metadata.db.run('SET enable_logging=false; SET lock_configuration=true')
  const version = String((await records(metadata.db, 'SELECT version() AS version'))[0].version)
  port.postMessage({ ready: true, version })
  port.on('message', (request: DuckDBWorkerRequest) => {
    void dispatch(request)
  })
} catch (error) {
  port.postMessage({
    ready: false,
    error: error instanceof Error ? error.message : 'DuckDB could not start.',
  })
  for (const current of sessions.values()) current.db.closeSync()
  instance?.closeSync()
  port.close()
}
