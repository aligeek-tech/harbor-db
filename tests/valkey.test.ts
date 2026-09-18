import { describe, expect, it } from 'vitest'
import { keyValueConfirmationTarget, redisServerIdentity } from '../src/shared/valkey'
describe('explicit Valkey product identity', () => {
  const info =
    'redis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:9.1.2\r\nserver_mode:standalone\r\n'
  it('uses native Valkey version rather than Redis compatibility version', () => {
    expect(redisServerIdentity(info, 'valkey')).toEqual({
      product: 'Valkey',
      version: '9.1.2',
      mode: 'standalone',
    })
  })
  it('rejects crossed product profiles and incomplete identity evidence', () => {
    expect(() => redisServerIdentity(info, 'redis')).toThrow('Valkey')
    expect(() => redisServerIdentity('redis_version:7.2.4\nredis_mode:standalone', 'valkey')).toThrow(
      'does not identify',
    )
    expect(() =>
      redisServerIdentity('server_name:valkey\nredis_version:7.2.4\nserver_mode:standalone', 'valkey'),
    ).toThrow('native server version')
  })
  it('preserves Redis version and native deployment modes without inventing absent fields', () => {
    expect(redisServerIdentity('redis_version:7.4.2\nredis_mode:cluster', 'redis')).toMatchObject({
      version: '7.4.2',
      mode: 'cluster',
    })
    expect(redisServerIdentity(info.replace('standalone', 'sentinel'), 'valkey').mode).toBe('sentinel')
    expect(() => redisServerIdentity('redis_version:7.4.2', 'redis')).toThrow('deployment mode')
  })
  it('includes the actual product and logical database in destructive review text', () => {
    const profile = { engine: 'valkey', host: '127.0.0.1', port: 16479, redisDb: 3 }
    expect(keyValueConfirmationTarget(profile)).toBe('Valkey database 3 on 127.0.0.1:16479')
    expect(keyValueConfirmationTarget(profile, 'FLUSHALL')).toBe('All Valkey databases on 127.0.0.1:16479')
  })
})
