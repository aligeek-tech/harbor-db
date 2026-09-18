import oracledb from 'oracledb'
import { Duplex } from 'node:stream'
import { splitNumber } from 'lossless-json'
import type { Cell, ColumnInfo, ResultColumn } from '../../shared/contracts'
import type { QueryParameter } from '../../shared/parameters'
import { oracleParameters, oracleVisible, oracleQuote } from '../../shared/oracle'
import { validateImportNumber } from '../persistence/import-writer'

export const ORACLE_ROW_BYTES = 8 * 1024 * 1024
export class OracleInputError extends Error {}
const dateTypes = new Set<oracledb.DbType | undefined>([
  oracledb.DB_TYPE_DATE,
  oracledb.DB_TYPE_TIMESTAMP,
  oracledb.DB_TYPE_TIMESTAMP_TZ,
  oracledb.DB_TYPE_TIMESTAMP_LTZ,
])
const exactTypes = new Set<oracledb.DbType | undefined>([
  oracledb.DB_TYPE_NUMBER,
  oracledb.DB_TYPE_BINARY_FLOAT,
  oracledb.DB_TYPE_BINARY_DOUBLE,
  oracledb.DB_TYPE_INTERVAL_DS,
  oracledb.DB_TYPE_INTERVAL_YM,
])
/** Explicit server projection: Thin fetch-as-string still passes timestamps through JS Date. */
export function oracleExactProjection(expression: string, type: string): string {
  const normalized = type.toUpperCase()
  if (normalized === 'DATE') return `LTRIM(TO_CHAR(${expression},'SYYYY-MM-DD"T"HH24:MI:SS'))`
  if (!normalized.startsWith('TIMESTAMP')) return expression
  const format = 'SYYYY-MM-DD"T"HH24:MI:SS.FF9'
  if (normalized.includes('WITH TIME ZONE'))
    return `CASE WHEN ${expression} IS NULL THEN NULL ELSE LTRIM(TO_CHAR(${expression},'${format}TZH:TZM')) || ' [' || TO_CHAR(${expression},'TZR') || ']' END`
  return `LTRIM(TO_CHAR(${expression},'${format}'))`
}
export function oracleColumnProjection(column: Pick<ColumnInfo, 'name' | 'type'>): string {
  const name = oracleQuote(column.name),
    expression = oracleExactProjection(name, column.type)
  return expression === name ? name : `${expression} AS ${name}`
}
const plainTypes = new Set<oracledb.DbType | undefined>([
  oracledb.DB_TYPE_VARCHAR,
  oracledb.DB_TYPE_NVARCHAR,
  oracledb.DB_TYPE_CHAR,
  oracledb.DB_TYPE_NCHAR,
  oracledb.DB_TYPE_RAW,
  oracledb.DB_TYPE_ROWID,
  oracledb.DB_TYPE_CLOB,
  oracledb.DB_TYPE_NCLOB,
  oracledb.DB_TYPE_BLOB,
  oracledb.DB_TYPE_BOOLEAN,
])
export function oracleFetchType(
  meta: Pick<oracledb.Metadata<unknown[]>, 'dbType'>,
): oracledb.FetchTypeResponse | undefined {
  if (dateTypes.has(meta.dbType))
    throw new OracleInputError(
      'Oracle Thin cannot fetch raw DATE/TIMESTAMP values without losing precision or timezone identity. Use an explicit server TO_CHAR projection with SYYYY, FF9 and timezone fields, or browse the table with Harbor’s exact projections.',
    )
  if (exactTypes.has(meta.dbType)) return { type: oracledb.STRING }
  if (!plainTypes.has(meta.dbType))
    throw new OracleInputError(
      'Oracle result includes an unsupported type. Project JSON with JSON_SERIALIZE RETURNING CLOB, and convert objects, vectors, LONG or cursors explicitly to supported scalar columns.',
    )
  return undefined
}
export function oracleColumns(metadata: oracledb.Metadata<unknown[]>[]): ResultColumn[] {
  return metadata.map((meta) => ({
    name: meta.dbColumnName ?? meta.name,
    type: meta.dbTypeName ?? String(meta.dbType),
    nullable: meta.nullable,
  }))
}
export async function oracleRow(raw: unknown[]): Promise<Cell[]> {
  let bytes = 0
  const result: Cell[] = []
  for (const value of raw) {
    let cell: Cell
    if (value === null || value === undefined) cell = null
    else if (isLob(value)) {
      const binary = value.type === oracledb.DB_TYPE_BLOB
      const buffers: Buffer[] = [],
        strings: string[] = []
      let size = 0,
        offset = 1
      try {
        // CLOB offsets count UTF-16 code units. Preserve adjacent surrogate halves as strings;
        // the driver's Readable pushes each string through UTF-8 separately and can replace them.
        while (offset <= value.length) {
          const chunk = await value.getData(offset, Math.min(65536, value.length - offset + 1))
          if (!chunk?.length) break
          offset += chunk.length
          size += Buffer.byteLength(chunk)
          if (size + bytes > ORACLE_ROW_BYTES)
            throw new OracleInputError(
              'Oracle row exceeds the 8 MiB result limit. Select a smaller LOB projection.',
            )
          if (binary) buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          else strings.push(String(chunk))
        }
      } finally {
        await value.close()
      }
      cell = binary ? { type: 'binary', base64: Buffer.concat(buffers).toString('base64') } : strings.join('')
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array)
      cell = { type: 'binary', base64: Buffer.from(value).toString('base64') }
    else if (typeof value === 'string' || typeof value === 'boolean') cell = value
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value))
        throw new OracleInputError(
          'Oracle returned a numeric value without exact text conversion. Cast it to VARCHAR2 explicitly.',
        )
      cell = String(value)
    } else
      throw new OracleInputError(
        'Oracle returned an unsupported result value. Project supported scalar columns explicitly.',
      )
    bytes += Buffer.byteLength(JSON.stringify(cell))
    if (bytes > ORACLE_ROW_BYTES)
      throw new OracleInputError('Oracle row exceeds the 8 MiB result limit. Select a smaller projection.')
    result.push(cell)
  }
  return result
}
function isLob(value: unknown): value is oracledb.Lob {
  return value instanceof Duplex && 'pieceSize' in value && 'type' in value
}
export function closeOracleLobs(rows: unknown[][]): void {
  for (const row of rows) for (const value of row) if (isLob(value) && !value.destroyed) value.destroy()
}
function exactNumber(value: string, column?: ColumnInfo): void {
  const normalized = value
    .replace(/^\+/, '')
    .replace(/^(-?)\./, '$10.')
    .replace(/\.$/, '.0')
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))
    throw new OracleInputError('Enter an exact Oracle NUMBER value.')
  const { digits, exponent } = splitNumber(normalized),
    significant = digits.replace(/0+$/, '')
  if (significant && (significant.length > 38 || exponent > 125 || exponent < -130))
    throw new OracleInputError(
      'The source number exceeds Oracle NUMBER precision or exponent limits. No rounding was permitted.',
    )
  if (column)
    validateImportNumber(
      normalized,
      { ...column, type: column.type.replace(/^NUMBER/i, 'NUMERIC') },
      'oracle',
    )
}
function timestamp(value: string): string {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value)
  const components = match?.[1].match(/\d+/g)?.map(Number)
  const validCalendar =
    components &&
    components[0] >= 1 &&
    components[1] >= 1 &&
    components[1] <= 12 &&
    components[2] >= 1 &&
    components[2] <= new Date(Date.UTC(components[0], components[1], 0)).getUTCDate() &&
    components[3] <= 23 &&
    components[4] <= 59 &&
    components[5] <= 59
  if (!match || !validCalendar || !Number.isFinite(Date.parse(value)))
    throw new OracleInputError(
      'Oracle timestamps require an ISO timestamp with timezone and at most 9 fractional digits.',
    )
  return match[1] + '.' + (match[2] ?? '').padEnd(9, '0') + (match[3] === 'Z' ? '+00:00' : match[3])
}
export function oracleBindings(
  sql: string,
  parameters: QueryParameter[] = [],
): { sql: string; binds: oracledb.BindParameters } {
  const values = oracleParameters(parameters),
    definitions = new Map(parameters.map((p) => [p.name.toUpperCase(), p])),
    visible = oracleVisible(sql),
    binds: Record<string, oracledb.BindParameter> = {}
  const replaced = sql.replace(/:([A-Za-z][\w$#]*)/g, (token, name: string, offset: number) => {
    if (visible.slice(offset, offset + token.length) !== token) return token
    const key = name.toUpperCase(),
      parameter = definitions.get(key)
    if (!parameter) throw new OracleInputError('A named Oracle bind has no supplied parameter value.')
    const value = values[key]
    if (parameter.type === 'integer' || parameter.type === 'decimal') {
      exactNumber(String(value))
      binds[key] = { val: String(value), type: oracledb.STRING }
      return 'TO_NUMBER(:' + key + ')'
    }
    if (parameter.type === 'timestamp') {
      binds[key] = { val: timestamp(String(value)), type: oracledb.STRING }
      return `TO_TIMESTAMP_TZ(:${key},'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM')`
    }
    binds[key] = {
      val: value instanceof Uint8Array ? Buffer.from(value) : value,
      type:
        parameter.type === 'binary'
          ? oracledb.BUFFER
          : parameter.type === 'boolean'
            ? oracledb.DB_TYPE_BOOLEAN
            : oracledb.STRING,
    }
    return ':' + key
  })
  if (Object.keys(binds).length !== parameters.length)
    throw new OracleInputError(
      'Every supplied Oracle parameter must match a named bind in the selected statement.',
    )
  return { sql: replaced, binds }
}
export function oracleImportExpression(
  value: Cell,
  column: ColumnInfo,
  name: string,
): { expression: string; bind: oracledb.BindParameter } {
  const type = column.type.toUpperCase()
  if (value === null) return { expression: ':' + name, bind: { val: null, type: oracledb.STRING } }
  if (/^NUMBER/.test(type)) {
    exactNumber(String(value), column)
    return { expression: `TO_NUMBER(:${name})`, bind: { val: String(value), type: oracledb.STRING } }
  }
  if (/^(?:BLOB|RAW)/.test(type)) {
    if (typeof value !== 'object')
      throw new OracleInputError('Oracle binary columns require a binary source mapping.')
    return {
      expression: ':' + name,
      bind: {
        val: Buffer.from(value.base64, 'base64'),
        type: type === 'BLOB' ? oracledb.BLOB : oracledb.BUFFER,
      },
    }
  }
  if (/^TIMESTAMP|^DATE$/.test(type)) {
    if (typeof value !== 'string')
      throw new OracleInputError('Oracle date/timestamp columns require ISO timestamp text.')
    const normalized = timestamp(value),
      digits = /\.(\d+)/.exec(normalized)![1],
      scale = type === 'DATE' ? 0 : Number(/\((\d)\)/.exec(type)?.[1] ?? 6)
    if (/[1-9]/.test(digits.slice(scale)))
      throw new OracleInputError(
        'The source timestamp exceeds destination fractional precision. No truncation was permitted.',
      )
    if (!/WITH TIME ZONE/.test(type) && !normalized.endsWith('+00:00'))
      throw new OracleInputError(
        'Use a UTC timestamp mapping for Oracle date/timestamp columns without an explicit timezone.',
      )
    return {
      expression: `TO_TIMESTAMP_TZ(:${name},'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM')`,
      bind: { val: normalized, type: oracledb.STRING },
    }
  }
  if (type === 'BOOLEAN') {
    if (typeof value !== 'boolean')
      throw new OracleInputError('Oracle BOOLEAN columns require a boolean mapping.')
    return { expression: ':' + name, bind: { val: value, type: oracledb.DB_TYPE_BOOLEAN } }
  }
  if (/^(?:N?VARCHAR2|N?CHAR|N?CLOB)/.test(type)) {
    if (typeof value === 'object')
      throw new OracleInputError('Oracle text columns require a scalar text mapping.')
    return {
      expression: ':' + name,
      bind: { val: String(value), type: /CLOB/.test(type) ? oracledb.CLOB : oracledb.STRING },
    }
  }
  throw new OracleInputError(
    'Oracle import supports exact NUMBER, text/LOB, RAW/BLOB, BOOLEAN and date/timestamp columns. Convert unsupported destinations explicitly.',
  )
}
