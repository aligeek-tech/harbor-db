import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TrinoService } from '../src/main/engines/trino'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'

const file = process.env.HARBOR_TRINO_FIXTURE
describe.skipIf(!file)('Trino native coordinator and memory connector', () => {
  const service = new TrinoService(), schema = 'verify_' + randomUUID().replaceAll('-', '').slice(0, 12)
  let writer: ConnectionProfile, reader: ConnectionProfile, password = ''
  const query = (sql: string, profile = writer, maxRows = 1000, sessionId = randomUUID(), requestId = randomUUID()) => service.execute({ connectionId: profile.id, sessionId, requestId, sql, database: 'memory', maxRows, privateSession: true, confirm: profile.name })
  beforeAll(async () => {
    const config = JSON.parse(await readFile(file!, 'utf8'))
    password = config.password
    const ca = await readFile(file!.replace('credentials.private.json', 'ca.pem'), 'utf8')
    writer = profileSchema.parse({ id: 'trino-writer', name: 'Disposable Trino writer', engine: 'trino', host: '127.0.0.1', port: config.port, username: 'harbor_writer', database: 'memory', schema: '', trino: { auth: 'basic' }, tls: { enabled: true, rejectUnauthorized: true, ca }, readOnly: false, queryTimeout: 30000 })
    reader = profileSchema.parse({ ...writer, id: 'trino-reader', name: 'Disposable Trino reader', username: 'harbor_reader', readOnly: true })
    const connected = await service.connect(writer, { password })
    expect(connected.state, connected.error).toBe('connected')
    expect((await service.connect(reader, { password })).state).toBe('connected')
    await query(`CREATE SCHEMA memory.${schema}`)
    await query(`CREATE TABLE memory.${schema}.sample (id bigint,amount decimal(38,18),label varchar,bytes varbinary,instant timestamp(12) with time zone)`)
    await query(`INSERT INTO memory.${schema}.sample VALUES (9223372036854775807,DECIMAL '12345678901234567890.123456789012345678','',X'00ff',TIMESTAMP '2026-09-18 12:34:56.123456789012 +03:30'),(1,NULL,NULL,NULL,NULL)`)
  }, 60000)
  afterAll(async () => {
    if (writer && service.status(writer.id).state === 'connected') {
      await query(`DROP TABLE IF EXISTS memory.${schema}.sample`).catch(() => {})
      await query(`DROP SCHEMA IF EXISTS memory.${schema}`).catch(() => {})
    }
    await service.closeAll()
  })
  it('authenticates with native TLS, lists catalogs/schema objects and native metadata', async () => {
    expect(await service.listDatabases(writer.id)).toEqual(expect.arrayContaining(['memory','tpch']))
    expect(await service.listObjects({ connectionId: reader.id, database: 'memory', schema })).toContainEqual({ name: 'sample', schema, database: 'memory', kind: 'table' })
    const metadata = await service.structure({ connectionId: reader.id, database: 'memory', schema, table: 'sample' })
    expect(metadata.columns.map((column) => column.name)).toEqual(['id','amount','label','bytes','instant'])
    expect(metadata.ddl).toMatch(/PERMISSION_DENIED/)
    // Native file access control allows SELECT but restricts SHOW CREATE to writers.
    expect((await service.structure({ connectionId: writer.id, database: 'memory', schema, table: 'sample' })).ddl).toMatch(/CREATE TABLE/)
  })
  it('preserves big integers, decimal scale, binary, null, empty and picosecond time strings', async () => {
    const result = await query(`SELECT * FROM memory.${schema}.sample ORDER BY id DESC`, reader)
    expect(result.sets[0].rows[0]).toEqual(['9223372036854775807','12345678901234567890.123456789012345678','',{ type: 'binary', base64: 'AP8=' },'2026-09-18 12:34:56.123456789012 +03:30'])
    expect(result.sets[0].rows[1]).toEqual(['1',null,null,null,null])
  })
  it('bounds pages, retains duplicate columns and streams a complete read-only result', async () => {
    const capped = await query('SELECT orderkey AS duplicate,orderkey AS duplicate FROM tpch.tiny.orders', reader, 3)
    expect(capped.sets[0].columns.map((column) => column.name)).toEqual(['duplicate','duplicate'])
    expect(capped.sets[0].rows).toHaveLength(3); expect(capped.sets[0].truncated).toBe(true)
    let rows = 0
    await service.streamQuery({ connectionId: reader.id, database: 'tpch', sql: 'SELECT orderkey FROM tpch.tiny.orders LIMIT 2500' }, { signal: new AbortController().signal, onColumns: async (columns) => { expect(columns[0].type).toBe('bigint') }, onRow: async () => { rows++ } })
    expect(rows).toBe(2500)
  })
  it('requires exact reviewed writes and preserves server read-only privileges', async () => {
    await expect(service.execute({ connectionId: writer.id, sessionId: randomUUID(), requestId: randomUUID(), database: 'memory', sql: `DELETE FROM memory.${schema}.sample`, maxRows: 1, privateSession: true })).rejects.toThrow(/exact profile name/)
    await expect(query(`DELETE FROM memory.${schema}.sample`, reader)).rejects.toThrow(/read-only/)
    const privilege = profileSchema.parse({ ...reader, id: 'trino-native-restricted', readOnly: false })
    expect((await service.connect(privilege, { password })).state).toBe('connected')
    await expect(query(`INSERT INTO memory.${schema}.sample(id) VALUES (9)`, privilege)).rejects.toThrow(/ACCESS_DENIED|PERMISSION_DENIED/)
    await service.disconnect(privilege.id)
    expect((await query(`SELECT count(*) FROM memory.${schema}.sample`, reader)).sets[0].rows).toEqual([['2']])
  })
  it('rejects wrong credentials and certificate identity with no insecure fallback', async () => {
    expect((await service.connect({ ...writer, id: 'trino-wrong-password' }, { password: 'incorrect-disposable-password' })).state).toBe('authentication-failed')
    expect((await service.connect({ ...writer, id: 'trino-wrong-host', host: 'localhost' }, { password })).state).toBe('failed')
    expect((await service.connect({ ...writer, id: 'trino-missing-ca', tls: { ...writer.tls, ca: '' } }, { password })).state).toBe('failed')
  })
  it('runs quoted server filters without interpolating identifiers or changing filter values', async () => {
    const result = await service.table({ connectionId: reader.id, sessionId: randomUUID(), database: 'memory', schema, table: 'sample', offset: 0, limit: 10, direction: 'asc', sorts: [{ column: 'id', direction: 'desc' }], filters: { match: 'all', conditions: [{ column: 'label', operator: 'equals', value: '' }] } })
    expect(result.sets[0].rows).toHaveLength(1)
    expect(result.sets[0].rows[0][0]).toBe('9223372036854775807')
  })
  it('cancels only the exact active session/request and reports native acknowledgement', async () => {
    const sessionId = randomUUID(), requestId = randomUUID()
    const running = query('SELECT sum(a.orderkey * b.orderkey) FROM tpch.sf1.orders a CROSS JOIN tpch.sf1.orders b', reader, 10, sessionId, requestId).then(() => ({ error: '' }), (error: Error) => ({ error: error.message }))
    await expect.poll(() => service.progress({ connectionId: reader.id, sessionId, requestId })?.queryId, { timeout: 10000 }).toBeTruthy()
    expect((await service.cancel({ connectionId: reader.id, sessionId, requestId: randomUUID() })).requested).toBe(false)
    const cancelled = await service.cancel({ connectionId: reader.id, sessionId, requestId })
    expect(cancelled.requested).toBe(true)
    expect(cancelled.message).toMatch(/acknowledged cancellation/)
    expect((await running).error).toMatch(/cancelled/)
    expect(service.getSessionState({ connectionId: reader.id, sessionId }).running).toBe(false)
    expect((await query('SELECT 1', reader)).sets[0].rows).toEqual([['1']])
  })
})
