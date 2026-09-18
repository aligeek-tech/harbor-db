import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { RedisService } from '../src/main/engines/redis'

const file = process.env.HARBOR_REDIS_TOPOLOGY_ENV_FILE
const credentials = file
  ? (JSON.parse(readFileSync(file, 'utf8')) as { data: string; sentinel: string })
  : { data: '', sentinel: '' }
const service = new RedisService()
const prefix = `harbor-topology:${randomUUID()}:`
const b64 = (key: string) => Buffer.from(key).toString('base64')
const cluster = profileSchema.parse({
  id: 'cluster-real',
  name: 'Disposable cluster',
  engine: 'redis',
  host: '127.0.0.1',
  port: 26371,
  redis: { mode: 'cluster', seeds: [26371, 26372, 26373].map((port) => ({ host: '127.0.0.1', port })) },
  readOnly: false,
  queryTimeout: 5000,
})
const sentinel = profileSchema.parse({
  ...cluster,
  id: 'sentinel-real',
  name: 'Disposable sentinel',
  port: 26391,
  redisDb: 3,
  redis: {
    mode: 'sentinel',
    serviceName: 'harbor-fixture',
    seeds: [26391, 26392, 26393].map((port) => ({ host: '127.0.0.1', port })),
  },
})
const query = (id: string, sql: string) =>
  service.execute({
    connectionId: id,
    sql,
    sessionId: 'manual',
    requestId: randomUUID(),
    maxRows: 100,
    privateSession: true,
  })
const control = (port: number, password = credentials.data) => {
  const c = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false }, password })
  c.on('error', () => {})
  return c
}
const created: { connectionId: string; key: string }[] = []
async function set(connectionId: string, key: string, value: string) {
  await service.mutate({ connectionId, keyBase64: b64(key), action: 'set', value })
  created.push({ connectionId, key })
}

describe.skipIf(!file)('Real Redis Cluster and Sentinel fixtures', () => {
  beforeAll(async () => {
    for (const profile of [cluster, sentinel]) {
      const status = await service.connect(profile, {
        password: credentials.data,
        sentinelPassword: credentials.sentinel,
      })
      expect(status.state, status.error).toBe('connected')
    }
  }, 30000)
  afterAll(async () => {
    for (const item of created)
      await service
        .mutate({ connectionId: item.connectionId, keyBase64: b64(item.key), action: 'delete' })
        .catch(() => {})
    await service.closeAll()
  })
  it('discovers all cluster slots, routes exact binary values and scans all primaries', async () => {
    const topology = await service.topology(cluster.id)
    expect(topology.nodes.filter((node) => node.role === 'primary')).toHaveLength(3)
    expect(topology.nodes.reduce((n, node) => n + (node.slots ?? 0), 0)).toBe(16384)
    for (let index = 0; index < 36; index++) await set(cluster.id, `${prefix}{${index}}`, String(index))
    await service.mutate({
      connectionId: cluster.id,
      keyBase64: b64(`${prefix}{binary}`),
      action: 'set',
      valueBase64: 'AP8B',
    })
    created.push({ connectionId: cluster.id, key: `${prefix}{binary}` })
    expect(
      (
        await service.inspect({
          connectionId: cluster.id,
          keyBase64: b64(`${prefix}{binary}`),
          cursor: '0',
          offset: 0,
          count: 100,
        })
      ).value,
    ).toEqual({ type: 'binary', base64: 'AP8B' })
    let cursor = '0'
    const found = new Set<string>(),
      nodes = new Set<string>()
    do {
      const page = await service.scan({ connectionId: cluster.id, cursor, pattern: `${prefix}*`, count: 10 })
      cursor = page.cursor
      page.keys.forEach((key) => found.add(key.key))
      nodes.add(page.progress!.node)
    } while (cursor !== '0')
    expect(found.size).toBe(37)
    expect(nodes.size).toBe(3)
  })
  it('rejects cross-slot writes atomically and supports shared-tag scripts', async () => {
    const a = `${prefix}{a}:one`,
      b = `${prefix}{b}:two`
    await set(cluster.id, a, 'before')
    await set(cluster.id, b, 'before')
    await expect(query(cluster.id, `MSET ${a} after ${b} after`)).rejects.toThrow('CROSSSLOT')
    expect((await query(cluster.id, `GET ${a}`)).sets[0]!.rows).toEqual([['before']])
    const c = `${prefix}{a}:two`
    await set(cluster.id, c, 'other')
    expect((await query(cluster.id, `MGET ${a} ${c}`)).sets[0]!.rows).toEqual([['before'], ['other']])
    await expect(query(cluster.id, 'SCAN 0')).rejects.toThrow('node-aware')
    await expect(query(cluster.id, 'FLUSHDB')).rejects.toThrow()
  })
  it('binds incremental cursors to profile, pattern, and one consumption', async () => {
    const first = await service.scan({
      connectionId: cluster.id,
      cursor: '0',
      pattern: `${prefix}*`,
      count: 10,
    })
    expect(first.cursor).not.toBe('0')
    await expect(
      service.scan({ connectionId: cluster.id, cursor: first.cursor, pattern: 'other', count: 10 }),
    ).rejects.toThrow('Restart')
    await expect(
      service.scan({ connectionId: cluster.id, cursor: first.cursor, pattern: `${prefix}*`, count: 10 }),
    ).rejects.toThrow('Restart')
  })
  it('uses separate Sentinel auth and the configured logical database', async () => {
    await set(sentinel.id, `${prefix}sentinel`, 'exact')
    expect((await query(sentinel.id, `GET ${prefix}sentinel`)).sets[0]!.rows).toEqual([['exact']])
    const topology = await service.topology(sentinel.id)
    expect(topology.serviceName).toBe('harbor-fixture')
    const port = Number(
      topology.nodes
        .find((node) => node.role === 'primary')!
        .address.split(':')
        .at(-1),
    )
    const c = control(port)
    await c.connect()
    try {
      expect(await c.get(`${prefix}sentinel`)).toBeNull()
    } finally {
      c.destroy()
    }
    const failed = await service.connect(
      { ...sentinel, id: 'wrong-auth' },
      { password: credentials.data, sentinelPassword: 'wrong-disposable-password' },
    )
    expect(failed.state).toBe('failed')
  })
  it('follows actual Sentinel promotion without replaying a user command', async () => {
    const before = (await service.topology(sentinel.id)).nodes.find(
      (node) => node.role === 'primary',
    )!.address
    const c = control(26391, credentials.sentinel)
    await c.connect()
    try {
      await c.sendCommand(['SENTINEL', 'FAILOVER', 'harbor-fixture'])
    } finally {
      c.destroy()
    }
    await expect
      .poll(
        async () => {
          try {
            return (await service.topology(sentinel.id)).nodes.find((node) => node.role === 'primary')!
              .address
          } catch {
            return before
          }
        },
        { timeout: 30000, interval: 500 },
      )
      .not.toBe(before)
    await set(sentinel.id, `${prefix}after-failover`, 'one explicit operation')
    expect((await query(sentinel.id, `GET ${prefix}after-failover`)).sets[0]!.rows).toEqual([
      ['one explicit operation'],
    ])
  }, 40000)
  it('inspects stream groups and bounds real channel captures without publishing from the app', async () => {
    const topology = await service.topology(sentinel.id),
      port = Number(
        topology.nodes
          .find((node) => node.role === 'primary')!
          .address.split(':')
          .at(-1),
      )
    const c = control(port)
    await c.connect()
    await c.select(3)
    const key = `${prefix}stream`,
      channel = `${prefix}capture`
    created.push({ connectionId: sentinel.id, key })
    try {
      await c.xAdd(key, '*', { event: 'synthetic' })
      await c.xGroupCreate(key, 'inspect-only', '0')
      const groups = await service.streamGroups({ connectionId: sentinel.id, keyBase64: b64(key) })
      expect(groups.kind).toBe('groups')
      expect(groups.rows[0]).toContain('inspect-only')
      const capture = await service.subscribe({ connectionId: sentinel.id, channel, seconds: 10 })
      await c.publish(channel, Buffer.from([0, 255, 1]))
      await expect.poll(() => service.subscription(capture.id).messages.length).toBe(1)
      expect(service.subscription(capture.id).messages[0]!.value).toEqual({ type: 'binary', base64: 'AP8B' })
      expect((await service.stopSubscription(capture.id)).state).toBe('stopped')
      const large = await service.subscribe({ connectionId: sentinel.id, channel, seconds: 10 })
      await c.publish(channel, 'x'.repeat(100000))
      await expect.poll(() => service.subscription(large.id).state).toBe('failed')
      expect(service.subscription(large.id).messages).toHaveLength(0)
      expect(service.subscription(large.id).reason).toContain('64 KiB')
      const timed = await service.subscribe({ connectionId: sentinel.id, channel, seconds: 1 })
      await expect.poll(() => service.subscription(timed.id).state, { timeout: 3000 }).toBe('stopped')
    } finally {
      c.destroy()
    }
  }, 15000)
  it('follows a real Cluster replica promotion and MOVED redirection', async () => {
    const before = (await service.topology(cluster.id)).nodes
      .filter((node) => node.role === 'primary')
      .map((node) => node.address)
    const replica = (await service.topology(cluster.id)).nodes.find((node) => node.role === 'replica')!
    const c = control(Number(replica.address.split(':').at(-1)))
    await c.connect()
    try {
      await c.sendCommand(['CLUSTER', 'FAILOVER'])
    } finally {
      c.destroy()
    }
    await expect
      .poll(
        async () => {
          try {
            for (let i = 0; i < 36; i++) await query(cluster.id, `GET ${prefix}{${i}}`)
            return (await service.topology(cluster.id)).nodes
              .filter((node) => node.role === 'primary')
              .map((node) => node.address)
              .sort()
              .join(',')
          } catch {
            return before.sort().join(',')
          }
        },
        { timeout: 20000, interval: 500 },
      )
      .not.toBe(before.sort().join(','))
    expect((await query(cluster.id, `GET ${prefix}{0}`)).sets[0]!.rows).toEqual([['0']])
  }, 30000)
})
