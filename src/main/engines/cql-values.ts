import cassandra from 'cassandra-driver'
import { parse } from 'lossless-json'
import { cqlParameterSchema, type CqlParameter } from '../../shared/cql'
export class CqlInputError extends Error {}
export function cqlJson(source: string): unknown {
  try {
    return parse(source, undefined, {
      onDuplicateKey: () => {
        throw new Error('duplicate')
      },
    })
  } catch {
    throw new CqlInputError('Enter valid typed JSON without duplicate keys.')
  }
}
export function cqlParameters(parameters: CqlParameter[]): unknown[] {
  let count = 0
  const convert = (raw: CqlParameter, depth = 0): unknown => {
    if (depth > 24 || ++count > 10000) throw new CqlInputError('CQL parameters exceed the depth/value bound.')
    const p = cqlParameterSchema.parse(raw),
      value = p.value
    const array = () => {
      const parsed = cqlJson(value)
      if (!Array.isArray(parsed))
        throw new CqlInputError('Collection parameter needs an array of typed values.')
      return parsed
    }
    const number = () => {
      const n = Number(value)
      if (!value.trim() || !Number.isFinite(n))
        throw new CqlInputError('Numeric CQL parameter must be finite.')
      return n
    }
    const integer = (min: number, max: number) => {
      if (!/^[+-]?\d+$/.test(value)) throw new CqlInputError('Integer parameter must use exact decimal text.')
      const n = Number(value)
      if (!Number.isInteger(n) || n < min || n > max)
        throw new CqlInputError('Integer parameter is outside its native range.')
      return n
    }
    switch (p.type) {
      case 'null':
        return null
      case 'text':
        return value
      case 'ascii':
        if ([...value].some((character) => character.charCodeAt(0) > 127))
          throw new CqlInputError('ASCII parameter contains non-ASCII text.')
        return value
      case 'int':
        return integer(-2147483648, 2147483647)
      case 'smallint':
        return integer(-32768, 32767)
      case 'tinyint':
        return integer(-128, 127)
      case 'bigint': {
        if (!/^[+-]?\d+$/.test(value)) throw new CqlInputError('Bigint needs decimal text.')
        const n = BigInt(value)
        if (n < -(1n << 63n) || n >= 1n << 63n)
          throw new CqlInputError('Bigint is outside signed 64-bit range.')
        return cassandra.types.Long.fromString(value)
      }
      case 'varint':
        if (!/^[+-]?\d+$/.test(value)) throw new CqlInputError('Varint needs decimal text.')
        return cassandra.types.Integer.fromString(value)
      case 'decimal':
        return cassandra.types.BigDecimal.fromString(value)
      case 'float': {
        const n = number()
        if (!Number.isFinite(Math.fround(n)))
          throw new CqlInputError('Float parameter is outside the finite 32-bit range.')
        return n
      }
      case 'double':
        return number()
      case 'boolean':
        if (value !== 'true' && value !== 'false')
          throw new CqlInputError('Boolean value must be true or false.')
        return value === 'true'
      case 'uuid':
        return cassandra.types.Uuid.fromString(value)
      case 'timeuuid':
        return cassandra.types.TimeUuid.fromString(value)
      case 'date':
        return cassandra.types.LocalDate.fromString(value)
      case 'time':
        return cassandra.types.LocalTime.fromString(value)
      case 'duration':
        return cassandra.types.Duration.fromString(value)
      case 'inet':
        return cassandra.types.InetAddress.fromString(value)
      case 'timestamp': {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))
          throw new CqlInputError('Timestamp needs explicit timezone and at most millisecond precision.')
        const date = new Date(value)
        if (!Number.isFinite(date.getTime())) throw new CqlInputError('Invalid timestamp.')
        return date
      }
      case 'blob':
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
          throw new CqlInputError('Blob requires canonical base64.')
        return Buffer.from(value, 'base64')
      case 'list':
        return array().map((v) => convert(v as CqlParameter, depth + 1))
      case 'set':
        return new Set(array().map((v) => convert(v as CqlParameter, depth + 1)))
      case 'tuple':
        return new cassandra.types.Tuple(...array().map((v) => convert(v as CqlParameter, depth + 1)))
      case 'map':
        return new Map(
          array().map((v) => {
            if (!Array.isArray(v) || v.length !== 2)
              throw new CqlInputError('Map needs pairs of typed key/value parameters.')
            return [convert(v[0] as CqlParameter, depth + 1), convert(v[1] as CqlParameter, depth + 1)]
          }),
        )
      case 'udt': {
        const record = cqlJson(value)
        if (!record || typeof record !== 'object' || Array.isArray(record))
          throw new CqlInputError('UDT needs an object of typed fields.')
        return Object.fromEntries(
          Object.entries(record).map(([k, v]) => [k, convert(v as CqlParameter, depth + 1)]),
        )
      }
    }
  }
  if (parameters.reduce((sum, p) => sum + Buffer.byteLength(p.value), 0) > 1024 * 1024)
    throw new CqlInputError('CQL parameters exceed 1 MiB.')
  try {
    return parameters.map((p) => convert(p))
  } catch (error) {
    if (error instanceof CqlInputError) throw error
    throw new CqlInputError('A typed CQL parameter is invalid. Review its type and value.')
  }
}
export function cqlCell(value: unknown): string {
  let count = 0
  const encode = (v: unknown, depth = 0): unknown => {
    if (depth > 32 || ++count > 50000)
      throw new CqlInputError('CQL returned value exceeds the complexity bound.')
    if (v === null || v === undefined) return null
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() }
    if (typeof v === 'number') return Number.isFinite(v) ? v : { type: 'float', value: String(v) }
    if (typeof v !== 'object') return v
    if (Buffer.isBuffer(v)) return { type: 'blob', base64: v.toString('base64') }
    if (v instanceof Date) return { type: 'timestamp', value: v.toISOString() }
    for (const [name, ctor] of Object.entries({
      bigint: cassandra.types.Long,
      varint: cassandra.types.Integer,
      decimal: cassandra.types.BigDecimal,
      timeuuid: cassandra.types.TimeUuid,
      uuid: cassandra.types.Uuid,
      date: cassandra.types.LocalDate,
      time: cassandra.types.LocalTime,
      duration: cassandra.types.Duration,
      inet: cassandra.types.InetAddress,
    })) {
      if (v instanceof ctor) return { type: name, value: String(v) }
    }
    if (v instanceof cassandra.types.Tuple)
      return { type: 'tuple', value: v.values().map((item) => encode(item, depth + 1)) }
    if (v instanceof Map)
      return {
        type: 'map',
        entries: [...v.entries()].map(([k, val]) => [encode(k, depth + 1), encode(val, depth + 1)]),
      }
    if (v instanceof Set) return { type: 'set', values: [...v].map((item) => encode(item, depth + 1)) }
    if (Array.isArray(v)) return v.map((item) => encode(item, depth + 1))
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, encode(val, depth + 1)]))
  }
  const text = JSON.stringify(encode(value))
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new CqlInputError('CQL cell exceeds 1 MiB. Narrow the projection.')
  return text
}
