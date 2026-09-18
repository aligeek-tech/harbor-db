import type { Cell, ResultColumn } from './contracts'
import { compareCells } from './result-sort'

export type GridSort = { index: number; column: string; direction: 'asc' | 'desc' }
export type GridFilterOperator =
  'contains' | 'equals' | 'not equals' | 'greater than' | 'less than' | 'is null' | 'is not null' | 'is empty'
export type GridFilter = { index: number; operator: GridFilterOperator; value: string }
export const gridFilterOperators: GridFilterOperator[] = [
  'contains',
  'equals',
  'not equals',
  'greater than',
  'less than',
  'is null',
  'is not null',
  'is empty',
]
export const numericColumn = (column: ResultColumn) =>
  /int|numeric|decimal|float|double|real/i.test(column.type)
export const cellText = (value: Cell): string =>
  value === null ? 'NULL' : typeof value === 'object' ? value.base64 : String(value)

/** Ordinals are identities: repeated labels must never collapse columns. */
export function gridColumnLabel(columns: ResultColumn[], index: number): string {
  const column = columns[index]
  return columns.filter((item) => item.name === column.name).length > 1
    ? `${column.name} (column ${index + 1})`
    : column.name
}

export function matchesGridFilter(row: Cell[], columns: ResultColumn[], filter: GridFilter): boolean {
  const column = columns[filter.index]
  if (!column) return false
  const value = row[filter.index]
  if (filter.operator === 'is null') return value === null
  if (filter.operator === 'is not null') return value !== null
  if (filter.operator === 'is empty') return value === ''
  if (value === null) return false
  if (filter.operator === 'contains')
    return cellText(value).toLowerCase().includes(filter.value.toLowerCase())
  const order = compareCells(value, filter.value, numericColumn(column))
  if (filter.operator === 'equals') return order === 0
  if (filter.operator === 'not equals') return order !== 0
  return filter.operator === 'greater than' ? order > 0 : order < 0
}

export function compareGridRows(
  left: { values: Cell[]; index: number },
  right: { values: Cell[]; index: number },
  columns: ResultColumn[],
  sorts: GridSort[],
): number {
  for (const sort of sorts) {
    const column = columns[sort.index]
    if (!column || column.name !== sort.column) continue
    const order = compareCells(left.values[sort.index], right.values[sort.index], numericColumn(column))
    if (order) return order * (sort.direction === 'asc' ? 1 : -1)
  }
  return left.index - right.index
}

/** CSV protects spreadsheet formulas; JSON retains types and duplicate labels. */
export function gridClipboard(
  format: 'tsv' | 'csv' | 'json',
  columns: ResultColumn[],
  rows: Cell[][],
): string {
  if (format === 'json') return JSON.stringify({ columns, rows }, null, 2)
  const quote = (value: Cell) => {
    let text = cellText(value)
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return /["\r\n,\t]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const delimiter = format === 'csv' ? ',' : '\t'
  const data: Cell[][] = format === 'csv' ? [columns.map((column) => column.name), ...rows] : rows
  return data.map((row) => row.map(quote).join(delimiter)).join('\n')
}

export function inspectCell(value: Cell, mode: 'raw' | 'json' | 'hex'): string {
  if (value === null) return 'NULL (no value)'
  if (value === '') return 'Empty string (0 characters)'
  if (typeof value === 'object') {
    if (mode === 'hex') {
      try {
        return Array.from(atob(value.base64), (char) =>
          char.charCodeAt(0).toString(16).padStart(2, '0'),
        ).join(' ')
      } catch {
        return 'Invalid base64 data; use the raw view to inspect it.'
      }
    }
    return value.base64
  }
  if (mode === 'json') {
    try {
      const source = String(value)
      // Parse only to validate syntax. Re-serializing would round large numeric
      // literals, so formatting retains every token exactly as received.
      JSON.parse(source)
      let output = '',
        depth = 0,
        quoted = false,
        escaped = false
      for (let index = 0; index < source.length; index++) {
        if (depth > 100 || output.length > 2000000)
          return 'Formatted preview limit reached. Use the raw view for the unchanged complete value.'
        const char = source[index]
        if (quoted) {
          output += char
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (/\s/.test(char)) continue
        if (char === '"') {
          quoted = true
          output += char
        } else if (char === '{' || char === '[') {
          output += char
          depth++
          if (!/^[\s]*[}\]]/.test(source.slice(index + 1))) output += '\n' + '  '.repeat(depth)
        } else if (char === '}' || char === ']') {
          depth--
          if (!/[{[]$/.test(output)) output += '\n' + '  '.repeat(depth)
          output += char
        } else if (char === ',') output += ',\n' + '  '.repeat(depth)
        else if (char === ':') output += ': '
        else output += char
      }
      return output
    } catch {
      return 'This value is not valid JSON. Use the raw view for the unchanged value.'
    }
  }
  return String(value)
}
