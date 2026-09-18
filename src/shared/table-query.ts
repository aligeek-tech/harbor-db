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
  if (dialect === 'trino') return `from_utf8(from_hex('${Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')}'))`
  if (dialect !== 'postgres' && dialect !== 'duckdb') {
    const hex = Array.from(new TextEncoder().encode(value), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return dialect === 'sqlite' ? `CAST(X'${hex}' AS TEXT)` : `CONVERT(X'${hex}' USING utf8mb4)`
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
  const keys = structure.columns
    .filter((column) => column.primaryKey)
    .sort((a, b) => (a.primaryKeyPosition ?? Infinity) - (b.primaryKeyPosition ?? Infinity))
    .map((column) => column.name)
  const fragments: Fragment[] = [`SELECT * FROM ${qualifiedName(input.schema, input.table, dialect)}`]
  if (input.filters && input.filter)
    throw new Error('Choose a structured filter or a legacy filter, not both.')
  const filters = input.filters?.conditions || (input.filter ? [input.filter] : [])
  if (filters.length > 20) throw new Error('At most twenty server filter conditions are supported.')
  if (filters.length) fragments.push('\nWHERE (')
  for (const [index, filter] of filters.entries()) {
    if (!columns.has(filter.column)) throw new Error('Filter column is not in this table.')
    if (index) fragments.push(input.filters?.match === 'any' ? ' OR ' : ' AND ')
    const column = quoteIdentifier(filter.column, dialect)
    if (filter.operator === 'is null' || filter.operator === 'is not null')
      fragments.push(`${column} ${filter.operator === 'is null' ? 'IS NULL' : 'IS NOT NULL'}`)
    else if (filter.operator === 'contains')
      fragments.push(
        `CAST(${column} AS ${dialect === 'trino' ? 'VARCHAR' : ['postgres', 'sqlite', 'duckdb'].includes(dialect) ? 'text' : 'CHAR'}) LIKE `,
        { value: '%' + filter.value.replace(/[!%_]/g, '!$&') + '%' },
        " ESCAPE '!'",
      )
    else {
      const operator = { equals: '=', 'not equals': '<>', 'greater than': '>', 'less than': '<' }[
        filter.operator
      ]
      if (!operator) throw new Error('Unsupported server filter operation.')
      fragments.push(`${column} ${operator} `, { value: filter.value })
    }
  }
  if (filters.length) fragments.push(')')
  if (input.sorts && input.sort) throw new Error('Choose structured sorting or legacy sorting, not both.')
  const requestedSorts =
    input.sorts || (input.sort ? [{ column: input.sort, direction: input.direction }] : [])
  if (
    requestedSorts.length > 8 ||
    new Set(requestedSorts.map((item) => item.column)).size !== requestedSorts.length
  )
    throw new Error('Choose up to eight distinct server sort columns.')
  const sorts = [...requestedSorts]
  // Default hypertable previews remain unsorted to avoid scanning all historical chunks.
  if (requestedSorts.length || !structure.isHypertable)
    for (const column of keys)
      if (!sorts.some((item) => item.column === column))
        sorts.push({ column, direction: input.sorts ? 'asc' : input.direction })
  if (sorts.some((item) => !columns.has(item.column))) throw new Error('Sort column is not in this table.')
  if (sorts.length)
    fragments.push(
      '\nORDER BY ' +
        sorts
          .map((item) => quoteIdentifier(item.column, dialect) + ' ' + item.direction.toUpperCase())
          .join(', '),
    )
  if (dialect === 'trino') fragments.push('\nOFFSET ', { value: input.offset }, ' LIMIT ', { value: input.limit }, ';')
  else fragments.push('\nLIMIT ', { value: input.limit }, ' OFFSET ', { value: input.offset }, ';')
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
