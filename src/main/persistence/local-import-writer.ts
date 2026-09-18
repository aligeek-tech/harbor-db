import type { Cell, ConnectionProfile, QueryInput } from '../../shared/contracts'
import { importTargetConfirmation, type ImportTarget } from '../../shared/imports'
import type { QueryParameter } from '../../shared/parameters'
import { qualifiedName } from '../../shared/sql'
import type { SqliteService } from '../engines/sqlite'
import type { DuckDBService } from '../engines/duckdb'
import { ImportBatchError, validateImportNumber, type ImportWriter } from './import-writer'

type LocalService = Pick<
  SqliteService | DuckDBService,
  'execute' | 'structure' | 'listObjects' | 'closeSession' | 'getSessionState' | 'transaction'
>
function bind(value: Cell, index: number): QueryParameter {
  return {
    name: `column${index + 1}`,
    secret: true,
    type:
      value === null
        ? 'null'
        : typeof value === 'object'
          ? 'binary'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'text',
    value: value === null ? '' : typeof value === 'object' ? value.base64 : String(value),
  }
}

/** Uses existing native worker sessions, with cancellation deferred until each bounded INSERT returns. */
export async function openLocalImport(
  service: LocalService,
  profile: ConnectionProfile,
  input: ImportTarget & { columns: string[] },
  signal: AbortSignal,
): Promise<ImportWriter> {
  if (!['sqlite', 'duckdb'].includes(profile.engine) || profile.id !== input.connectionId)
    throw new Error('The local import profile does not match its target.')
  if (profile.readOnly) throw new Error('This connection is read-only.')
  if (profile.environment.toLowerCase() === 'production' && input.confirm !== importTargetConfirmation(input))
    throw new Error(
      `Type "${importTargetConfirmation(input)}" to confirm the exact production import target.`,
    )
  if (
    !input.columns.length ||
    input.columns.length > 200 ||
    new Set(input.columns).size !== input.columns.length
  )
    throw new Error('Choose 1–200 unique destination columns.')
  const structure = await service.structure(input)
  if (input.columns.some((name) => !structure.columns.some((column) => column.name === name)))
    throw new Error('A destination column no longer exists. Refresh the table structure.')
  const objects = await service.listObjects(input)
  if (
    !objects.some(
      (object) => object.name === input.table && object.schema === input.schema && object.kind === 'table',
    )
  )
    throw new Error('Batch import requires a base table; views are unsupported.')
  const sessionId = `import-${crypto.randomUUID()}`
  const target = { connectionId: input.connectionId, sessionId, database: input.database }
  let phase: 'idle' | 'writing' | 'committing' | 'closed' = 'idle'
  const query = (sql: string, parameters?: QueryParameter[], maxRows = 1) =>
    service.execute({
      ...target,
      requestId: crypto.randomUUID(),
      sql,
      parameters,
      maxRows,
      privateSession: true,
      confirm: profile.name,
    } satisfies QueryInput)
  const table = qualifiedName(input.schema, input.table, profile.engine === 'sqlite' ? 'sqlite' : 'duckdb')
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  const statement = `INSERT INTO ${table} (${input.columns.map(quote).join(',')}) VALUES (${input.columns.map(() => '?').join(',')})`
  const columnSql =
    profile.engine === 'sqlite'
      ? `SELECT name,CASE WHEN type='' THEN 'ANY' ELSE type END,CASE WHEN "notnull"=0 THEN 'true' ELSE 'false' END,dflt_value,pk,hidden,(SELECT schema_version FROM pragma_schema_version)
       FROM pragma_table_xinfo(?) WHERE hidden<>1 ORDER BY cid`
      : `SELECT column_name,data_type,CASE WHEN is_nullable THEN 'true' ELSE 'false' END,column_default,table_oid,column_index
       FROM duckdb_columns() WHERE database_name=current_database() AND schema_name=? AND table_name=? ORDER BY column_index`
  const columnParameters = (profile.engine === 'sqlite' ? [input.table] : [input.schema, input.table]).map(
    bind,
  )
  const readColumns = async () => {
    const result = await query(columnSql, columnParameters, 2001)
    if (
      result.cancelled ||
      result.sets.length !== 1 ||
      result.sets[0].truncated ||
      !result.sets[0].rows.length
    )
      throw new Error('Import column metadata is unavailable or exceeds its bound.')
    return result.sets[0].rows
  }
  let reviewedColumns: string
  try {
    const columns = await readColumns(),
      expected = structure.columns.map((column) => [
        column.name,
        column.type,
        String(column.nullable),
        column.defaultValue,
      ])
    if (JSON.stringify(columns.map((row) => row.slice(0, 4))) !== JSON.stringify(expected))
      throw new Error('The destination columns changed while opening the import writer. Preview again.')
    reviewedColumns = JSON.stringify(columns)
  } catch (error) {
    await service.closeSession(target)
    throw error
  }
  return {
    columns: structure.columns,
    writeBatch: async (rows) => {
      if (phase !== 'idle') throw new Error('The dedicated local import writer is busy or closed.')
      if (signal.aborted)
        throw new ImportBatchError('Import cancelled before this batch started.', 'rolled-back', 0)
      if (
        !rows.length ||
        rows.length > 500 ||
        rows.some((row) => row.length !== input.columns.length) ||
        Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024
      )
        throw new Error('Import batches are limited to 500 rows / 8 MiB with the reviewed column count.')
      for (const row of rows)
        row.forEach((value, index) =>
          validateImportNumber(
            value,
            structure.columns.find((column) => column.name === input.columns[index])!,
            profile.engine,
          ),
        )
      let commitSent = false
      try {
        phase = 'writing'
        const begin = await query(profile.engine === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN TRANSACTION')
        if (begin.cancelled) throw new Error('The local session ended while beginning a batch.')
        if (JSON.stringify(await readColumns()) !== reviewedColumns)
          throw new Error('The destination schema changed after review. This batch was not inserted.')
        if (profile.engine === 'sqlite') {
          const definition = await query("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?", [
            bind(input.table, 0),
          ])
          if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(definition.sets[0]?.rows[0]?.[0] ?? '')))
            throw new Error('Virtual table imports require separate transactional verification.')
        }
        for (const row of rows) {
          if (signal.aborted) throw new Error('Import cancelled.')
          const result = await query(statement, row.map(bind))
          if (result.cancelled || result.sets.reduce((total, set) => total + set.affectedRows, 0) !== 1)
            throw new Error('The imported row count was not acknowledged.')
        }
        if (signal.aborted) throw new Error('Import cancelled.')
        phase = 'committing'
        commitSent = true
        const committed = await service.transaction({ ...target, action: 'commit' })
        if (committed.state !== 'idle') throw new Error('The local COMMIT was not acknowledged.')
        phase = 'idle'
      } catch {
        let rolledBack = false
        if (!commitSent) {
          try {
            rolledBack = (await service.transaction({ ...target, action: 'rollback' })).state === 'idle'
          } catch {
            /* An unavailable worker cannot acknowledge rollback. */
          }
        }
        phase = 'idle'
        throw new ImportBatchError(
          rolledBack
            ? signal.aborted
              ? 'Import cancelled after the active native statement returned. The current batch was rolled back; earlier acknowledged batches remain committed.'
              : 'The local database rejected this batch. The batch was rolled back; imported values and driver details were omitted. No retry was attempted.'
            : 'The local batch outcome is uncertain because COMMIT or rollback could not be confirmed. Inspect the destination before retrying; no writes were replayed.',
          rolledBack ? 'rolled-back' : 'uncertain',
          rows.length,
        )
      }
    },
    close: async () => {
      phase = 'closed'
      await service.closeSession(target)
    },
  }
}
