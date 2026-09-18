import { isSafeNumber, splitNumber } from 'lossless-json'
import type { Readable } from 'node:stream'
import type { Cell, ResultColumn } from '../../shared/contracts'

export const CLICKHOUSE_MAX_ROW_BYTES = 8 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
function decodeField(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length)
  let length = 0
  const escapes: Record<number, number> = { 97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 48: 0 }
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== 92) {
      output[length++] = input[index]
      continue
    }
    if (++index >= input.length) throw new Error('Incomplete ClickHouse field escape.')
    if (input[index] === 120) {
      const hex = input.subarray(index + 1, index + 3).toString('ascii')
      if (!/^[a-f0-9]{2}$/i.test(hex)) throw new Error('Invalid ClickHouse byte escape.')
      output[length++] = Number.parseInt(hex, 16)
      index += 2
    } else output[length++] = escapes[input[index]] ?? input[index]
  }
  return output.subarray(0, length)
}
function fields(line: Buffer): Buffer[] {
  const values: Buffer[] = []
  let start = 0
  for (let index = 0; index <= line.length; index++)
    if (index === line.length || line[index] === 9) {
      values.push(line.subarray(start, index))
      start = index + 1
    }
  return values
}
export function clickhouseCell(value: Buffer, type: string): Cell {
  if (value.equals(Buffer.from('\\N'))) return null
  const raw = decodeField(value)
  try {
    const text = decoder.decode(raw)
    if (/^(?:Nullable\()?Bool\)?$/.test(type)) return text === 'true' || text === '1'
    return text
  } catch {
    return { type: 'binary', base64: raw.toString('base64') }
  }
}
/** Parse raw bytes with a hard row bound; never round numbers or replace malformed UTF-8. */
export async function* clickhouseRows(
  stream: Readable,
): AsyncGenerator<{ columns: ResultColumn[] } | { row: Cell[] }> {
  let pending = Buffer.alloc(0),
    names: string[] | undefined,
    columns: ResultColumn[] | undefined
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let index = 0; index < bytes.length; index++)
      if (bytes[index] === 10) {
        if (pending.length + index - start > CLICKHOUSE_MAX_ROW_BYTES)
          throw new Error('A ClickHouse row exceeds the 8 MiB transfer limit.')
        const line = pending.length
          ? Buffer.concat([pending, bytes.subarray(start, index)])
          : bytes.subarray(start, index)
        pending = Buffer.alloc(0)
        start = index + 1
        // Since 25.11 HTTP late exceptions have unescaped CR/LF framing. TSV itself escapes CR.
        if (line.includes(13))
          throw new Error('ClickHouse interrupted its result stream; partial results are incomplete.')
        const parts = fields(line)
        if (!names) {
          names = parts.map((value) => decoder.decode(decodeField(value)))
          continue
        }
        if (!columns) {
          if (parts.length !== names.length) throw new Error('Invalid ClickHouse result metadata.')
          columns = parts.map((value, i) => ({ name: names![i], type: decoder.decode(decodeField(value)) }))
          yield { columns }
          continue
        }
        if (parts.length !== columns.length) throw new Error('ClickHouse returned an incomplete result row.')
        yield { row: parts.map((value, i) => clickhouseCell(value, columns![i].type)) }
      }
    const tail = bytes.subarray(start)
    if (pending.length + tail.length > CLICKHOUSE_MAX_ROW_BYTES)
      throw new Error('A ClickHouse row exceeds the 8 MiB transfer limit.')
    if (tail.length) pending = Buffer.concat([pending, tail])
  }
  if (pending.length || !columns) throw new Error('ClickHouse returned an incomplete result stream.')
}

export function validateClickhouseImport(value: Cell, type: string): void {
  if (value === null || typeof value === 'object') return
  const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  if (/\bDate(?:Time)?(?:32|64)?\b/.test(type)) {
    const date =
      /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw)
    if (
      !date ||
      !Number.isFinite(Date.parse(date[1] + 'T00:00:00Z')) ||
      new Date(date[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== date[1]
    )
      throw new Error('ClickHouse date input must use a valid ISO calendar date.')
    const scale = Number(/DateTime64\(\s*(\d+)/.exec(type)?.[1] ?? 0)
    if ((date[5] ?? '').replace(/0+$/, '').length > scale)
      throw new Error('ClickHouse timestamp input would truncate fractional seconds.')
    if (date[2] && (Number(date[2]) > 23 || Number(date[3]) > 59 || Number(date[4]) > 59))
      throw new Error('ClickHouse timestamp input contains an invalid time.')
    if (/\bDate(?:32)?\b/.test(type) && date[2])
      throw new Error('Import calendar dates into Date columns; timestamp conversion is not implicit.')
    if (/\bDate\b/.test(type) && (date[1] < '1970-01-01' || date[1] > '2149-06-06'))
      throw new Error('ClickHouse Date input exceeds the destination range.')
    if (/\bDate32\b/.test(type) && (date[1] < '1900-01-01' || date[1] > '2299-12-31'))
      throw new Error('ClickHouse Date32 input exceeds the destination range.')
    if (/DateTime/.test(type)) {
      if (!date[2] || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw))
        throw new Error('ClickHouse timestamp imports require an explicit ISO UTC offset or Z suffix.')
      const timestamp = Date.parse(
        raw.replace(' ', 'T') + (date[2] ? (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? '' : 'Z') : 'T00:00:00Z'),
      )
      const minimum = type.includes('DateTime64') ? Date.parse('1900-01-01T00:00:00Z') : 0
      const maximum = type.includes('DateTime64')
        ? Date.parse(scale === 9 ? '2262-04-11T00:00:00Z' : '2300-01-01T00:00:00Z')
        : Date.parse('2106-02-07T00:00:00Z')
      if (!Number.isFinite(timestamp) || timestamp < minimum || timestamp >= maximum)
        throw new Error(
          'ClickHouse timestamp input exceeds the supported exact range or has an invalid UTC offset.',
        )
    }
  }
  const integer = /(U?)Int(8|16|32|64|128|256)\b/.exec(type)
  if (integer) {
    if (!/^[+-]?\d+$/.test(raw)) throw new Error('ClickHouse integer input must contain an exact integer.')
    const bits = BigInt(integer[2]),
      number = BigInt(raw),
      unsigned = integer[1] === 'U',
      minimum = unsigned ? 0n : -(1n << (bits - 1n)),
      maximum = unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n
    if (number < minimum || number > maximum)
      throw new Error('ClickHouse integer input exceeds the destination range.')
  }
  const decimal = /Decimal(?:(32|64|128|256))?\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(type)
  if (decimal) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
      throw new Error('ClickHouse decimal input is invalid.')
    const precision = decimal[1]
        ? { 32: 9, 64: 18, 128: 38, 256: 76 }[Number(decimal[1])]!
        : Number(decimal[2]),
      scale = Number(decimal[1] ? decimal[2] : (decimal[3] ?? 0))
    const { digits, exponent } = splitNumber(
        raw
          .replace(/^\+/, '')
          .replace(/^(-?)\./, '$10.')
          .replace(/\.$/, '.0'),
      ),
      significant = digits.replace(/0+$/, '')
    if (significant && (exponent > precision - scale - 1 || exponent - (significant.length - 1) < -scale))
      throw new Error('ClickHouse decimal input would round or overflow. No rounding was permitted.')
  }
  if (
    /Float(?:32|64)/.test(type) &&
    (!isSafeNumber(raw) || (/Float32/.test(type) && Math.fround(Number(raw)) !== Number(raw)))
  )
    throw new Error('ClickHouse floating-point input would lose numeric precision.')
}
