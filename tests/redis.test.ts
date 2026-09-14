import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import {
  assertRedisCommandAllowed,
  decodeBase64,
  parseRedisCommand,
  redisCell,
  redisConfirmationTarget,
  RedisService,
} from '../src/main/engines/redis'

const profile = profileSchema.parse({
  id: 'redis-test',
  name: 'Redis test',
  engine: 'redis',
  host: '127.0.0.1',
  port: 6379,
})

describe('Redis console parser', () => {
  it('preserves quoted whitespace, empty arguments, escapes, and Unicode', () => {
    expect(
      parseRedisCommand('SET "user name" "hello \\n \\"world\\" 🌊"').map((value) => value.toString()),
    ).toEqual(['SET', 'user name', 'hello \n "world" 🌊'])
    expect(parseRedisCommand("HSET key '' 'a b'").map((value) => value.toString())).toEqual([
      'HSET',
      'key',
      '',
      'a b',
    ])
  })
  it('preserves binary arguments and never invokes a shell', () => {
    const args = parseRedisCommand('SET "\\x00\\xff" "$(touch /tmp/never-executed)"')
    expect(args[1]).toEqual(Buffer.from([0, 255]))
    expect(args[2]!.toString()).toBe('$(touch /tmp/never-executed)')
  })
  it('rejects incomplete quoting and invalid byte escapes', () => {
    expect(() => parseRedisCommand('SET x "broken')).toThrow('unclosed quote')
    expect(() => parseRedisCommand('SET x \\xZZ')).toThrow('hexadecimal')
    expect(() => parseRedisCommand('   ')).toThrow('Enter a Redis command')
  })
})

describe('Privileged Redis safeguards', () => {
  it('uses an allowlist that excludes scripts, ACL changes and session retargeting', () => {
    expect(assertRedisCommandAllowed(profile, parseRedisCommand('GET key'))).toBe('GET')
    for (const source of [
      'SET key value',
      'EVAL "return 1" 0',
      'AUTH secret',
      'SELECT 1',
      'CONFIG SET dir /tmp',
      'FT.SEARCH index query',
    ]) {
      expect(() => assertRedisCommandAllowed(profile, parseRedisCommand(source))).toThrow()
    }
  })
  it('requires target-specific confirmation for flushing and broad deletes', () => {
    const writable = { ...profile, readOnly: false, redisDb: 7 }
    expect(() => assertRedisCommandAllowed(writable, parseRedisCommand('FLUSHDB'), '7')).toThrow('Type')
    expect(
      assertRedisCommandAllowed(writable, parseRedisCommand('FLUSHDB'), redisConfirmationTarget(writable)),
    ).toBe('FLUSHDB')
    expect(() =>
      assertRedisCommandAllowed(writable, parseRedisCommand('FLUSHALL'), redisConfirmationTarget(writable)),
    ).toThrow('All Redis databases')
    expect(
      assertRedisCommandAllowed(
        writable,
        parseRedisCommand('FLUSHALL'),
        redisConfirmationTarget(writable, 'FLUSHALL'),
      ),
    ).toBe('FLUSHALL')
    expect(() =>
      assertRedisCommandAllowed(
        writable,
        parseRedisCommand(`DEL ${Array.from({ length: 21 }, (_, index) => `key${index}`).join(' ')}`),
      ),
    ).toThrow('more than 20')
  })
  it('rejects KEYS even when writes are enabled', () => {
    expect(() =>
      assertRedisCommandAllowed({ ...profile, readOnly: false }, parseRedisCommand('KEYS *')),
    ).toThrow('incremental')
  })
  it('does not imply a restored connection is connected', () => {
    expect(new RedisService().status(profile.id)).toEqual({ state: 'disconnected' })
  })
})

describe('Redis lossless values', () => {
  it('keeps binary bytes and large integer replies intact', () => {
    expect(redisCell(Buffer.from([0, 255, 1]))).toEqual({ type: 'binary', base64: 'AP8B' })
    expect(redisCell(Buffer.from('سلام 🌊'))).toBe('سلام 🌊')
    expect(redisCell(9223372036854775807n)).toBe('9223372036854775807')
    expect(redisCell(null)).toBeNull()
  })
  it('rejects malformed base64 instead of silently changing a key', () => {
    expect(decodeBase64('AP8B')).toEqual(Buffer.from([0, 255, 1]))
    expect(decodeBase64('')).toEqual(Buffer.alloc(0))
    expect(() => decodeBase64('%%%')).toThrow('Invalid base64')
  })
})
