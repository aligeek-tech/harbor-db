import type { Cell, ResultColumn } from '../../shared/contracts'

export const DB2_MAX_BYTES = 8 * 1024 * 1024
export const DB2_MAX_ROW_BYTES = 1024 * 1024
export const DB2_MAX_COLUMNS = 128
export interface Db2ColumnMetadata {
  index: number
  SQL_DESC_NAME: string
  SQL_DESC_TYPE_NAME: string
  SQL_DESC_CONSIZE_TYPE: number // Spelling exported by pinned ibm_db 4.0.1.
  SQL_DESC_LENGTH: number
  SQL_DESC_DISPLAY_SIZE: number
}
export interface Db2Encoding {
  type: string
  format: 'native' | 'hex-text' | 'hex-binary'
}

/** Metadata is inspected before any row fetch; no LOB allocation or lossy value conversion. */
export function db2Columns(metadata: Db2ColumnMetadata[], encodings?: Db2Encoding[]): ResultColumn[] {
  if (
    !metadata.length ||
    metadata.length > DB2_MAX_COLUMNS ||
    (encodings && encodings.length !== metadata.length)
  )
    throw new Error('Db2 result must contain 1–128 supported columns.')
  return metadata.map((column, index) => {
    const code = column.SQL_DESC_CONSIZE_TYPE
    const type = column.SQL_DESC_TYPE_NAME.toUpperCase()
    const length = column.SQL_DESC_LENGTH
    if (column.index !== index + 1 || !Number.isSafeInteger(length) || length < 0)
      throw new Error('Invalid Db2 column metadata; refusing to fetch.')
    const encoding = encodings?.[index]
    if (encoding && encoding.format !== 'native') {
      if (![1, 12].includes(code) || length > 1022)
        throw new Error('The bounded Db2 HEX projection has unexpected metadata.')
    } else if ([4, 5, -6, -5, -7, 6, 7, 8, 91, 92].includes(code)) {
      // INTEGER/BIGINT, IEEE floating point, BOOLEAN and date/time ASCII values.
      if (!/^(?:INTEGER|SMALLINT|TINYINT|BIGINT|BOOLEAN|BIT|REAL|FLOAT|DOUBLE|DATE|TIME)$/.test(type))
        throw new Error('Db2 type code/name mismatch.')
    } else if ([-2, -3].includes(code) && length <= 511) {
      // Fits inside the pinned driver's initial buffer, avoiding chunk/reallocation code.
    } else
      throw new Error(
        `Db2 ${type} output is unavailable without a trusted lossless projection. Use table browsing or explicitly cast bounded values to VARBINARY(511); no row was fetched.`,
      )
    return { name: column.SQL_DESC_NAME, type: encoding?.type ?? type }
  })
}

export function db2Row(row: unknown[], metadata: Db2ColumnMetadata[], encodings?: Db2Encoding[]): Cell[] {
  if (row.length !== metadata.length) throw new Error('Db2 returned an unexpected row width.')
  const values = row.map((value, index): Cell => {
    if (value === null) return null
    const format = encodings?.[index]?.format
    if (format === 'hex-text' || format === 'hex-binary') {
      if (typeof value !== 'string' || value.length > 1022 || !/^(?:[0-9A-Fa-f]{2})*$/.test(value))
        throw new Error('Db2 returned an invalid or oversized HEX projection.')
      const bytes = Buffer.from(value, 'hex')
      return format === 'hex-binary'
        ? { type: 'binary', base64: bytes.toString('base64') }
        : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
    const code = metadata[index].SQL_DESC_CONSIZE_TYPE
    if (Buffer.isBuffer(value) && [-2, -3].includes(code) && value.length <= 511)
      return { type: 'binary', base64: value.toString('base64') }
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      ([6, 7, 8].includes(code) || ([4, 5, -6].includes(code) && Number.isSafeInteger(value)))
    )
      return value
    if (typeof value === 'boolean' && code === -7) return value
    if (
      typeof value === 'string' &&
      ((code === -5 && /^[+-]?\d{1,19}$/.test(value)) ||
        ([91, 92].includes(code) && /^[0-9:. -]{1,32}$/.test(value)))
    )
      return value
    throw new Error('Db2 returned a value outside its exact conversion contract.')
  })
  if (Buffer.byteLength(JSON.stringify(values)) > DB2_MAX_ROW_BYTES)
    throw new Error('Db2 row exceeds the 1 MiB result limit.')
  return values
}
