import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { parse } from 'lossless-json'
export class DynamoInputError extends Error {}
export function json(source: string): unknown {
  try {
    return parse(source, undefined, {
      onDuplicateKey: () => {
        throw new Error('Duplicate')
      },
    })
  } catch {
    throw new DynamoInputError('Enter valid typed DynamoDB JSON without duplicate keys.')
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DynamoInputError('Expected a typed DynamoDB JSON object.')
  return value as Record<string, unknown>
}
export function attributes(source: string): Record<string, AttributeValue> {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new DynamoInputError('Attribute JSON exceeds 1 MiB.')
  const inputObject = object(json(source)),
    result: Record<string, AttributeValue> = {}
  let count = 0
  const attr = (raw: unknown, depth = 0): AttributeValue => {
    if (depth > 32 || ++count > 50000)
      throw new DynamoInputError('Attribute complexity exceeds the depth or value bound.')
    const record = object(raw),
      keys = Object.keys(record)
    if (keys.length !== 1) throw new DynamoInputError('Each attribute needs exactly one native type tag.')
    const type = keys[0]!,
      value = record[type]
    const str = (v: unknown) => {
      if (typeof v !== 'string')
        throw new DynamoInputError('DynamoDB text, number and binary values must be strings.')
      return v
    }
    const num = (v: unknown) => {
      const text = str(v)
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || text.length > 128)
        throw new DynamoInputError('Enter an exact DynamoDB decimal number as text.')
      return text
    }
    const bin = (v: unknown) => {
      const text = str(v)
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
        throw new DynamoInputError('Binary values must use canonical base64.')
      return Buffer.from(text, 'base64')
    }
    const set = (v: unknown) => {
      if (!Array.isArray(v) || !v.length || v.length > 10000)
        throw new DynamoInputError('Sets must be non-empty bounded arrays.')
      if (new Set(v.map((x) => JSON.stringify(x))).size !== v.length)
        throw new DynamoInputError('Set members must be unique.')
      return v
    }
    switch (type) {
      case 'S':
        return { S: str(value) }
      case 'N':
        return { N: num(value) }
      case 'B':
        return { B: bin(value) }
      case 'BOOL':
        if (typeof value !== 'boolean') throw new DynamoInputError('BOOL must be boolean.')
        return { BOOL: value }
      case 'NULL':
        if (value !== true) throw new DynamoInputError('NULL must be true.')
        return { NULL: true }
      case 'SS':
        return { SS: set(value).map(str) }
      case 'NS':
        return { NS: set(value).map(num) }
      case 'BS':
        return { BS: set(value).map(bin) }
      case 'L':
        if (!Array.isArray(value)) throw new DynamoInputError('L must be an array.')
        return { L: value.map((v) => attr(v, depth + 1)) }
      case 'M':
        return {
          M: Object.fromEntries(Object.entries(object(value)).map(([k, v]) => [k, attr(v, depth + 1)])),
        }
      default:
        throw new DynamoInputError('Unsupported DynamoDB attribute type.')
    }
  }
  for (const [key, value] of Object.entries(inputObject)) {
    if (!key || key.length > 65535) throw new DynamoInputError('Invalid attribute name.')
    Object.defineProperty(result, key, {
      value: attr(value),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}
export function encodeAttributes(value: Record<string, AttributeValue>): string {
  return JSON.stringify(
    value,
    (_key, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v),
    2,
  )
}
export function singleAttribute(source: string): AttributeValue {
  return attributes('{"value":' + source + '}').value!
}
