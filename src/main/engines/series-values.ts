import { isLosslessNumber, parse, stringify } from 'lossless-json'
import type { Cell } from '../../shared/contracts'
import type { SeriesSet } from '../../shared/time-series'

export function seriesJson(text: string): Record<string, unknown> {
  try {
    const value = parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value)) throw 0
    return value as Record<string, unknown>
  } catch {
    throw new Error('Invalid time-series JSON. Response contents are omitted.')
  }
}
export function questSet(value: Record<string, unknown>): SeriesSet {
  if (value.error)
    throw new Error('QuestDB rejected the statement. Server details are omitted to protect query data.')
  if (!Array.isArray(value.columns) || !Array.isArray(value.dataset)) {
    if (value.ddl === 'OK' || value.dml === 'OK') return { columns: [], rows: [], group: {} }
    throw new Error('QuestDB did not acknowledge a typed result or command.')
  }
  if (value.columns.length > 512 || value.dataset.length > 5002)
    throw new Error('QuestDB result exceeds column or row bounds.')
  const columns = value.columns.map((column: unknown) => {
    const c = column as Record<string, unknown>
    if (!c || typeof c.name !== 'string' || typeof c.type !== 'string')
      throw new Error('QuestDB returned invalid column metadata.')
    // The HTTP endpoint does not carry binary values losslessly. Never turn an omitted binary into NULL.
    if (c.type === 'BINARY')
      throw new Error(
        'QuestDB HTTP cannot represent BINARY columns exactly. Select supported columns explicitly.',
      )
    return { name: c.name, type: c.type }
  })
  return {
    columns,
    group: {},
    rows: value.dataset.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== columns.length)
        throw new Error('QuestDB returned an invalid row shape.')
      return row.map((cell): Cell =>
        cell === null || typeof cell === 'string' || typeof cell === 'boolean'
          ? cell
          : isLosslessNumber(cell)
            ? cell.value
            : stringify(cell)!,
      )
    }),
  }
}
function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    atStart = true
  const pushField = () => {
    row.push(field)
    field = ''
    closed = false
    atStart = true
    if (row.length > 514) throw new Error('InfluxDB CSV exceeds 512 data columns.')
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
    if (rows.length > 30000) throw new Error('InfluxDB CSV contains too many records. Narrow the time range.')
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else field += c
    } else if (c === ',') pushField()
    else if (c === '\n') pushRow()
    else if (c === '\r' && text[i + 1] === '\n') {
      pushRow()
      i++
    } else if (c === '"' && atStart) {
      quoted = true
      atStart = false
    } else {
      if (closed || c === '"') throw new Error('Malformed InfluxDB CSV.')
      field += c
      atStart = false
    }
    if (field.length > 1024 * 1024) throw new Error('An InfluxDB field exceeds 1 MiB.')
  }
  if (quoted) throw new Error('Incomplete InfluxDB CSV.')
  if (row.length || field.length || closed) pushRow()
  return rows
}
/** Annotation-aware CSV: text values keep exact integer, timestamp and binary representations. */
export function influxSets(text: string, maxRows: number): { sets: SeriesSet[]; truncated: boolean } {
  let types: string[] = [],
    groups: string[] = [],
    defaults: string[] = [],
    names: string[] = [],
    count = 0,
    truncated = false
  const sets: SeriesSet[] = [],
    lookup = new Map<string, SeriesSet>()
  for (const row of csvRows(text)) {
    if (row.every((v) => v === '')) {
      names = []
      continue
    }
    if (row[0] === '#datatype') {
      types = row.slice(1)
      names = []
      continue
    }
    if (row[0] === '#group') {
      groups = row.slice(1)
      continue
    }
    if (row[0] === '#default') {
      defaults = row.slice(1)
      continue
    }
    if (row[0].startsWith('#')) continue
    if (!names.length) {
      names = row.slice(1)
      if (names.includes('error') && names.includes('reference'))
        throw new Error(
          'InfluxDB query failed after submission. Partial results are discarded; details are omitted.',
        )
      if (names.length !== types.length) throw new Error('InfluxDB CSV annotations do not match columns.')
      continue
    }
    const values = row
      .slice(1)
      .map((v, i) => (v === '' ? defaults[i] || (types[i] === 'string' ? '' : null) : v))
    if (values.length !== names.length) throw new Error('InfluxDB CSV row does not match columns.')
    for (let i = 0; i < values.length; i++)
      if (values[i] !== null) {
        const t = types[i],
          v = values[i]!
        if (
          (['long', 'unsignedLong', 'duration'].includes(t) && !/^-?\d+$/.test(v)) ||
          (t === 'unsignedLong' && v.startsWith('-')) ||
          (t === 'boolean' && !['true', 'false'].includes(v))
        )
          throw new Error('InfluxDB returned an invalid typed value.')
      }
    if (count >= maxRows) {
      truncated = true
      continue
    }
    const key = JSON.stringify([
      names,
      types,
      values[names.indexOf('result')],
      values[names.indexOf('table')],
    ])
    let set = lookup.get(key)
    if (!set) {
      if (sets.length >= 100)
        throw new Error('InfluxDB returned more than 100 series tables. Narrow tag filters.')
      set = {
        columns: names.map((name, i) => ({ name, type: types[i] })),
        rows: [],
        group: Object.fromEntries(
          names.flatMap((name, i) => (groups[i] === 'true' ? [[name, values[i] ?? '']] : [])),
        ),
      }
      lookup.set(key, set)
      sets.push(set)
    }
    set.rows.push(values.map((v, i) => (types[i] === 'boolean' && v !== null ? v === 'true' : v)))
    count++
  }
  return { sets, truncated }
}
