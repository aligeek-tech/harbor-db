import type { Cell, QueryResult, TableInput, TableStructure } from './contracts'
import { qualifiedName, quoteIdentifier, type SqlDialect } from './sql'

type TableQuery = NonNullable<QueryResult['tableQuery']>
type Parameter = string | number
type Fragment = string | { value: Parameter }

/** A literal for generated table filters, independent of server backslash modes. */
export function tableSqlLiteral(value: Parameter, dialect: SqlDialect): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid table pagination value.')
    return String(value)
  }
  // eslint-disable-next-line no-control-regex -- Control bytes require explicit SQL encoding, including NUL.
  if (!/[\\\u0000-\u001f\u007f]/.test(value)) return `'${value.replaceAll("'", "''")}'`
  if (dialect === 'mariadb') {
    const hex = Array.from(new TextEncoder().encode(value), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return `CONVERT(X'${hex}' USING utf8mb4)`
  }
  // eslint-disable-next-line no-control-regex -- Preserve each control byte as an explicit PostgreSQL escape.
  const escaped = value.replace(/[\\'\u0000-\u001f\u007f]/g, (character) => {
    if (character === '\\') return '\\\\'
    if (character === "'") return "''"
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  // PostgreSQL rejects U+0000 in text both as a parameter and in this E literal;
  // never remove or replace it to manufacture a different successful filter.
  return `E'${escaped}'`
}

/** Produce driver SQL and executable editor SQL from the same structured parts. */
export function buildTableQuery(
  input: TableInput,
  structure: TableStructure,
  dialect: SqlDialect,
): TableQuery {
  const columns = new Set(structure.columns.map((column) => column.name))
  const keys = structure.columns.filter((column) => column.primaryKey).map((column) => column.name)
  const fragments: Fragment[] = [`SELECT * FROM ${qualifiedName(input.schema, input.table, dialect)}`]
  if (input.filter) {
    if (!columns.has(input.filter.column)) throw new Error('Filter column is not in this table.')
    const column = quoteIdentifier(input.filter.column, dialect)
    if (input.filter.operator === 'is null') fragments.push(`\nWHERE ${column} IS NULL`)
    else if (input.filter.operator === 'equals')
      fragments.push(`\nWHERE ${column} = `, { value: input.filter.value })
    else
      fragments.push(
        `\nWHERE CAST(${column} AS ${dialect === 'postgres' ? 'text' : 'CHAR'}) LIKE `,
        { value: '%' + input.filter.value.replace(/[!%_]/g, '!$&') + '%' },
        " ESCAPE '!'",
      )
  }
  const sorts = input.sort ? [input.sort, ...keys.filter((key) => key !== input.sort)] : keys
  if (sorts.some((column) => !columns.has(column))) throw new Error('Sort column is not in this table.')
  if (sorts.length)
    fragments.push(
      '\nORDER BY ' +
        sorts
          .map((column) => quoteIdentifier(column, dialect) + ' ' + input.direction.toUpperCase())
          .join(', '),
    )
  fragments.push('\nLIMIT ', { value: input.limit }, ' OFFSET ', { value: input.offset }, ';')
  const parameters: Cell[] = []
  const sql = fragments
    .map((part) => {
      if (typeof part === 'string') return part
      parameters.push(part.value)
      return dialect === 'postgres' ? `$${parameters.length}` : '?'
    })
    .join('')
  const editorSql = fragments
    .map((part) => (typeof part === 'string' ? part : tableSqlLiteral(part.value, dialect)))
    .join('')
  return { sql, parameters, editorSql }
}
