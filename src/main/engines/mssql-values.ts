import type { Cell, ResultColumn } from '../../shared/contracts'
import { parameterValue, type QueryParameter } from '../../shared/parameters'
import { mssqlQuote } from '../../shared/mssql'
export { mssqlQuote, mssqlVisible, mssqlSafety, mssqlConfirmation } from '../../shared/mssql'

export interface MssqlParameter {
  name: string
  value: string | boolean | null | Buffer
  declaration: string
}
export interface DescribedColumn {
  name: string
  type: string
  nullable: boolean
}
function decimalValue(value: string): { declaration: string; value: string } {
  const match = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value)!
  const integer = match[1].replace(/^0+/, '')
  const fraction = match[2] || ''
  const exponent = Number(match[3] || 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 38)
    throw new Error('SQL Server decimal parameters support at most 38 digits.')
  const scale = Math.max(0, fraction.length - exponent)
  const precision = Math.max(
    1,
    integer.length + fraction.length + Math.max(0, exponent - fraction.length),
    scale,
  )
  if (precision > 38 || scale > 38)
    throw new Error('SQL Server decimal parameters support at most 38 digits without rounding.')
  const digits = (match[1] || '0') + fraction
  const point = (match[1] || '0').length + exponent
  const expanded =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point)
  return {
    declaration: `decimal(${precision},${scale})`,
    value: (value.startsWith('-') ? '-' : '') + expanded,
  }
}
export function mssqlParameters(parameters: QueryParameter[] = []): MssqlParameter[] {
  const names = new Set<string>()
  return parameters.map((parameter, index) => {
    const name = /^\d+$/.test(parameter.name) ? `p${index + 1}` : parameter.name.replace(/^@/, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name.toLowerCase()))
      throw new Error(
        'Use unique SQL Server parameter names containing letters, digits and underscores; numeric labels map to @p1, @p2, and so on.',
      )
    names.add(name.toLowerCase())
    let value = parameterValue(parameter)
    let declaration = 'nvarchar(max)'
    if (parameter.type === 'integer') {
      const integer = BigInt(String(value))
      if (integer < -9223372036854775808n || integer > 9223372036854775807n)
        throw new Error(
          'SQL Server integer parameters must fit signed BIGINT; use decimal for larger exact values.',
        )
      declaration = 'bigint'
    } else if (parameter.type === 'decimal') {
      const decimal = decimalValue(String(value))
      declaration = decimal.declaration
      value = decimal.value
    } else if (parameter.type === 'boolean') declaration = 'bit'
    else if (parameter.type === 'binary') declaration = 'varbinary(max)'
    else if (parameter.type === 'timestamp') {
      if ((/\.(\d+)/.exec(String(value))?.[1].length || 0) > 7)
        throw new Error('SQL Server timestamps support at most seven fractional digits without rounding.')
      declaration = 'datetimeoffset(7)'
    }
    return { name, declaration, value: value instanceof Uint8Array ? Buffer.from(value) : value }
  })
}
export function cellParameter(name: string, value: Cell): MssqlParameter {
  return {
    name,
    value:
      value !== null && typeof value === 'object'
        ? Buffer.from(value.base64, 'base64')
        : typeof value === 'number'
          ? String(value)
          : value,
    declaration:
      value !== null && typeof value === 'object'
        ? 'varbinary(max)'
        : typeof value === 'boolean'
          ? 'bit'
          : 'nvarchar(max)',
  }
}
export function mssqlLiteral(value: MssqlParameter['value']): string {
  if (value === null) return 'NULL'
  if (Buffer.isBuffer(value)) return '0x' + value.toString('hex')
  if (typeof value === 'boolean') return value ? '1' : '0'
  return "N'" + value.replaceAll("'", "''") + "'"
}
export function mssqlDeclarations(parameters: MssqlParameter[]): string {
  return parameters.map((parameter) => `@${parameter.name} ${parameter.declaration}`).join(',')
}
/** Convert before TDS decoding, never after a lossy Number/Date conversion. */
export function resultTransportType(type: string): string {
  const name = type.toLowerCase().split('(')[0].trim()
  // Default implicit string styles for these legacy types omit precision. A
  // second conversion after TDS decoding cannot recover the discarded digits.
  if (['money', 'smallmoney', 'datetime', 'smalldatetime'].includes(name))
    throw new Error(
      `SQL Server ${type} needs an explicit lossless conversion: CONVERT(nvarchar(max), value, ${name.includes('money') ? '2' : '126'}). The default implicit string style can discard precision.`,
    )
  if (['binary', 'varbinary', 'image', 'timestamp', 'rowversion'].includes(name)) return 'varbinary(max)'
  if (['float', 'real'].includes(name)) return 'float'
  if (name === 'bit') return 'bit'
  if (
    [
      'tinyint',
      'smallint',
      'int',
      'bigint',
      'decimal',
      'numeric',
      'char',
      'varchar',
      'text',
      'nchar',
      'nvarchar',
      'ntext',
      'xml',
      'uniqueidentifier',
      'date',
      'time',
      'datetime2',
      'datetimeoffset',
    ].includes(name)
  )
    return 'nvarchar(max)'
  throw new Error(
    `Lossless transport for SQL Server ${type} is unavailable. Explicitly CONVERT the value to nvarchar(max) or varbinary(max) in your query.`,
  )
}
export function losslessBatch(
  sql: string,
  parameters: MssqlParameter[],
  columns?: DescribedColumn[],
): { sql: string; parameters: MssqlParameter[]; columns?: ResultColumn[] } {
  const resultSets = columns?.length
    ? ` WITH RESULT SETS ((${columns.map((column, index) => `${mssqlQuote(`__harbor_${index}`)} ${resultTransportType(column.type)} NULL`).join(',')}))`
    : ''
  return {
    sql: `EXEC sys.sp_executesql @stmt=@__harbor_stmt, @params=@__harbor_params${parameters.map((parameter, index) => `, @${parameter.name}=@__harbor_value_${index}`).join('')}${resultSets}`,
    parameters: [
      { name: '__harbor_stmt', declaration: 'nvarchar(max)', value: sql },
      { name: '__harbor_params', declaration: 'nvarchar(max)', value: mssqlDeclarations(parameters) },
      ...parameters.map((parameter, index) => ({ ...parameter, name: `__harbor_value_${index}` })),
    ],
    columns: columns?.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })),
  }
}
export function mssqlCell(value: unknown, type: string): Cell {
  if (value == null) return null
  if (
    /^(NumericN|DecimalN|Money|SmallMoney|MoneyN|Date|Time|DateTime|DateTimeN|SmallDateTime|DateTime2|DateTimeOffset|Variant)$/i.test(
      type,
    )
  )
    throw new Error(
      `SQL Server ${type} requires lossless server conversion. Run one describable SELECT or explicitly CONVERT this value to nvarchar(max). Earlier statements may have completed.`,
    )
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { type: 'binary', base64: Buffer.from(value).toString('base64') }
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  throw new Error(`Unsupported SQL Server ${type}; refusing lossy conversion.`)
}
