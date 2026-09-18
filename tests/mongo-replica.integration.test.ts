import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import dns from 'node:dns'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BSON, MongoClient } from 'mongodb'
import { MongoService } from '../src/main/engines/mongo'
import { profileSchema } from '../src/shared/contracts'
import type { MongoIndexPreviewInput } from '../src/shared/mongo-tools'

const fixture = process.env.HARBOR_MONGO_RS_TEST_DIR
describe.skipIf(!fixture)('MongoDB authenticated TLS replica set and reviewed indexes', () => {
  const database = `harbor_rs_${randomUUID().replaceAll('-', '')}`
  const service = new MongoService()
  let control: MongoClient
  let password: string
  const profile = profileSchema.parse({
    id: 'mongo-replica',
    name: 'Disposable replica',
    engine: 'mongodb',
    host: 'localhost',
    port: 27117,
    username: 'harbor_rs_admin',
    database,
    readOnly: false,
    connectTimeout: 4000,
    queryTimeout: 10000,
    mongo: {
      seeds: [
        { host: 'localhost', port: 27118 },
        { host: 'localhost', port: 27119 },
      ],
      replicaSet: 'harbor_rs',
      authSource: 'admin',
      authMechanism: 'SCRAM-SHA-256',
    },
  })
  const target = { connectionId: profile.id, database, collection: 'records' }
  const read = () =>
    service.read({
      ...target,
      mode: 'find' as const,
      query: '{}',
      offset: 0,
      limit: 10,
      direction: 'asc' as const,
    })
  const create = (name: string, fields: string[] = ['n']): MongoIndexPreviewInput => ({
    ...target,
    operation: 'create',
    spec: {
      name,
      keys: fields.map((field) => ({ field, direction: 1 })),
      unique: false,
      sparse: false,
      hidden: false,
    },
  })
  const execute = async (input: MongoIndexPreviewInput) => {
    const review = await service.previewIndex(input)
    return service.executeIndex({
      connectionId: profile.id,
      token: review.token,
      confirm: review.confirmation,
    })
  }
  beforeAll(async () => {
    password = readFileSync(join(fixture!, 'credentials.private.env'), 'utf8').trim().split('=', 2)[1]
    profile.tls = {
      ...profile.tls,
      enabled: true,
      rejectUnauthorized: true,
      ca: readFileSync(join(fixture!, 'tls-ca.pem'), 'utf8'),
    }
    control = new MongoClient('mongodb://localhost:27117,localhost:27118,localhost:27119/', {
      auth: { username: profile.username, password },
      authSource: 'admin',
      replicaSet: 'harbor_rs',
      tls: true,
      tlsCAFile: join(fixture!, 'tls-ca.pem'),
      retryReads: false,
      retryWrites: false,
      serverSelectionTimeoutMS: 15000,
    })
    await control.connect()
    await control
      .db(database)
      .collection('records')
      .insertMany(
        [
          { n: 1, label: 'one', expiresAt: new Date('2099-01-01') },
          { n: 2, label: 'two', expiresAt: new Date('2099-01-01') },
        ],
        { writeConcern: { w: 'majority' } },
      )
    expect((await service.connect(profile, { password })).state).toBe('connected')
  }, 25000)
  afterAll(async () => {
    await service.closeAll()
    if (control) {
      await control.db(database).dropDatabase()
      await control.close()
    }
  })
  it('discovers three verified TLS members with native topology and primary identity', async () => {
    const topology = await service.topology(profile.id)
    expect(topology.setName).toBe('harbor_rs')
    expect(topology.servers).toHaveLength(3)
    expect(topology.primary).toMatch(/^localhost:2711[789]$/)
    expect(topology.writable).toBe(true)
    expect(topology.status.transport).toBe('TLS')
    expect((await read()).documents).toHaveLength(2)
  })
  it('uses surviving seeds and explicit secondary read preference, rejects invalid replica/auth', async () => {
    const secondary = {
      ...profile,
      id: 'mongo-secondary',
      port: 27999,
      mongo: { ...profile.mongo, readPreference: 'secondary' as const },
    }
    expect((await service.connect(secondary, { password })).state).toBe('connected')
    expect((await service.topology(secondary.id)).readPreference).toBe('secondary')
    expect(
      (
        await service.read({
          ...target,
          connectionId: secondary.id,
          mode: 'aggregate',
          query: '[{"$group":{"_id":null,"total":{"$sum":1}}}]',
          offset: 0,
          limit: 10,
          direction: 'asc',
        })
      ).documents.map((document) => BSON.EJSON.parse(document).total),
    ).toEqual([2])
    await service.disconnect(secondary.id)
    await expect(
      service.connect(
        {
          ...profile,
          id: 'bad-rs',
          mongo: { ...profile.mongo, replicaSet: 'not_this_fixture' },
          connectTimeout: 1000,
        },
        { password },
      ),
    ).rejects.toThrow()
    await expect(
      service.connect({ ...profile, id: 'bad-rs-auth' }, { password: 'incorrect-disposable-value' }),
    ).rejects.toThrow()
    expect(service.status('bad-rs-auth').state).toBe('authentication-failed')
  }, 15000)
  it('runs the native SRV/TXT driver path against real TLS members with process-local DNS emulation', async () => {
    const originalResolve = dns.promises.resolve.bind(dns.promises)
    const originalLookup = dns.lookup.bind(dns)
    const resolve = vi.spyOn(dns.promises, 'resolve').mockImplementation((async (
      hostname: string,
      kind: string,
    ) => {
      if (hostname === '_mongodb._tcp.cluster.harbor.test' && kind === 'SRV')
        return [27117, 27118, 27119].map((port, index) => ({
          name: `node${index}.harbor.test`,
          port,
          priority: 0,
          weight: 0,
        }))
      if (hostname === 'cluster.harbor.test' && kind === 'TXT')
        return [['replicaSet=harbor_rs&authSource=admin']]
      return originalResolve(hostname, kind)
    }) as typeof dns.promises.resolve)
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((...args: Parameters<typeof dns.lookup>) => {
      if (args[0].endsWith('.harbor.test')) args[0] = 'localhost'
      return originalLookup(...args)
    }) as typeof dns.lookup)
    const srv = {
      ...profile,
      id: 'mongo-srv-local',
      host: 'cluster.harbor.test',
      port: 27017,
      mongo: { ...profile.mongo, seeds: [], srv: true },
    }
    try {
      expect((await service.connect(srv, { password })).state).toBe('connected')
      expect((await service.topology(srv.id)).setName).toBe('harbor_rs')
      expect(
        (
          await service.read({
            ...target,
            connectionId: srv.id,
            mode: 'find',
            query: '{}',
            offset: 0,
            limit: 10,
            direction: 'asc',
          })
        ).documents,
      ).toHaveLength(2)
      expect(resolve).toHaveBeenCalledWith('_mongodb._tcp.cluster.harbor.test', 'SRV')
    } finally {
      await service.disconnect(srv.id)
      resolve.mockRestore()
      lookup.mockRestore()
    }
  })
  it('creates compound, partial, hidden and TTL indexes only after exact sealed review', async () => {
    const input = create('compound', ['label', 'n'])
    const review = await service.previewIndex(input)
    await expect(
      service.executeIndex({ connectionId: profile.id, token: review.token, confirm: 'wrong' }),
    ).rejects.toThrow(/confirmation/)
    expect(
      (
        await service.executeIndex({
          connectionId: profile.id,
          token: review.token,
          confirm: review.confirmation,
        })
      ).acknowledged,
    ).toBe(true)
    await expect(
      service.executeIndex({ connectionId: profile.id, token: review.token, confirm: review.confirmation }),
    ).rejects.toThrow(/expired/)
    const partial = create('partial')
    if (partial.operation === 'create') {
      partial.spec.partialFilter = '{"n":{"$gt":0}}'
      partial.spec.hidden = true
    }
    await execute(partial)
    const ttl = create('ttl', ['expiresAt'])
    if (ttl.operation === 'create') ttl.spec.expireAfterSeconds = 60
    const ttlReview = await service.previewIndex(ttl)
    expect(ttlReview.confirmation).toContain('CREATE TTL INDEX')
    expect(ttlReview.warnings.join(' ')).toContain('automatic server deletion')
    await service.executeIndex({
      connectionId: profile.id,
      token: ttlReview.token,
      confirm: ttlReview.confirmation,
    })
    const catalog = await service.indexes(target)
    expect(catalog.indexes.find((index) => index.name === 'compound')?.keys.map((key) => key.field)).toEqual([
      'label',
      'n',
    ])
    expect(catalog.indexes.find((index) => index.name === 'partial')?.hidden).toBe(true)
    expect(catalog.indexes.find((index) => index.name === 'ttl')?.expireAfterSeconds).toBe('60')
    expect(await control.db(database).collection('records').countDocuments()).toBe(2)
    expect((await execute({ ...target, operation: 'drop', name: 'compound' })).acknowledged).toBe(true)
    expect((await service.indexes(target)).indexes.some((index) => index.name === 'compound')).toBe(false)
  }, 20000)
  it('rejects changed catalog and dropped/recreated collection identity without submitting DDL', async () => {
    const review = await service.previewIndex(create('stale'))
    await control.db(database).collection('records').createIndex({ label: -1 }, { name: 'outside' })
    await expect(
      service.executeIndex({ connectionId: profile.id, token: review.token, confirm: review.confirmation }),
    ).rejects.toThrow(/changed after review/)
    expect((await service.indexes(target)).indexes.some((index) => index.name === 'stale')).toBe(false)
    await control.db(database).createCollection('identity')
    const identity = await service.previewIndex({ ...create('identity'), collection: 'identity' })
    await control.db(database).collection('identity').drop()
    await control.db(database).createCollection('identity')
    await expect(
      service.executeIndex({
        connectionId: profile.id,
        token: identity.token,
        confirm: identity.confirmation,
      }),
    ).rejects.toThrow(/changed after review/)
  })
  it('rejects read-only index execution and duplicate data without retrying', async () => {
    const ro = { ...profile, id: 'mongo-rs-read-only', readOnly: true }
    await service.connect(ro, { password })
    const review = await service.previewIndex({ ...create('forbidden'), connectionId: ro.id })
    await expect(
      service.executeIndex({ connectionId: ro.id, token: review.token, confirm: review.confirmation }),
    ).rejects.toThrow(/read-only/)
    await service.disconnect(ro.id)
    await control
      .db(database)
      .collection('duplicates')
      .insertMany([{ n: 1 }, { n: 1 }])
    const duplicate = create('unique')
    if (duplicate.operation === 'create') duplicate.spec.unique = true
    await expect(execute({ ...duplicate, collection: 'duplicates' })).rejects.toThrow(
      /existing values violate uniqueness/,
    )
    expect(
      (await service.indexes({ ...target, collection: 'duplicates' })).indexes.map((index) => index.name),
    ).toEqual(['_id_'])
  })
  it('retains the server permission boundary for a read-only database principal', async () => {
    const username = `harbor_limited_${randomUUID().replaceAll('-', '')}`
    await control.db('admin').command({ createUser: username, pwd: password, roles: [{ role: 'read', db: database }] })
    const restricted = { ...profile, id: 'mongo-rs-restricted', username, readOnly: false }
    try {
      await service.connect(restricted, { password })
      const review = await service.previewIndex({ ...create('permission_denied'), connectionId: restricted.id })
      await expect(service.executeIndex({ connectionId: restricted.id, token: review.token, confirm: review.confirmation })).rejects.toThrow(/code 13/)
      expect((await service.indexes(target)).indexes.some((index) => index.name === 'permission_denied')).toBe(false)
    } finally { await service.disconnect(restricted.id); await control.db('admin').command({ dropUser: username }) }
  })
  it('recovers from real primary stepdown and never replays a rejected insert', async () => {
    const oldPrimary = (await service.topology(profile.id)).primary
    try {
      await control.db('admin').command({ replSetStepDown: 5, force: true })
    } catch {
      /* Stepdown may close the command connection. */
    }
    await expect
      .poll(async () => (await control.db('admin').command({ hello: 1 })).primary, { timeout: 20000 })
      .not.toBe(oldPrimary)
    await expect.poll(() => service.status(profile.id).state, { timeout: 20000 }).toBe('connected')
    expect((await read()).documents).toHaveLength(2)
    expect((await service.topology(profile.id)).primary).not.toBe(oldPrimary)
    await control
      .db('admin')
      .command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: { failCommands: ['insert'], errorCode: 91, appName: 'Harbor DB' },
      })
    try {
      await expect(
        service.write({ ...target, action: 'insert', document: '{"noReplay":true}' }),
      ).rejects.toThrow(/uncertain/)
      await expect.poll(() => service.status(profile.id).state, { timeout: 20000 }).toBe('connected')
      // A retry after the one-shot server failure would have inserted this marker.
      expect(await control.db(database).collection('records').countDocuments({ noReplay: true })).toBe(0)
    } finally {
      await control.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' })
    }
  }, 45000)
})
