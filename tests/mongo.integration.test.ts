import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BSON, MongoClient } from 'mongodb'
import { MongoService } from '../src/main/engines/mongo'
import { profileSchema, type MongoReadInput } from '../src/shared/contracts'

const database = `harbor_test_${randomUUID().replaceAll('-', '')}`
const profile = profileSchema.parse({
  id: 'mongo-test',
  name: 'Local MongoDB fixture',
  engine: 'mongodb',
  host: '127.0.0.1',
  port: 17017,
  username: 'harbor',
  database,
  readOnly: false,
})
const control = new MongoClient('mongodb://127.0.0.1:17017', {
  auth: { username: 'harbor', password: 'harbor_test' },
  authSource: 'admin',
})
const service = new MongoService()
const target = { connectionId: profile.id, database, collection: 'records' }
const read = (extra: Partial<MongoReadInput> = {}) =>
  service.read({ ...target, mode: 'find', query: '{}', offset: 0, limit: 10, direction: 'asc', ...extra })
const encode = (doc: unknown) => BSON.EJSON.stringify(doc, { relaxed: false })

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('MongoDB integration', () => {
  beforeAll(async () => {
    await control.connect()
    await control
      .db(database)
      .collection('records')
      .insertMany(Array.from({ length: 25 }, (_, n) => ({ n, label: `record-${n}` })))
    expect((await service.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
  })
  afterAll(async () => {
    await service.closeAll()
    await control.db(database).dropDatabase()
    await control.close()
  })
  it('lists authorized databases and collections', async () => {
    expect(await service.databases(profile.id)).toContain(database)
    expect(await service.collections(target)).toContain('records')
  })
  it('sorts all matching documents on the server and pages results', async () => {
    const first = await read({ sort: 'n', direction: 'desc' })
    expect(first.documents).toHaveLength(10)
    expect(first.hasMore).toBe(true)
    expect(BSON.EJSON.parse(first.documents[0]).n).toBe(24)
    const last = await read({ sort: 'n', direction: 'asc', offset: 20 })
    expect(last.documents).toHaveLength(5)
    expect(last.hasMore).toBe(false)
    expect(BSON.EJSON.parse(last.documents[0]).n).toBe(20)
    const filtered = await read({ query: '{"n":{"$gte":23}}', sort: 'n' })
    expect(filtered.documents).toHaveLength(2)
  })
  it('supports aggregation without write stages or server-side JavaScript', async () => {
    const result = await read({ mode: 'aggregate', query: '[{"$group":{"_id":null,"total":{"$sum":1}}}]' })
    expect(BSON.EJSON.parse(result.documents[0]).total).toBe(25)
    await expect(read({ mode: 'aggregate', query: '[{"$out":"copied"}]' })).rejects.toThrow(/not supported/)
    expect(await service.collections(target)).not.toContain('copied')
  })
  it('round-trips BSON, edits and deletes with an exact original-document conflict check', async () => {
    const doc = {
      _id: new BSON.ObjectId(),
      date: new Date('2026-01-01T00:00:00Z'),
      large: BSON.Long.fromString('9223372036854775807'),
      decimal: BSON.Decimal128.fromString('123456789.123456789'),
      bytes: new BSON.Binary(Buffer.from([0, 255, 10])),
      nested: { text: '$value', values: [1, true] },
      label: 'before',
    }
    await service.write({ ...target, action: 'insert', document: encode(doc) })
    const result = await read({ query: encode({ _id: doc._id }) })
    const original = result.documents[0]
    const replacement = BSON.EJSON.parse(original, { relaxed: false })
    replacement.label = 'after'
    await service.write({ ...target, action: 'replace', original, document: encode(replacement) })
    const stored = await control
      .db(database)
      .collection('records')
      .findOne({ _id: doc._id }, { promoteValues: false })
    expect(stored?.large.toString()).toBe('9223372036854775807')
    expect(stored?.date).toEqual(doc.date)
    expect(stored?.decimal.toString()).toBe(doc.decimal.toString())
    expect(stored?.bytes.value()).toEqual(doc.bytes.value())
    expect(stored?.label).toBe('after')
    await expect(service.write({ ...target, action: 'delete', original })).rejects.toThrow(/Conflict/)
    const current = (await read({ query: encode({ _id: doc._id }) })).documents[0]
    await control
      .db(database)
      .collection('records')
      .updateOne({ _id: doc._id }, { $set: { concurrent: true } })
    await expect(
      service.write({ ...target, action: 'replace', original: current, document: current }),
    ).rejects.toThrow(/Conflict/)
    const fresh = (await read({ query: encode({ _id: doc._id }) })).documents[0]
    await expect(
      service.write({
        ...target,
        action: 'replace',
        original: fresh,
        document: encode({ ...doc, _id: new BSON.ObjectId() }),
      }),
    ).rejects.toThrow(/cannot be changed/)
    await service.write({ ...target, action: 'delete', original: fresh })
    expect(await control.db(database).collection('records').findOne({ _id: doc._id })).toBeNull()
  })
  it('detects case-only concurrent changes on a case-insensitive collection', async () => {
    await control
      .db(database)
      .createCollection('case_insensitive', { collation: { locale: 'en', strength: 2 } })
    const collection = control.db(database).collection('case_insensitive')
    const { insertedId } = await collection.insertOne({ label: 'before' })
    const original = (await read({ collection: 'case_insensitive' })).documents[0]
    await collection.updateOne({ _id: insertedId }, { $set: { label: 'BEFORE' } })
    await expect(
      service.write({ ...target, collection: 'case_insensitive', action: 'delete', original }),
    ).rejects.toThrow(/Conflict/)
    expect(await collection.countDocuments()).toBe(1)
  })
  it('enforces read-only writes in the main process', async () => {
    const ro = { ...profile, id: 'mongo-read-only', readOnly: true }
    await service.connect(ro, { password: 'harbor_test' })
    for (const action of ['insert', 'replace', 'delete'] as const)
      await expect(
        service.write({ ...target, connectionId: ro.id, action, document: '{}', original: '{}' }),
      ).rejects.toThrow(/read-only/)
    await service.disconnect(ro.id)
  })
  it('bounds large previews by bytes', async () => {
    await control
      .db(database)
      .collection('large')
      .insertMany([{ text: 'x'.repeat(2500000) }, { text: 'y'.repeat(2500000) }])
    const result = await read({ collection: 'large' })
    expect(result.truncated).toBe(true)
    expect(result.documents).toHaveLength(1)
  })
  it('connects through verified TLS and rejects a certificate for another host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-mongo-tls-'))
    const key = join(dir, 'key.pem'),
      cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    )
    const sockets = new Set<net.Socket>()
    const proxy = tls.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
      const upstream = net.connect(17017, '127.0.0.1')
      sockets.add(socket)
      sockets.add(upstream)
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
      socket.pipe(upstream).pipe(socket)
    })
    proxy.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as net.AddressInfo).port
    const secure = {
      ...profile,
      id: 'mongo-tls',
      host: 'localhost',
      port,
      connectTimeout: 2000,
      tls: { ...profile.tls, enabled: true, ca: readFileSync(cert, 'utf8') },
    }
    try {
      expect((await service.connect(secure, { password: 'harbor_test' })).transport).toBe('TLS')
      expect((await read({ connectionId: secure.id })).documents.length).toBeGreaterThan(0)
      await service.disconnect(secure.id)
      await expect(
        service.connect({ ...secure, host: '127.0.0.1' }, { password: 'harbor_test' }),
      ).rejects.toThrow(/certificate|altnames|IP/i)
    } finally {
      await service.disconnect(secure.id)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('cleans up failed connections', async () => {
    await expect(service.connect({ ...profile, id: 'bad-auth' }, { password: 'incorrect' })).rejects.toThrow()
    expect(service.status('bad-auth').state).toBe('disconnected')
  })
})
