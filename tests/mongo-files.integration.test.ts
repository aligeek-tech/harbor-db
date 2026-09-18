import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BSON, MongoClient } from 'mongodb'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { MongoService } from '../src/main/engines/mongo'
import { MongoFileService } from '../src/main/persistence/mongo-files'
import { profileSchema } from '../src/shared/contracts'
import type { MongoFileJob } from '../src/shared/mongo-files'
const database = 'harbor_files_' + randomUUID().replaceAll('-', '')
const profile = profileSchema.parse({
  id: 'mongo-files',
  name: 'Mongo files fixture',
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
  promoteValues: false,
})
const mongo = new MongoService(),
  files = new MongoFileService(mongo)
let directory = ''
const target = (collection: string) => ({ connectionId: profile.id, database, collection })
const encode = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false })
async function done(job: MongoFileJob) {
  for (let i = 0; i < 2000; i++) {
    const current = files.getJob(job.id)
    if (current.state !== 'running') return current
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('File job did not settle within10seconds.')
}
async function preview(collection: string, documents: unknown[]) {
  const path = join(directory, randomUUID() + '.jsonl')
  await writeFile(path, documents.map(encode).join('\n') + '\n')
  return { preview: await files.previewImport(target(collection), path), path }
}
describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('real MongoDB canonical document file jobs', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-mongo-files-'))
    await control.connect()
    expect((await mongo.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
  })
  afterAll(async () => {
    await files.closeAll()
    await mongo.closeAll()
    await control.db(database).dropDatabase()
    await control.close()
    await rm(directory, { recursive: true, force: true })
  })
  it('exports and imports actual canonical BSON values without changing IDs or numeric/binary types', async () => {
    await control.db(database).createCollection('source')
    await control.db(database).createCollection('destination')
    const documents = [
      {
        _id: new BSON.ObjectId(),
        long: BSON.Long.fromString('9223372036854775807'),
        decimal: BSON.Decimal128.fromString('12345678901234567890.123456789'),
        date: new Date('2026-09-18T00:00:00Z'),
        binary: new BSON.Binary(Buffer.from([0, 255, 128]), 0),
        nested: { empty: '', nil: null },
        stamp: new BSON.Timestamp({ t: 123456789, i: 42 }),
      },
    ]
    await control.db(database).collection('source').insertMany(documents)
    const path = join(directory, 'roundtrip.jsonl')
    const exported = await done(
      await files.startExport(
        { ...target('source'), mode: 'find', query: '{}', maxDocuments: 100, consentRerun: true },
        path,
      ),
    )
    expect(exported).toMatchObject({ state: 'completed', documentsRead: 1, limited: false, outputPath: path })
    const source = await readFile(path, 'utf8')
    expect(source.trim()).toBe(encode(documents[0]))
    expect(source).toContain('$numberLong')
    const selected = await files.previewImport(target('destination'), path)
    const imported = await done(
      await files.startImport({
        token: selected.token,
        confirm: selected.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    )
    expect(imported).toMatchObject({ state: 'completed', acknowledgedDocuments: 1, uncertainDocuments: 0 })
    expect(
      encode(await control.db(database).collection('destination').findOne({ _id: documents[0]._id })),
    ).toBe(encode(documents[0]))
    await expect(
      files.startImport({
        token: selected.token,
        confirm: selected.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    ).rejects.toThrow('expired')
    await expect(
      files.startExport(
        { ...target('source'), mode: 'find', query: '{}', maxDocuments: 100, consentRerun: true },
        path,
      ),
    ).rejects.toThrow('exists')
    expect(await readFile(path, 'utf8')).toBe(source)
  })
  it('reports acknowledged partial inserts when a later line is invalid and never retries duplicate IDs', async () => {
    await control.db(database).createCollection('late')
    const rows = Array.from({ length: 22 }, (_, i) => ({ _id: new BSON.ObjectId(), n: i }))
    const { preview: selected, path } = await preview('late', rows)
    // Retain the approved file fingerprint by placing the malformed line outside the preview before selection.
    await writeFile(path, rows.map(encode).join('\n') + '\n{invalid}\n')
    const fresh = await files.previewImport(target('late'), path)
    const invalid = await done(
      await files.startImport({
        token: fresh.token,
        confirm: fresh.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    )
    expect(invalid).toMatchObject({
      state: 'failed',
      acknowledgedDocuments: 22,
      uncertainDocuments: 0,
      lastLine: 23,
    })
    expect(Number(await control.db(database).collection('late').countDocuments())).toBe(22)
    await expect(
      files.startImport({
        token: selected.token,
        confirm: selected.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    ).rejects.toThrow('changed')
    await control.db(database).createCollection('duplicate')
    const first = { _id: new BSON.ObjectId(), label: 'private-do-not-log' },
      later = { _id: new BSON.ObjectId() }
    const { preview: duplicate } = await preview('duplicate', [first, first, later])
    const failed = await done(
      await files.startImport({
        token: duplicate.token,
        confirm: duplicate.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    )
    expect(failed).toMatchObject({
      state: 'failed',
      acknowledgedDocuments: 1,
      uncertainDocuments: 0,
      documentsRead: 2,
    })
    expect(JSON.stringify(failed)).not.toContain('private-do-not-log')
    expect(Number(await control.db(database).collection('duplicate').countDocuments())).toBe(1)
  })
  it('cancels an actual multi-document import and acknowledges precisely the inserted prefix', async () => {
    await control.db(database).createCollection('cancel')
    const { preview: selected } = await preview(
      'cancel',
      Array.from({ length: 2000 }, (_, n) => ({ n })),
    )
    const job = await files.startImport({
      token: selected.token,
      confirm: selected.confirmation,
      maxDocuments: 2000,
      consentIndividualWrites: true,
    })
    for (let i = 0; i < 1000 && files.getJob(job.id).acknowledgedDocuments < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
    const cancelled = await files.cancelJob(job.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.acknowledgedDocuments).toBeGreaterThanOrEqual(2)
    expect(cancelled.acknowledgedDocuments).toBeLessThan(2000)
    expect(Number(await control.db(database).collection('cancel').countDocuments())).toBe(
      cancelled.acknowledgedDocuments,
    )
    expect(cancelled.uncertainDocuments).toBe(0)
  })
  it('rejects replaced collection identities, reconnects and read-only profiles without dispatch', async () => {
    await control.db(database).createCollection('replaced')
    const { preview: selected } = await preview('replaced', [{ n: 1 }])
    await control.db(database).collection('replaced').drop()
    await control.db(database).createCollection('replaced')
    await expect(
      files.startImport({
        token: selected.token,
        confirm: selected.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    ).rejects.toThrow('identity')
    const { preview: beforeReconnect } = await preview('replaced', [{ n: 1 }])
    await mongo.connect({ ...profile, readOnly: true }, { password: 'harbor_test' })
    await expect(
      files.startImport({
        token: beforeReconnect.token,
        confirm: beforeReconnect.confirmation,
        maxDocuments: 100,
        consentIndividualWrites: true,
      }),
    ).rejects.toThrow('connection changed')
    await expect(files.previewImport(target('replaced'), join(directory, 'roundtrip.jsonl'))).rejects.toThrow(
      'read-only',
    )
    expect(Number(await control.db(database).collection('replaced').countDocuments())).toBe(0)
    await mongo.connect(profile, { password: 'harbor_test' })
  })
  it('bounds input lines and export scope, rejects malformed UTF-8 and mutation pipelines', async () => {
    const path = join(directory, 'invalid.jsonl')
    await writeFile(path, Buffer.from([0xff, 10]))
    await expect(files.previewImport(target('source'), path)).rejects.toThrow('UTF-8')
    await writeFile(path, '{"x":"' + 'x'.repeat(1000001) + '"}\n')
    await expect(files.previewImport(target('source'), path)).rejects.toThrow('bound')
    await control
      .db(database)
      .collection('source')
      .insertMany([{ n: 2 }, { n: 3 }])
    const limited = await done(
      await files.startExport(
        { ...target('source'), mode: 'find', query: '{}', maxDocuments: 1, consentRerun: true },
        join(directory, 'limited.jsonl'),
      ),
    )
    expect(limited).toMatchObject({ state: 'completed', limited: true, documentsRead: 1 })
    const forbidden = await done(
      await files.startExport(
        {
          ...target('source'),
          mode: 'aggregate',
          query: '[{"$out":"must_not_exist"}]',
          maxDocuments: 100,
          consentRerun: true,
        },
        join(directory, 'forbidden.jsonl'),
      ),
    )
    expect(forbidden.state).toBe('failed')
    expect(await control.db(database).listCollections({ name: 'must_not_exist' }).hasNext()).toBe(false)
  })
})

describe.skipIf(!process.env.HARBOR_MONGO_RS_TEST_DIR)(
  'real MongoDB write concern uncertainty in file jobs',
  () => {
    it('stops after a persisted insert with failed write concern, without retrying or dispatching the next document', async () => {
      const fixture = process.env.HARBOR_MONGO_RS_TEST_DIR!,
        password = (await readFile(join(fixture, 'credentials.private.env'), 'utf8')).trim().split('=', 2)[1]
      const ca = await readFile(join(fixture, 'tls-ca.pem'), 'utf8'),
        db = 'harbor_file_ack_' + randomUUID().replaceAll('-', ''),
        directory = await mkdtemp(join(tmpdir(), 'harbor-file-ack-'))
      const client = new MongoClient('mongodb://localhost:27117,localhost:27118,localhost:27119/', {
        auth: { username: 'harbor_rs_admin', password },
        authSource: 'admin',
        replicaSet: 'harbor_rs',
        tls: true,
        tlsCAFile: join(fixture, 'tls-ca.pem'),
        retryWrites: false,
      })
      const service = new MongoService(),
        jobs = new MongoFileService(service)
      const profile = profileSchema.parse({
        id: 'mongo-file-ack',
        name: 'File ack fixture',
        engine: 'mongodb',
        host: 'localhost',
        port: 27117,
        username: 'harbor_rs_admin',
        database: db,
        readOnly: false,
        mongo: {
          replicaSet: 'harbor_rs',
          authSource: 'admin',
          seeds: [
            { host: 'localhost', port: 27118 },
            { host: 'localhost', port: 27119 },
          ],
        },
        tls: { enabled: true, rejectUnauthorized: true, ca },
      })
      try {
        await client.connect()
        await client.db(db).createCollection('records')
        expect((await service.connect(profile, { password })).state).toBe('connected')
        const path = join(directory, 'write.jsonl')
        await writeFile(path, '{"n":1}\n{"n":2}\n')
        const selected = await jobs.previewImport(
          { connectionId: profile.id, database: db, collection: 'records' },
          path,
        )
        await client
          .db('admin')
          .command({
            configureFailPoint: 'failCommand',
            mode: { times: 1 },
            data: {
              failCommands: ['insert'],
              appName: 'Harbor DB',
              writeConcernError: { code: 64, errmsg: 'synthetic acknowledgment uncertainty' },
            },
          })
        const started = await jobs.startImport({
          token: selected.token,
          confirm: selected.confirmation,
          maxDocuments: 100,
          consentIndividualWrites: true,
        })
        let snapshot = jobs.getJob(started.id)
        for (let i = 0; i < 1000 && snapshot.state === 'running'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          snapshot = jobs.getJob(started.id)
        }
        expect(snapshot).toMatchObject({
          state: 'failed',
          documentsRead: 1,
          acknowledgedDocuments: 0,
          uncertainDocuments: 1,
        })
        expect(await client.db(db).collection('records').countDocuments()).toBe(1)
        expect(await client.db(db).collection('records').findOne({ n: 2 })).toBeNull()
        expect(JSON.stringify(snapshot)).not.toContain(password)
      } finally {
        await client
          .db('admin')
          .command({ configureFailPoint: 'failCommand', mode: 'off' })
          .catch(() => {})
        await jobs.closeAll()
        await service.closeAll()
        await client.db(db).dropDatabase()
        await client.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
