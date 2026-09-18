import { describe, expect, it } from 'vitest'
import { BoundedRedisReplies } from '../src/main/engines/redis-subscription'
import { redisSubscribeSchema } from '../src/shared/redis-tools'

describe('Bounded Redis capture decoder', () => {
  it('decodes fragmented binary messages and consecutive handshake responses', () => {
    const decoder = new BoundedRedisReplies()
    const frames = Buffer.concat([
      Buffer.from('+OK\r\n*3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$3\r\n'),
      Buffer.from([0, 255, 1]),
      Buffer.from('\r\n'),
    ])
    const replies: unknown[] = []
    for (const byte of frames) replies.push(...decoder.push(Buffer.from([byte])))
    expect(replies).toEqual([
      Buffer.from('OK'),
      [Buffer.from('message'), Buffer.from('c'), Buffer.from([0, 255, 1])],
    ])
  })
  it('rejects an oversized payload from its header, before waiting for the data', () => {
    expect(() => new BoundedRedisReplies().push(Buffer.from('$1073741824\r\n'))).toThrow('64 KiB')
    expect(() => new BoundedRedisReplies().push(Buffer.from('*1000000\r\n'))).toThrow('64 KiB')
    expect(() => new BoundedRedisReplies().push(Buffer.alloc(128 * 1024 + 1))).toThrow('wire limit')
    expect(() => new BoundedRedisReplies().push(Buffer.from('-WRONGPASS fake-private-value\r\n'))).toThrow(
      'Check data-node',
    )
  })
  it('validates explicit short captures and never accepts publish or arbitrary command fields', () => {
    expect(redisSubscribeSchema.parse({ connectionId: 'x', channel: 'c' }).seconds).toBe(30)
    expect(() => redisSubscribeSchema.parse({ connectionId: 'x', channel: 'c', seconds: 61 })).toThrow()
    expect(() => redisSubscribeSchema.parse({ connectionId: 'x', channel: 'c', publish: 'oops' })).toThrow()
  })
})
