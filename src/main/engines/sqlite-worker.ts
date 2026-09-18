import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync, constants, type SQLInputValue } from 'node:sqlite'
import { realpathSync, statSync } from 'node:fs'
import type {
  Cell,
  EditsInput,
  ForeignKeyInfo,
  ObjectInfo,
  ResultColumn,
  ResultSet,
  TableStructure,
} from '../../shared/contracts'

export interface SqliteWorkerOptions {
  path: string
  metadataPath: string
  device: number
  inode: number
  readOnly: boolean
  busyTimeoutMs: number
}
export interface SqliteWorkerRequest {
  id: number
  action: 'query' | 'objects' | 'structure' | 'edits' | 'transaction' | 'close' | 'stream' | 'ack'
  sql?: string
  values?: SQLInputValue[]
  maxRows?: number
  table?: string
  edits?: EditsInput
  transaction?: 'begin' | 'commit' | 'rollback'
  error?: string
}
export interface SqliteWorkerResponse {
  id: number
  value?: unknown
  error?: string
  transaction: 'idle' | 'open'
  stream?: { columns?: ResultColumn[]; row?: Cell[] }
}

const MAX_BYTES = 8 * 1024 * 1024
const options = workerData as SqliteWorkerOptions
const port = parentPort!
let db!: DatabaseSync
let acknowledgement: { id: number; resolve: () => void; reject: (error: Error) => void } | undefined

function quote(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid SQLite identifier.')
  return '"' + value.replaceAll('"', '""') + '"'
}
function cell(value: unknown): Cell {
  if (value == null) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { type: 'binary', base64: Buffer.from(value).toString('base64') }
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  throw new Error('Unsupported SQLite value; refusing lossy conversion.')
}
function parameter(value: Cell): SQLInputValue {
  if (value !== null && typeof value === 'object') return Buffer.from(value.base64, 'base64')
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
}
function rows(sql: string, values: SQLInputValue[] = []): Record<string, unknown>[] {
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  return statement.all(...values)
}
function integer(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('SQLite count exceeds the safe display range.')
  return result
}
function structure(table: string): TableStructure {
  const object = rows('SELECT type,sql FROM main.sqlite_schema WHERE name=?', [table])[0]
  if (!object || !['table', 'view'].includes(String(object.type)))
    throw new Error('The selected SQLite table or view no longer exists.')
  const columns = rows(`PRAGMA main.table_xinfo(${quote(table)})`)
  const indexes = rows(`PRAGMA main.index_list(${quote(table)})`).map((index) => {
    const name = String(index.name)
    const stored = rows("SELECT sql FROM main.sqlite_schema WHERE type='index' AND name=?", [name])[0]
    const keys = rows(`PRAGMA main.index_info(${quote(name)})`).map((key) =>
      key.name == null ? '(expression)' : quote(String(key.name)),
    )
    return {
      name,
      definition:
        stored?.sql == null
          ? `${integer(index.unique) ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${quote(table)} (${keys.join(', ')})`
          : String(stored.sql),
    }
  })
  const foreignKeyRows = rows(`PRAGMA main.foreign_key_list(${quote(table)})`)
  const constraints = foreignKeyRows.map((key) => ({
    name: `foreign_key_${key.id}_${key.seq}`,
    definition: `${quote(String(key.from))} REFERENCES ${quote(String(key.table))}${key.to == null ? '' : ` (${quote(String(key.to))})`} ON UPDATE ${key.on_update} ON DELETE ${key.on_delete}`,
  }))
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const key of foreignKeyRows) {
    const id = String(key.id)
    groups.set(id, [...(groups.get(id) || []), key])
  }
  const foreignKeys: ForeignKeyInfo[] = []
  for (const [id, group] of groups) {
    group.sort((left, right) => integer(left.seq) - integer(right.seq))
    const parentTable = String(group[0].table)
    const parentKeys = rows(`PRAGMA main.table_xinfo(${quote(parentTable)})`)
      .filter((column) => integer(column.pk) > 0)
      .sort((left, right) => integer(left.pk) - integer(right.pk))
    const referencedColumns = group.map((key, index) =>
      key.to == null
        ? parentKeys.length === group.length
          ? String(parentKeys[index].name)
          : ''
        : String(key.to),
    )
    if (
      referencedColumns.some((name) => !name) ||
      group.some((key) => key.from == null || String(key.table) !== parentTable)
    )
      continue
    foreignKeys.push({
      name: `foreign_key_${id}`,
      columns: group.map((key) => String(key.from)),
      referencedSchema: 'main',
      referencedTable: parentTable,
      referencedColumns,
      onUpdate: String(group[0].on_update),
      onDelete: String(group[0].on_delete),
    })
  }
  const primary = columns
    .filter((column) => integer(column.pk) > 0)
    .sort((a, b) => integer(a.pk) - integer(b.pk))
  if (primary.length)
    constraints.unshift({
      name: 'PRIMARY KEY',
      definition: `PRIMARY KEY (${primary.map((column) => quote(String(column.name))).join(', ')})`,
    })
  return {
    columns: columns
      .filter((column) => integer(column.hidden) !== 1)
      .map((column) => ({
        name: String(column.name),
        type: String(column.type || 'ANY'),
        nullable: integer(column.notnull) === 0,
        defaultValue: column.dflt_value == null ? null : String(column.dflt_value),
        ...([2, 3].includes(integer(column.hidden)) ? { generated: true } : {}),
        primaryKey: integer(column.pk) > 0,
        ...(integer(column.pk) > 0 ? { primaryKeyPosition: integer(column.pk) } : {}),
      })),
    indexes,
    constraints,
    foreignKeys,
    ddl: String(object.sql || ''),
  }
}

function execute(sql: string, values: SQLInputValue[], maxRows: number): ResultSet[] {
  const sets: ResultSet[] = []
  let remaining = sql
  let bytes = 0
  let retained = 0
  while (remaining.trim()) {
    // SQLite itself determines statement boundaries, including trigger bodies.
    if (/^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(remaining)) break
    if (sets.length >= 100)
      throw new Error('SQLite scripts are limited to 100 statements. Earlier statements may have committed.')
    const statement = db.prepare(remaining)
    const consumed = statement.sourceSQL.length
    if (!consumed) throw new Error('SQLite could not determine the statement boundary.')
    remaining = remaining.slice(consumed)
    if (values.length && remaining.replace(/;\s*$/, '').trim())
      throw new Error('Parameterized execution requires exactly one SQLite statement.')
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement
      .columns()
      .map((column) => ({ name: column.name, type: column.type || 'expression' }))
    const command = statement.sourceSQL
      .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '')
      .split(/\s+/)[0]
      .toUpperCase()
    const set: ResultSet = { columns, rows: [], affectedRows: 0, command, truncated: false }
    if (columns.length) {
      for (const raw of statement.iterate(...values) as unknown as Iterable<unknown[]>) {
        set.affectedRows++
        if (retained >= maxRows || bytes >= MAX_BYTES) {
          set.truncated = true
          continue
        }
        const row = raw.map(cell)
        const size = Buffer.byteLength(JSON.stringify(row))
        if (bytes + size > MAX_BYTES) {
          set.truncated = true
          continue
        }
        set.rows.push(row)
        bytes += size
        retained++
      }
    } else {
      const before = rows('SELECT total_changes() AS total')[0].total
      const result = statement.run(...values)
      // SQLite changes() retains prior DML's count across DDL/transaction statements.
      set.affectedRows =
        rows('SELECT total_changes() AS total')[0].total !== before ? integer(result.changes) : 0
    }
    sets.push(set)
  }
  return sets
}
async function stream(request: SqliteWorkerRequest): Promise<void> {
  if (!options.readOnly) throw new Error('Export requires a dedicated native read-only connection.')
  db.exec('BEGIN')
  try {
    const statement = db.prepare(request.sql!)
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement
      .columns()
      .map((column) => ({ name: column.name, type: column.type || 'expression' }))
    if (!columns.length) throw new Error('Export requires a statement returning rows.')
    const emit = (value: NonNullable<SqliteWorkerResponse['stream']>) =>
      new Promise<void>((resolve, reject) => {
        acknowledgement = { id: request.id, resolve, reject }
        port.postMessage({
          id: request.id,
          transaction: 'open',
          stream: value,
        } satisfies SqliteWorkerResponse)
      })
    await emit({ columns })
    for (const raw of statement.iterate(...(request.values || [])) as unknown as Iterable<unknown[]>) {
      const row = raw.map(cell)
      if (Buffer.byteLength(JSON.stringify(row)) > MAX_BYTES)
        throw new Error('An export row exceeds the 8 MiB row limit. Partial output was not finalized.')
      await emit({ row })
    }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}

function edits(input: EditsInput): { affectedRows: number } {
  if (options.readOnly) throw new Error('This connection is read-only.')
  if (db.isTransaction)
    throw new Error('Commit or roll back the open transaction before applying staged edits.')
  if (!input.changes.length || input.changes.length > 200)
    throw new Error('Review between 1 and 200 row changes at a time.')
  const table = quote(input.table)
  const object = rows('SELECT type,sql FROM main.sqlite_schema WHERE name=?', [input.table])[0]
  if (object?.type !== 'table' || /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(object.sql)))
    throw new Error('Only ordinary SQLite base tables support reviewed edits.')
  const description = structure(input.table)
  const keys = description.columns.filter((column) => column.primaryKey).map((column) => column.name)
  if (!keys.length) throw new Error('Editing requires a declared primary key.')
  const writable = new Set(
    rows(`PRAGMA main.table_xinfo(${table})`)
      .filter((column) => integer(column.hidden) === 0)
      .map((column) => String(column.name)),
  )
  db.exec('BEGIN IMMEDIATE')
  let affectedRows = 0
  try {
    for (const change of input.changes) {
      const entries = Object.entries(change.values)
      if (entries.some(([name]) => !writable.has(name)))
        throw new Error('A changed column is missing or generated. Refresh table structure.')
      let sql: string
      let values: SQLInputValue[]
      if (change.kind === 'insert') {
        sql = entries.length
          ? `INSERT INTO main.${table} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map(() => '?').join(',')})`
          : `INSERT INTO main.${table} DEFAULT VALUES`
        values = entries.map(([, value]) => parameter(value))
      } else {
        const original = change.original
        if (!original || keys.some((key) => original[key] == null))
          throw new Error('The original row is missing a non-null primary key. No changes were saved.')
        const where = keys.map((key) => `${quote(key)} = ?`).join(' AND ')
        const identities = keys.map((key) => parameter(original[key]))
        const current = rows(`SELECT * FROM main.${table} WHERE ${where} LIMIT 2`, identities)
        if (
          current.length !== 1 ||
          description.columns.some(
            (column) =>
              !(column.name in original) ||
              JSON.stringify(cell(current[0][column.name])) !== JSON.stringify(original[column.name]),
          )
        )
          throw new Error(
            'Conflict: the original row changed or was removed. No changes were saved; reload and review it.',
          )
        if (change.kind === 'delete') {
          sql = `DELETE FROM main.${table} WHERE ${where}`
          values = identities
        } else {
          if (!entries.length) continue
          sql = `UPDATE main.${table} SET ${entries.map(([key]) => `${quote(key)} = ?`).join(',')} WHERE ${where}`
          values = [...entries.map(([, value]) => parameter(value)), ...identities]
        }
      }
      const affected = integer(db.prepare(sql).run(...values).changes)
      if (affected !== 1)
        throw new Error(`Write affected ${affected} rows instead of one. No changes were saved.`)
      affectedRows += affected
    }
    db.exec('COMMIT')
    return { affectedRows }
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

try {
  const identity = statSync(options.path)
  if (identity.dev !== options.device || identity.ino !== options.inode || !identity.isFile())
    throw new Error('The SQLite file changed before it could be opened; select it again.')
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const protectedPath = options.metadataPath + suffix
    try {
      const protectedIdentity = statSync(protectedPath)
      if (
        (protectedIdentity.dev === identity.dev && protectedIdentity.ino === identity.ino) ||
        realpathSync(protectedPath) === realpathSync(options.path)
      )
        throw new Error('Harbor application metadata cannot be opened as a managed database.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  db = new DatabaseSync(options.path, {
    readOnly: options.readOnly,
    timeout: options.busyTimeoutMs,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    defensive: true,
  })
  if (typeof db.setAuthorizer !== 'function')
    throw new Error('SQLite requires Node.js 24.10 or newer for file-access safeguards.')
  db.exec('PRAGMA trusted_schema=OFF')
  if (options.readOnly) db.exec('PRAGMA query_only=ON')
  const limits = (db as DatabaseSync & { limits?: { length: number; sqlLength: number; attach: number } })
    .limits
  if (limits) {
    limits.length = MAX_BYTES
    limits.sqlLength = 1000000
    limits.attach = 0
  }
  const readablePragmas = new Set([
    'table_info',
    'table_xinfo',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
    'database_list',
    'compile_options',
    'schema_version',
    'user_version',
    'quick_check',
    'integrity_check',
  ])
  const argumentPragmas = new Set([
    'table_info',
    'table_xinfo',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
    'quick_check',
    'integrity_check',
  ])
  const forbidden = new Set([
    constants.SQLITE_ATTACH,
    constants.SQLITE_DETACH,
    constants.SQLITE_CREATE_VTABLE,
    constants.SQLITE_DROP_VTABLE,
  ])
  db.setAuthorizer((action, first, second) => {
    if (forbidden.has(action)) return constants.SQLITE_DENY
    if (
      action === constants.SQLITE_FUNCTION &&
      ['load_extension', 'readfile', 'writefile', 'edit'].includes((second || first || '').toLowerCase())
    )
      return constants.SQLITE_DENY
    if (
      action === constants.SQLITE_PRAGMA &&
      (!readablePragmas.has((first || '').toLowerCase()) ||
        (second !== null && !argumentPragmas.has((first || '').toLowerCase())))
    )
      return constants.SQLITE_DENY
    return constants.SQLITE_OK
  })
  const version = String(rows('SELECT sqlite_version() AS version')[0].version)
  port.postMessage({ ready: true, version })
  port.on('message', (request: SqliteWorkerRequest) => {
    if (request.action === 'ack') {
      if (acknowledgement?.id === request.id) {
        const ack = acknowledgement
        acknowledgement = undefined
        if (request.error) ack.reject(new Error(request.error))
        else ack.resolve()
      }
      return
    }
    if (request.action === 'stream') {
      void stream(request).then(
        () => port.postMessage({ id: request.id, transaction: 'idle' } satisfies SqliteWorkerResponse),
        (error) =>
          port.postMessage({
            id: request.id,
            transaction: 'idle',
            error: error instanceof Error ? error.message : 'SQLite export failed.',
          } satisfies SqliteWorkerResponse),
      )
      return
    }
    try {
      let value: unknown
      switch (request.action) {
        case 'query':
          value = execute(request.sql!, request.values || [], request.maxRows || 1000)
          break
        case 'objects':
          value = rows(
            "SELECT name,type FROM main.sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END,name",
          ).map((row): ObjectInfo => ({
            name: String(row.name),
            schema: 'main',
            kind: row.type as ObjectInfo['kind'],
          }))
          break
        case 'structure':
          value = structure(request.table!)
          break
        case 'edits':
          value = edits(request.edits!)
          break
        case 'transaction':
          if (request.transaction === 'begin' && db.isTransaction)
            throw new Error('This tab already has an open transaction.')
          if (request.transaction !== 'begin' && !db.isTransaction)
            throw new Error('This tab has no open transaction.')
          db.exec(
            request.transaction === 'begin'
              ? 'BEGIN'
              : request.transaction === 'commit'
                ? 'COMMIT'
                : 'ROLLBACK',
          )
          value = { state: db.isTransaction ? 'open' : 'idle' }
          break
        case 'close':
          if (db.isTransaction) db.exec('ROLLBACK')
          db.close()
          port.postMessage({ id: request.id, value: undefined, transaction: 'idle' })
          port.close()
          return
      }
      port.postMessage({
        id: request.id,
        value,
        transaction: db.isTransaction ? 'open' : 'idle',
      } satisfies SqliteWorkerResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : 'SQLite operation failed.',
        transaction: db.isTransaction ? 'open' : 'idle',
      } satisfies SqliteWorkerResponse)
    }
  })
} catch (error) {
  port.postMessage({
    ready: false,
    error: error instanceof Error ? error.message : 'SQLite worker could not start.',
  })
  if (db?.isOpen) db.close()
  port.close()
}
