import type { Cell, ColumnInfo, EditsInput } from './contracts'

export interface CsvData {
  headers: string[]
  rows: Cell[][]
  lineNumbers: number[]
}
export interface CsvOptions {
  delimiter?: string
  header?: boolean
  maxRows?: number
}
interface CsvToken {
  value: string
  quoted: boolean
}

/** RFC 4180 quoting with explicit, unquoted \\N for NULL. No numeric coercion. */
export function parseCsv(source: string, options: CsvOptions = {}): CsvData {
  if (new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024)
    throw new Error('CSV imports are limited to 2 MiB. Split the file into smaller imports.')
  const delimiter = options.delimiter ?? ','
  if (delimiter.length !== 1 || ['"', '\r', '\n'].includes(delimiter))
    throw new Error('Choose a single delimiter that is not a quote or newline.')
  const maxRows = options.maxRows ?? 200
  const hasHeader = options.header ?? true
  const input = source.replace(/^\uFEFF/, '')
  const records: { tokens: CsvToken[]; line: number }[] = []
  let tokens: CsvToken[] = [],
    value = '',
    quoted = false,
    inside = false,
    closed = false
  let line = 1,
    startLine = 1,
    started = false
  const finishField = () => {
    if (value.length > 1000000)
      throw new Error(`Line ${startLine}: a field exceeds the 1,000,000-character limit.`)
    tokens.push({ value, quoted })
    value = ''
    quoted = false
    closed = false
    if (tokens.length > 200) throw new Error(`Line ${startLine}: at most 200 columns can be imported.`)
  }
  const finishRecord = () => {
    finishField()
    if (started || tokens.length > 1 || tokens[0]?.quoted) records.push({ tokens, line: startLine })
    if (records.length > maxRows + (hasHeader ? 1 : 0))
      throw new Error(`CSV imports are limited to ${maxRows} data rows. Split this file before importing.`)
    tokens = []
    started = false
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (inside) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          value += '"'
          index++
        } else {
          inside = false
          closed = true
        }
      } else {
        value += char
        if (char === '\n' || (char === '\r' && input[index + 1] !== '\n')) line++
      }
      continue
    }
    if (char === delimiter) {
      started = true
      finishField()
      continue
    }
    if (char === '\r' || char === '\n') {
      finishRecord()
      if (char === '\r' && input[index + 1] === '\n') index++
      line++
      startLine = line
      continue
    }
    if (closed) {
      if (char === ' ' || char === '\t') continue
      throw new Error(`Line ${line}: unexpected text after a closing quote.`)
    }
    if (char === '"') {
      if (value.length)
        throw new Error(
          `Line ${line}: a quote inside an unquoted field must be escaped inside a quoted field.`,
        )
      quoted = true
      inside = true
      started = true
    } else {
      value += char
      started = true
    }
  }
  if (inside) throw new Error(`Line ${startLine}: the quoted field is not closed.`)
  if (started || tokens.length || value.length || closed) finishRecord()
  if (!records.length) throw new Error('Choose a CSV file or paste CSV text to preview.')
  const first = records[0]!
  const headers = hasHeader
    ? first.tokens.map((token, index) => token.value || `Column ${index + 1}`)
    : first.tokens.map((_token, index) => `Column ${index + 1}`)
  const data = hasHeader ? records.slice(1) : records
  if (!data.length) throw new Error('The CSV contains a header but no data rows.')
  for (const record of data) {
    if (record.tokens.length !== headers.length)
      throw new Error(
        `Line ${record.line}: found ${record.tokens.length} fields; expected ${headers.length}. Check the delimiter and quoting.`,
      )
  }
  return {
    headers,
    rows: data.map((record) =>
      record.tokens.map((token) => (!token.quoted && token.value === '\\N' ? null : token.value)),
    ),
    lineNumbers: data.map((record) => record.line),
  }
}

function typeIssue(value: Cell, column: ColumnInfo): string | undefined {
  if (value === null) return column.nullable ? undefined : 'does not allow NULL'
  const raw = String(value),
    type = column.type.toLowerCase()
  if (type.includes('[')) return undefined // Array text is validated by the database without coercion.
  if (
    /^(?:smallint|integer|bigint|int\d*|tinyint|mediumint|serial|bigserial|smallserial)\b/.test(type) &&
    !/^[+-]?\d+$/.test(raw)
  )
    return 'requires a whole number'
  if (
    /^(?:numeric|decimal|real|double|float)\b/.test(type) &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
  )
    return 'requires a decimal number'
  if (/^bool(?:ean)?\b/.test(type) && !/^(?:true|false|t|f|1|0)$/i.test(raw))
    return 'requires true, false, t, f, 1, or 0'
  if (/^jsonb?\b/.test(type)) {
    try {
      JSON.parse(raw)
    } catch {
      return 'requires valid JSON'
    }
  }
  return undefined
}

export function prepareCsvInserts(
  csv: CsvData,
  mapping: string[],
  columns: ColumnInfo[],
): EditsInput['changes'] {
  if (mapping.length !== csv.headers.length)
    throw new Error('Map every CSV column or select “Skip this column”.')
  const selected = mapping.filter(Boolean)
  if (!selected.length) throw new Error('Map at least one CSV column to a destination column.')
  if (new Set(selected).size !== selected.length)
    throw new Error('A destination column can only be mapped once.')
  const metadata = new Map(columns.map((column) => [column.name, column]))
  for (const name of selected)
    if (!metadata.has(name))
      throw new Error(`The destination column “${name}” no longer exists. Refresh the table structure.`)
  const issues: string[] = []
  const changes = csv.rows.map((row, rowIndex) => {
    const pairs: [string, Cell][] = []
    mapping.forEach((name, columnIndex) => {
      if (!name) return
      const value = row[columnIndex]!
      const problem = typeIssue(value, metadata.get(name)!)
      if (problem && issues.length < 20)
        issues.push(`Line ${csv.lineNumbers[rowIndex]}, ${name}: ${problem}.`)
      pairs.push([name, value])
    })
    return { kind: 'insert' as const, values: Object.fromEntries(pairs) }
  })
  if (issues.length) throw new Error(issues.join('\n'))
  return changes
}
