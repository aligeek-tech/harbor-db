import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RedisService } from '../src/main/engines/redis'
import { profileSchema, type RedisInspectInput } from '../src/shared/contracts'
const enabled = process.env.HARBOR_VALKEY === '1',
  service = new RedisService(),
  prefix = 'harbor-valkey:' + randomUUID() + ':',
  id = 'valkey-native'
const profile = profileSchema.parse({
  id,
  name: 'Disposable Valkey',
  engine: 'valkey',
  host: '127.0.0.1',
  port: 16479,
  username: 'harbor',
  redisDb: 13,
  readOnly: false,
  queryTimeout: 10000,
})
let credentials: { password: string; readerPassword: string },
  admin: ReturnType<typeof createClient>,
  directory: string
const key = (suffix: string) => prefix + suffix,
  b64 = (text: string | Buffer) => Buffer.from(text).toString('base64')
const inspect = (suffix: string, extra: Partial<RedisInspectInput> = {}) =>
  service.inspect({
    connectionId: id,
    keyBase64: b64(key(suffix)),
    cursor: '0',
    offset: 0,
    count: 100,
    ...extra,
  })
const execute = (sql: string, connectionId = id) =>
  service.execute({
    connectionId,
    sessionId: 'console',
    requestId: randomUUID(),
    sql,
    maxRows: 100,
    privateSession: true,
  })
describe.skipIf(!enabled)('real Valkey 9.1.2 standalone auth and TLS', () => {
  beforeAll(async () => {
    directory = process.env.HARBOR_VALKEY_FIXTURE_DIR ?? ''
    if (!directory) throw new Error('External disposable Valkey fixture directory required.')
    credentials = JSON.parse(await readFile(directory + '/credentials.json', 'utf8'))
    admin = createClient({
      socket: { host: '127.0.0.1', port: 16479, reconnectStrategy: false },
      username: 'harbor',
      password: credentials.password,
      database: 13,
    })
    admin.on('error', () => {})
    await admin.connect()
    const status = await service.connect(profile, { password: credentials.password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toBe('Valkey 9.1.2')
  }, 30000)
  afterAll(async () => {
    await service.closeAll()
    if (admin?.isReady) {
      let cursor = '0'
      do {
        const page = await admin.scan(cursor, { MATCH: prefix + '*', COUNT: 500 })
        cursor = page.cursor
        if (page.keys.length) await admin.unlink(page.keys)
      } while (cursor !== '0')
    }
    if (admin?.isOpen) admin.destroy()
  })
  it('rejects product mismatch in both directions rather than claiming protocol compatibility as identity', async () => {
    const wrong = await service.connect(
      { ...profile, id: 'wrong-redis', engine: 'redis' },
      { password: credentials.password },
    )
    expect(wrong.state).toBe('failed')
    expect(wrong.error).toContain('Valkey')
    const redis = await service.connect(
      { ...profile, id: 'wrong-valkey', port: 16379, username: '' },
      { password: 'harbor_test' },
    )
    expect(redis.state).toBe('failed')
    expect(redis.error).toContain('does not identify')
  })
  it('scans incrementally and preserves binary strings, exact integers and logical database scope', async () => {
    for (let start = 0; start < 600; start += 100) {
      const multi = admin.multi()
      for (let index = start; index < start + 100; index++) multi.set(key('scan:' + index), 'v')
      await multi.exec()
    }
    let cursor = '0'
    const found = new Set<string>()
    do {
      const page = await service.scan({ connectionId: id, cursor, pattern: prefix + 'scan:*', count: 50 })
      cursor = page.cursor
      page.keys.forEach((item) => found.add(item.keyBase64))
    } while (cursor !== '0')
    expect(found.size).toBe(600)
    await service.mutate({
      connectionId: id,
      keyBase64: b64(key('binary')),
      action: 'set',
      valueBase64: 'AP+A',
    })
    expect((await inspect('binary')).value).toEqual({ type: 'binary', base64: 'AP+A' })
    await admin.set(key('integer'), '9007199254740992')
    expect((await execute('INCR ' + key('integer'))).sets[0].rows).toEqual([['9007199254740993']])
  })
  it('updates with an atomic expected-value check and preserves TTL', async () => {
    await admin.set(key('cas'), 'before', { EX: 90 })
    const original = await inspect('cas')
    await service.mutate({
      connectionId: id,
      keyBase64: b64(key('cas')),
      action: 'set',
      value: 'after',
      expectedBase64: original.rawBase64,
    })
    expect((await inspect('cas')).key.ttl).toBeGreaterThan(80)
    await expect(
      service.mutate({
        connectionId: id,
        keyBase64: b64(key('cas')),
        action: 'set',
        value: 'stale',
        expectedBase64: original.rawBase64,
      }),
    ).rejects.toThrow('CONFLICT')
    expect(await admin.get(key('cas'))).toBe('after')
  })
  it('inspects hashes/lists/sets/sorted sets/streams using native bounded commands', async () => {
    await admin.hSet(key('hash'), { field: 'value' })
    await admin.rPush(key('list'), ['one', 'two'])
    await admin.sAdd(key('set'), ['member'])
    await admin.zAdd(key('zset'), [{ score: 1.5, value: 'member' }])
    await admin.xAdd(key('stream'), '*', { field: 'value' })
    for (const [suffix, type] of [
      ['hash', 'hash'],
      ['list', 'list'],
      ['set', 'set'],
      ['zset', 'zset'],
      ['stream', 'stream'],
    ]) {
      const value = await inspect(suffix)
      expect(value.key.type).toBe(type)
      expect(value.entries.length).toBeGreaterThan(0)
    }
  })
  it('enforces application read-only and a separate real restricted ACL account', async () => {
    const readonly = { ...profile, id: 'valkey-reader', username: 'reader', readOnly: true }
    const status = await service.connect(readonly, { password: credentials.readerPassword })
    expect(status.state, status.error).toBe('connected')
    expect((await execute('GET ' + key('cas'), readonly.id)).sets[0].rows).toEqual([['after']])
    expect((await inspect('cas', { connectionId: readonly.id })).value).toBe('after')
    await expect(execute('SET ' + key('cas') + ' forbidden', readonly.id)).rejects.toThrow('read-only')
    const restricted = { ...readonly, id: 'valkey-server-acl', readOnly: false }
    expect((await service.connect(restricted, { password: credentials.readerPassword })).state).toBe(
      'connected',
    )
    await expect(execute('SET ' + key('cas') + ' forbidden', restricted.id)).rejects.toThrow(
      /NOPERM|permission/i,
    )
    expect(await admin.get(key('cas'))).toBe('after')
  })
  it('uses native TLS with a trusted CA and rejects untrusted roots and bad authentication', async () => {
    const pem = await readFile(directory + '/cert.pem', 'utf8'),
      trusted = {
        ...profile,
        id: 'valkey-tls',
        port: 16480,
        tls: { enabled: true, rejectUnauthorized: true, ca: pem, cert: '', keyPath: '' },
      }
    const status = await service.connect(trusted, { password: credentials.password })
    expect(status.state, status.error).toBe('connected')
    expect((await execute('PING', trusted.id)).sets[0].rows).toEqual([['PONG']])
    expect(
      (
        await service.connect(
          { ...trusted, id: 'valkey-untrusted', tls: { ...trusted.tls, ca: '' } },
          { password: credentials.password },
        )
      ).state,
    ).toBe('failed')
    const wrong = await service.connect(
      { ...profile, id: 'valkey-bad-auth' },
      { password: 'not-the-disposable-password' },
    )
    expect(wrong.state).toBe('failed')
    expect(wrong.error).not.toContain('not-the-disposable-password')
  })
  it('keeps server administration and unbounded operations out of the command console', async () => {
    for (const command of [
      'KEYS *',
      'CONFIG GET *',
      'ACL LIST',
      'EVAL return 1 0',
      'CLUSTER NODES',
      'SENTINEL MASTERS',
      'SUBSCRIBE example',
    ])
      await expect(execute(command)).rejects.toThrow()
  })
  it('inspects stream consumer groups and captures explicitly subscribed messages with bounded lifetime', async () => {
    await admin.xGroupCreate(key('stream'), 'harbor-group', '0')
    const groups = await service.streamGroups({ connectionId: id, keyBase64: b64(key('stream')) })
    expect(groups.kind).toBe('groups')
    expect(groups.rows.flat()).toContain('harbor-group')
    const channel = prefix + 'channel',
      capture = await service.subscribe({ connectionId: id, channel, seconds: 5 })
    await admin.publish(channel, 'fixture-only-message')
    for (let attempt = 0; attempt < 100 && !service.subscription(capture.id).messages.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.subscription(capture.id).messages[0]?.value).toBe('fixture-only-message')
    expect((await service.stopSubscription(capture.id)).state).toBe('stopped')
    expect((await service.topology(id)).mode).toBe('standalone')
  })
})
