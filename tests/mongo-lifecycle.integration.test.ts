import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BSON, MongoClient } from 'mongodb'
import { MongoService } from '../src/main/engines/mongo'
import { profileSchema } from '../src/shared/contracts'

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('MongoDB live connection lifecycle', () => {
  const database = `harbor_lifecycle_${randomUUID().replaceAll('-', '')}`
  const control = new MongoClient('mongodb://127.0.0.1:17017', {
    auth: { username: 'harbor', password: 'harbor_test' },
    authSource: 'admin',
    retryWrites: false,
  })
  const service = new MongoService()
  const sockets = new Set<net.Socket>()
  let available = true
  let suppressReplies = false
  let insertCommands = 0
  let findCommands = 0
  const proxy = net.createServer((socket) => {
    if (!available) {
      socket.destroy()
      return
    }
    const upstream = net.connect(17017, '127.0.0.1')
    sockets.add(socket)
    sockets.add(upstream)
    let pending = Buffer.alloc(0)
    // Count command names at the real driver/server boundary; never retain or log values.
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const length = pending.readInt32LE(0)
        if (length < 16) {
          socket.destroy()
          return
        }
        const message = pending.subarray(0, length)
        if (message.readInt32LE(12) === 2013 && message[20] === 0) {
          const documentLength = message.readInt32LE(21)
          const command = BSON.deserialize(message.subarray(21, 21 + documentLength))
          if (Object.hasOwn(command, 'insert')) insertCommands++
          if (Object.hasOwn(command, 'find')) findCommands++
        }
        pending = pending.subarray(length)
      }
      upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      if (!suppressReplies) socket.write(chunk)
    })
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => {
      sockets.delete(socket)
      upstream.destroy()
    })
    upstream.on('close', () => {
      sockets.delete(upstream)
      socket.destroy()
    })
  })
  const profile = () =>
    profileSchema.parse({
      id: 'mongo-lifecycle',
      name: 'MongoDB lifecycle fixture',
      engine: 'mongodb',
      host: '127.0.0.1',
      port: (proxy.address() as net.AddressInfo).port,
      username: 'harbor',
      database,
      readOnly: false,
      connectTimeout: 1000,
      queryTimeout: 1000,
    })
  const read = () =>
    service.read({
      connectionId: profile().id,
      database,
      collection: 'records',
      mode: 'find',
      query: '{}',
      offset: 0,
      limit: 10,
      direction: 'asc',
    })
  beforeAll(async () => {
    await control.connect()
    await control.db(database).collection('records').insertOne({ value: 'fixture' })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  })
  afterEach(async () => {
    available = true
    suppressReplies = false
    await service.closeAll()
    for (const socket of sockets) socket.destroy()
  })
  afterAll(async () => {
    await service.closeAll()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await control.db(database).dropDatabase()
    await control.close()
  })

  it('marks idle interruption stale and confirms authenticated recovery without replaying a query', async () => {
    const initial = await service.connect(profile(), { password: 'harbor_test' })
    expect(initial.state).toBe('connected')
    expect(initial.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(initial.changedAt).toBeTruthy()
    expect(initial.lastConnectedAt).toBeTruthy()
    expect((await read()).documents).toHaveLength(1)
    const before = service.status(profile().id)
    const reads = findCommands
    available = false
    for (const socket of sockets) socket.destroy()
    // No foreground operation is needed: SDAM must notice an idle connection loss.
    await expect.poll(() => service.status(profile().id).state, { timeout: 7000 }).toBe('reconnecting')
    const interrupted = service.status(profile().id)
    expect(Date.parse(interrupted.changedAt!)).toBeGreaterThanOrEqual(Date.parse(before.changedAt!))
    expect(interrupted.lastConnectedAt).toBe(before.lastConnectedAt)
    await expect(
      service.write({
        connectionId: profile().id,
        database,
        collection: 'records',
        action: 'insert',
        document: '{"blocked":true}',
      }),
    ).rejects.toThrow('not ready for writes')
    await expect(read()).rejects.toThrow()
    expect(service.status(profile().id).state).not.toBe('connected')
    available = true
    await expect.poll(() => service.status(profile().id).state, { timeout: 15000 }).toBe('connected')
    const recovered = service.status(profile().id)
    expect(Date.parse(recovered.lastConnectedAt!)).toBeGreaterThan(Date.parse(before.lastConnectedAt!))
    expect(recovered.error).toBeUndefined()
    expect(findCommands).toBe(reads)
    expect((await read()).documents).toHaveLength(1)
  })

  it('reports an uncertain acknowledged-on-server write without replaying it during recovery', async () => {
    await service.connect(profile(), { password: 'harbor_test' })
    insertCommands = 0
    suppressReplies = true
    const outcome = expect(
      service.write({
        connectionId: profile().id,
        database,
        collection: 'records',
        action: 'insert',
        document: '{"outcome":"uncertain"}',
      }),
    ).rejects.toThrow('write outcome is uncertain')
    await expect
      .poll(() => control.db(database).collection('records').countDocuments({ outcome: 'uncertain' }))
      .toBe(1)
    await outcome
    expect(service.status(profile().id).state).not.toBe('connected')
    suppressReplies = false
    for (const socket of sockets) socket.destroy()
    await expect.poll(() => service.status(profile().id).state, { timeout: 15000 }).toBe('connected')
    expect(insertCommands).toBe(1)
    expect(await control.db(database).collection('records').countDocuments({ outcome: 'uncertain' })).toBe(1)
  })

  it('retains authentication failure until an explicit corrected connection and disconnect', async () => {
    await expect(service.connect(profile(), { password: 'incorrect-private-fixture' })).rejects.toThrow()
    const failed = service.status(profile().id)
    expect(failed.state).toBe('authentication-failed')
    expect(failed.checkedAt).toBeTruthy()
    expect(JSON.stringify(failed)).not.toContain('incorrect-private-fixture')
    await expect(read()).rejects.toThrow('Connect to MongoDB first')
    expect((await service.connect(profile(), { password: 'harbor_test' })).state).toBe('connected')
    await service.disconnect(profile().id)
    const disconnected = service.status(profile().id)
    expect(disconnected.state).toBe('disconnected')
    expect(disconnected.checkedAt).toBeTruthy()
    await expect(read()).rejects.toThrow('Connect to MongoDB first')
    expect(service.status(profile().id)).toEqual(disconnected)
  })

  it('cannot resurrect a connection that was explicitly disconnected during startup', async () => {
    suppressReplies = true
    const pending = service.connect(profile(), { password: 'harbor_test' }).catch(() => undefined)
    await expect.poll(() => service.status(profile().id).state).toBe('connecting')
    await service.disconnect(profile().id)
    suppressReplies = false
    await pending
    expect(service.status(profile().id).state).toBe('disconnected')
    await expect(read()).rejects.toThrow('Connect to MongoDB first')
  })
})
