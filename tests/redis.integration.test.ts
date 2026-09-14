import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import { profileSchema, type RedisInspectInput } from '../src/shared/contracts'
import { RedisService } from '../src/main/engines/redis'

const enabled = process.env.HARBOR_INTEGRATION === '1'
const host = process.env.HARBOR_REDIS_HOST || '127.0.0.1'
const port = Number(process.env.HARBOR_REDIS_PORT || 16379)
const password = process.env.HARBOR_REDIS_PASSWORD || 'harbor_test'
const service = new RedisService()
const prefix = `harbor-integration:${randomUUID()}:`
const profile = profileSchema.parse({
  id: 'redis-integration',
  name: 'Isolated integration Redis',
  engine: 'redis',
  host,
  port,
  redisDb: 15,
  readOnly: false,
})
const control = createClient({ socket: { host, port, reconnectStrategy: false }, password, database: 15 })
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64')
const key = (suffix: string) => `${prefix}${suffix}`
const inspect = (suffix: string, extra: Partial<RedisInspectInput> = {}) =>
  service.inspect({
    connectionId: profile.id,
    keyBase64: b64(key(suffix)),
    cursor: '0',
    offset: 0,
    count: 100,
    ...extra,
  })

describe.skipIf(!enabled)('Standalone Redis integration', () => {
  beforeAll(async () => {
    control.on('error', () => {})
    await control.connect()
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    const seed = control.multi()
    for (let index = 0; index < 1500; index++) seed.set(key(`scan:${index}`), `value ${index}`)
    await seed.exec()
  }, 30000)
  afterAll(async () => {
    await service.closeAll()
    if (control.isReady) {
      let cursor = '0'
      do {
        const page = await control.scan(cursor, { MATCH: `${prefix}*`, COUNT: 500 })
        cursor = page.cursor
        if (page.keys.length) await control.unlink(page.keys)
      } while (cursor !== '0')
    }
    if (control.isOpen) control.destroy()
  })

  it('incrementally scans real keys and exposes truthful types and TTLs', async () => {
    const found = new Set<string>()
    let cursor = '0'
    let pages = 0
    do {
      const page = await service.scan({
        connectionId: profile.id,
        cursor,
        pattern: `${prefix}scan:*`,
        count: 100,
      })
      cursor = page.cursor
      page.keys.forEach((entry) => {
        found.add(entry.keyBase64)
        expect(entry.type).toBe('string')
        expect(entry.ttl).toBe(-1)
      })
      pages++
      expect(pages).toBeLessThan(1000)
    } while (cursor !== '0')
    expect(found.size).toBe(1500)
    expect(pages).toBeGreaterThan(1)
  }, 30000)

  it('preserves TTL during atomic string updates and rejects stale edits', async () => {
    await control.set(key('cas'), 'before', { EX: 90 })
    const original = await inspect('cas')
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('cas')),
      action: 'set',
      value: 'after',
      expectedBase64: original.rawBase64,
    })
    const after = await inspect('cas')
    expect(after.value).toBe('after')
    expect(after.key.ttl).toBeGreaterThan(85)
    expect(after.key.ttl).toBeLessThanOrEqual(90)
    await expect(
      service.mutate({
        connectionId: profile.id,
        keyBase64: b64(key('cas')),
        action: 'set',
        value: 'stale',
        expectedBase64: original.rawBase64,
      }),
    ).rejects.toThrow('CONFLICT')
    expect(await control.get(key('cas'))).toBe('after')
    await service.mutate({ connectionId: profile.id, keyBase64: b64(key('cas')), action: 'persist' })
    expect((await inspect('cas')).key.ttl).toBe(-1)
  })

  it('supports binary-safe strings, key names, and hash fields', async () => {
    const binaryKey = Buffer.concat([Buffer.from(key('binary:')), Buffer.from([0, 255])])
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(binaryKey),
      action: 'set',
      valueBase64: 'AP8B',
    })
    const value = await service.inspect({
      connectionId: profile.id,
      keyBase64: b64(binaryKey),
      cursor: '0',
      offset: 0,
      count: 100,
    })
    expect(value.value).toEqual({ type: 'binary', base64: 'AP8B' })
    expect(value.rawBase64).toBe('AP8B')
    expect(value.key.key).toContain('base64:')
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('hash')),
      action: 'hset',
      fieldBase64: 'AP8=',
      valueBase64: 'AP8B',
    })
    expect((await inspect('hash')).entries).toEqual([
      [
        { type: 'binary', base64: 'AP8=' },
        { type: 'binary', base64: 'AP8B' },
      ],
    ])
    await control.unlink(binaryKey)
  })

  it('creates keys atomically without replacing an existing value', async () => {
    const target = b64(key('create'))
    await service.mutate({
      connectionId: profile.id,
      keyBase64: target,
      action: 'set',
      value: 'first',
      createOnly: true,
    })
    await expect(
      service.mutate({
        connectionId: profile.id,
        keyBase64: target,
        action: 'set',
        value: 'replacement',
        createOnly: true,
      }),
    ).rejects.toThrow('already exists')
    expect(await control.get(key('create'))).toBe('first')
    const hash = b64(key('create-hash'))
    await service.mutate({
      connectionId: profile.id,
      keyBase64: hash,
      action: 'hset',
      field: 'field',
      value: 'first',
      createOnly: true,
    })
    await expect(
      service.mutate({
        connectionId: profile.id,
        keyBase64: hash,
        action: 'hset',
        field: 'field',
        value: 'replacement',
        createOnly: true,
      }),
    ).rejects.toThrow('already exists')
    expect(await control.hGet(key('create-hash'), 'field')).toBe('first')
  })

  it('inspects and mutates every built-in collection type with bounded pages', async () => {
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('list')),
      action: 'rpush',
      value: 'first',
    })
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('list')),
      action: 'lpush',
      value: 'zero',
    })
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('set')),
      action: 'sadd',
      value: 'member',
    })
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('zset')),
      action: 'zadd',
      value: 'member',
      score: 1.25,
    })
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('stream')),
      action: 'xadd',
      field: 'event',
      value: 'created',
    })
    const list = await inspect('list', { count: 1 })
    expect(list.entries).toEqual([['0', 'zero']])
    expect(list.cursor).toBe('1')
    expect((await inspect('list', { offset: 1, count: 1 })).entries).toEqual([['1', 'first']])
    expect((await inspect('set')).entries).toEqual([['member']])
    expect((await inspect('zset')).entries).toEqual([['member', '1.25']])
    expect((await inspect('stream')).entries[0]!.slice(1)).toEqual(['event', 'created'])
  })

  it('pages compact hashes without losing COUNT-hint overflow', async () => {
    const values = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`f${index}`, `v${index}`]))
    await control.hSet(key('compact-hash'), values)
    const fields = new Set<string>()
    let cursor = '0'
    do {
      const page = await inspect('compact-hash', { cursor, count: 17 })
      expect(page.entries.length).toBeLessThanOrEqual(17)
      page.entries.forEach((row) => fields.add(String(row[0])))
      cursor = page.cursor
    } while (cursor !== '0')
    expect(fields.size).toBe(250)
  })

  it('paginates stream fields without skipping entries with many fields', async () => {
    const fields = Object.fromEntries(Array.from({ length: 230 }, (_, index) => [`f${index}`, `v${index}`]))
    await control.xAdd(key('wide-stream'), '*', fields)
    await control.xAdd(key('wide-stream'), '*', { last: 'last event' })
    const loaded = new Set<string>()
    let cursor = '0'
    do {
      const page = await inspect('wide-stream', { cursor, count: 17 })
      expect(page.entries.length).toBeLessThanOrEqual(17)
      page.entries.forEach((row) => loaded.add(`${row[0]}:${row[1]}`))
      cursor = page.cursor
    } while (cursor !== '0')
    expect(loaded.size).toBe(231)
  })

  it('clips oversized values before sending them to the renderer', async () => {
    await control.set(key('large'), 'x'.repeat(2 * 1024 * 1024))
    const value = await inspect('large')
    expect(value.size).toBe(2 * 1024 * 1024)
    expect(value.truncated).toBe(true)
    expect(String(value.value).length).toBe(1024 * 1024)
    await control.hSet(key('large-hash'), 'field', 'x'.repeat(2 * 1024 * 1024))
    const hash = await inspect('large-hash')
    expect(hash.truncated).toBe(true)
    expect(String(hash.entries[0]![1]).length).toBe(65536)
  })

  it('distinguishes key absence and expiration and refuses to overwrite a rename destination', async () => {
    expect((await inspect('absent')).key.ttl).toBe(-2)
    await control.set(key('rename-from'), 'original', { EX: 90 })
    await control.set(key('rename-to'), 'existing')
    await expect(
      service.mutate({
        connectionId: profile.id,
        keyBase64: b64(key('rename-from')),
        action: 'rename',
        value: key('rename-to'),
      }),
    ).rejects.toThrow('already exists')
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('rename-from')),
      action: 'rename',
      value: key('renamed'),
    })
    expect((await inspect('renamed')).key.ttl).toBeGreaterThan(85)
    await service.mutate({
      connectionId: profile.id,
      keyBase64: b64(key('renamed')),
      action: 'expire',
      ttl: 0,
    })
    expect((await inspect('renamed')).key.type).toBe('none')
  })

  it('keeps large integer console results exact and enforces read-only in privileged code', async () => {
    await control.set(key('integer'), '9223372036854775806')
    const result = await service.execute({
      connectionId: profile.id,
      sessionId: 'console',
      requestId: 'integer',
      sql: `INCR ${key('integer')}`,
      maxRows: 100,
      privateSession: true,
    })
    expect(result.sets[0]!.rows[0]![0]).toBe('9223372036854775807')
    const readOnly = { ...profile, id: 'read-only', readOnly: true }
    expect((await service.connect(readOnly, { password })).state).toBe('connected')
    await expect(
      service.mutate({ connectionId: readOnly.id, keyBase64: b64(key('integer')), action: 'delete' }),
    ).rejects.toThrow('read-only')
    await expect(
      service.execute({
        connectionId: readOnly.id,
        sessionId: 'console',
        requestId: 'readonly',
        sql: `SET ${key('integer')} unsafe`,
        maxRows: 100,
        privateSession: true,
      }),
    ).rejects.toThrow('read-only')
    expect(await control.get(key('integer'))).toBe('9223372036854775807')
    await service.disconnect(readOnly.id)
  })

  it('reports a real authentication failure without claiming a connection', async () => {
    const status = await service.connect(
      { ...profile, id: 'bad-auth' },
      { password: 'incorrect-test-password' },
    )
    expect(status.state).toBe('failed')
    expect(status.error).toMatch(/WRONGPASS|password|authentication/i)
    expect(service.status('bad-auth').state).toBe('failed')
  })

  it('reports dropped sockets and uncertain timed-out writes without replaying them', async () => {
    const sockets = new Set<net.Socket>()
    let upstream: net.Socket | undefined
    const proxy = net.createServer((socket) => {
      const remote = net.connect({ host, port })
      upstream = remote
      sockets.add(socket)
      sockets.add(remote)
      socket.on('error', () => remote.destroy())
      remote.on('error', () => socket.destroy())
      socket.once('close', () => {
        sockets.delete(socket)
        remote.destroy()
      })
      remote.once('close', () => {
        sockets.delete(remote)
        socket.destroy()
      })
      socket.pipe(remote).pipe(socket)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const target = {
      ...profile,
      id: 'network-failure',
      port: (proxy.address() as net.AddressInfo).port,
      queryTimeout: 1000,
    }
    try {
      expect((await service.connect(target, { password })).state).toBe('connected')
      for (const socket of sockets) socket.destroy()
      await vi.waitFor(() => expect(service.status(target.id).state).toBe('failed'))
      await expect(
        service.execute({
          connectionId: target.id,
          sessionId: 'network',
          requestId: 'drop',
          sql: 'PING',
          maxRows: 10,
          privateSession: true,
        }),
      ).rejects.toThrow('disconnected')
      expect((await service.connect(target, { password })).state).toBe('connected')
      upstream!.pause()
      await expect(
        service.execute({
          connectionId: target.id,
          sessionId: 'network',
          requestId: 'timeout',
          sql: `SET ${key('uncertain')} accepted`,
          maxRows: 10,
          privateSession: true,
        }),
      ).rejects.toThrow('write may have reached the server')
      expect(service.status(target.id).state).toBe('failed')
      expect(await control.get(key('uncertain'))).toBe('accepted')
      expect(service.status(target.id).error).toContain('write may have reached the server')
    } finally {
      await service.disconnect(target.id)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  }, 10000)
})
