import { describe, expect, it } from 'vitest'
import { redisHashSlot, redisTopologySchema } from '../src/shared/redis-topology'
import { redisCommandKeys, enforceRedisSlot } from '../src/main/engines/redis-topology-client'
import { profileSchema } from '../src/shared/contracts'
import { RedisService } from '../src/main/engines/redis'

describe('Redis topology boundaries', () => {
  it('preserves binary slots, hash tags and standard CRC16/XMODEM vectors', () => {
    expect(redisHashSlot(Buffer.from('123456789'))).toBe(0x31c3 % 16384)
    expect(redisHashSlot(Buffer.from('a{same}1'))).toBe(redisHashSlot(Buffer.from('b{same}2')))
    expect(redisHashSlot(Buffer.from([0, 255, 123, 97, 125, 0]))).toBe(redisHashSlot(Buffer.from('a')))
    expect(redisHashSlot(Buffer.from('{}{a}'))).not.toBe(redisHashSlot(Buffer.from('a')))
  })
  it('rejects every cross-slot form before dispatch rather than splitting writes', () => {
    for (const args of [
      ['MSET', 'a', '1', 'b', '2'],
      ['MGET', 'a', 'b'],
      ['DEL', 'a', 'b'],
      ['EXISTS', 'a', 'b'],
      ['RENAMENX', 'a', 'b'],
      ['SMOVE', 'a', 'b', 'member'],
      ['EVAL_RO', 'script', '2', 'a', 'b'],
    ])
      expect(() => enforceRedisSlot(args)).toThrow('CROSSSLOT')
    expect(enforceRedisSlot(['MSET', '{x}:a', '1', '{x}:b', '2'])?.toString()).toBe('{x}:a')
    expect(redisCommandKeys(['MEMORY', 'USAGE', 'actual-key'])).toEqual([Buffer.from('actual-key')])
    expect(redisCommandKeys(['HSET', 'key', 'field', 'value'])).toEqual([Buffer.from('key')])
  })
  it('bounds discovery config and rejects credential-bearing endpoint URLs', () => {
    expect(redisTopologySchema.parse({})).toMatchObject({ mode: 'standalone', seeds: [] })
    expect(() => redisTopologySchema.parse({ seeds: [{ host: 'redis://u:p@host', port: 6379 }] })).toThrow()
    expect(() =>
      redisTopologySchema.parse({ seeds: Array(11).fill({ host: 'localhost', port: 6379 }) }),
    ).toThrow()
  })
  it('rejects unsupported topology assumptions before opening sockets', async () => {
    const service = new RedisService()
    const profile = profileSchema.parse({
      id: 'test',
      name: 'Test',
      engine: 'redis',
      host: '127.0.0.1',
      port: 1,
      redis: { mode: 'cluster' },
      redisDb: 1,
    })
    expect((await service.connect(profile)).error).toContain('database 0')
    expect(
      (await service.connect({ ...profile, redisDb: 0, ssh: { ...profile.ssh, enabled: true } })).error,
    ).toContain('Single-host SSH')
    expect(
      (await service.connect({ ...profile, redis: { ...profile.redis, mode: 'sentinel' } })).error,
    ).toContain('service name')
    await service.closeAll()
  })
})
