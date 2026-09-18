import type { ResultSet } from './contracts'
import { parameterValue, type QueryParameter } from './parameters'
import { qualifiedName, quoteIdentifier, type SqlDialect } from './sql'

/** Ordered source/target columns from authoritative database catalog metadata. */
export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedDatabase?: string
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate?: string
  onDelete?: string
}
export interface RelatedRecordTarget {
  database?: string
  schema: string
  table: string
  relation: string
  sql: string
  parameters: QueryParameter[]
}
export type RelatedRecordAvailability =
  { target: RelatedRecordTarget; reason?: never } | { target?: never; reason: string }

/** Never infer relationships from labels or interpolate cell values into SQL. */
export function relatedRecordTarget(
  key: ForeignKeyInfo,
  result: ResultSet,
  rowIndex: number | undefined,
  dialect: SqlDialect,
  database?: string,
): RelatedRecordAvailability {
  if (rowIndex === undefined || !result.rows[rowIndex])
    return { reason: 'Select one loaded row to follow this foreign key.' }
  if (
    !key.columns.length ||
    key.columns.length !== key.referencedColumns.length ||
    new Set(key.columns).size !== key.columns.length ||
    new Set(key.referencedColumns).size !== key.referencedColumns.length ||
    !key.referencedTable ||
    key.columns.some((column) => !column) ||
    key.referencedColumns.some((column) => !column)
  )
    return { reason: 'The database did not provide a complete ordered foreign-key mapping.' }
  const parameters: QueryParameter[] = []
  for (let index = 0; index < key.columns.length; index++) {
    const matches = result.columns.flatMap((column, position) =>
      column.name === key.columns[index] ? [position] : [],
    )
    if (matches.length !== 1)
      return { reason: `Source column ${key.columns[index]} is missing or ambiguous in these results.` }
    const column = result.columns[matches[0]],
      value = result.rows[rowIndex][matches[0]]
    if (value === null) return { reason: 'A foreign-key value is NULL; this row has no referenced tuple.' }
    if (value === undefined) return { reason: 'The complete foreign-key tuple is not loaded.' }
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      return { reason: 'A key value cannot be represented exactly; reload it with a lossless value type.' }
    const type: QueryParameter['type'] =
      typeof value === 'object'
        ? 'binary'
        : typeof value === 'boolean'
          ? 'boolean'
          : /int/i.test(column.type)
            ? 'integer'
            : /numeric|decimal|float|double|real/i.test(column.type)
              ? 'decimal'
              : 'text'
    const parameter: QueryParameter = {
      name: `foreign_key_${index + 1}`,
      type,
      secret: true,
      value: typeof value === 'object' ? value.base64 : String(value),
    }
    try {
      parameterValue(parameter)
    } catch {
      return { reason: `Source column ${key.columns[index]} has an unsupported key value.` }
    }
    parameters.push(parameter)
  }
  return {
    target: {
      database: key.referencedDatabase || database,
      schema: key.referencedSchema,
      table: key.referencedTable,
      relation: key.name,
      sql: `SELECT ${dialect === 'mssql' ? 'TOP (200) ' : ''}* FROM ${qualifiedName(key.referencedSchema, key.referencedTable, dialect)}\nWHERE ${key.referencedColumns.map((column, index) => `${quoteIdentifier(column, dialect)} = ${dialect === 'postgres' ? `$${index + 1}` : dialect === 'mssql' ? `@foreign_key_${index + 1}` : '?'}`).join(' AND ')}${dialect === 'mssql' ? ';' : '\nLIMIT 200;'}`,
      parameters,
    },
  }
}
