import { describe, expect, it } from 'vitest'
import { parameterValue, queryParameterSchema, redactParameterError } from '../src/shared/parameters'
import { tabSchema, savedQuerySchema } from '../src/shared/contracts'

describe('typed native query parameters', () => {
  const parameter = (type: string, value: string) => queryParameterSchema.parse({ name: 'value', type, value, secret: true })
  it('keeps precise numeric and JSON representations intact', () => {
    expect(parameterValue(parameter('integer', '9007199254740993'))).toBe('9007199254740993')
    expect(parameterValue(parameter('decimal', '12345678901234567890.123456789'))).toBe('12345678901234567890.123456789')
    expect(parameterValue(parameter('json', '{"big":9007199254740993}'))).toBe('{"big":9007199254740993}')
    expect(parameterValue(parameter('binary', 'AP+A'))).toEqual(new Uint8Array([0, 255, 128]))
    expect(parameterValue(parameter('null', ''))).toBe(null)
    expect(parameterValue(parameter('text', ''))).toBe('')
  })
  it('rejects malformed values without echoing them and never accepts identifiers as parameters', () => {
    expect(() => parameterValue(parameter('integer', 'sensitive-invalid'))).toThrow('enter a valid integer')
    expect(() => parameterValue(parameter('timestamp', '2026-09-18'))).toThrow('valid timestamp')
    expect(() => parameterValue(parameter('binary', 'bad!'))).toThrow('valid binary')
    expect(() => parameter('identifier', 'users')).toThrow()
    expect(redactParameterError('decoded or formatted server echo', [parameter('text', 'secret')])).not.toContain('server echo')
  })
  it('prevents parameter values from entering persisted definitions', () => {
    const definition = { name: 'value', type: 'text', secret: true, value: 'never persist' }
    expect(tabSchema.safeParse({ id: 't', connectionId: 'p', kind: 'query', title: 'q', parameterDefinitions: [definition] }).success).toBe(false)
    expect(savedQuerySchema.safeParse({ id: 'q', name: 'q', sql: 'SELECT $1', engine: 'postgres', updatedAt: '', parameterDefinitions: [definition] }).success).toBe(false)
  })
})
