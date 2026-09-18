import { afterEach, expect, it } from 'vitest'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { BigQueryService, bigQueryParameters, bigQueryRows } from '../src/main/engines/bigquery'
import { CloudHttpError, type JsonRecord } from '../src/main/engines/cloud-json'
import { parse } from 'lossless-json'
import { sqlSafety, requiredSqlConfirmation } from '../src/shared/sql'

const services: BigQueryService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.closeAll() })
const profile = (patch: Partial<ConnectionProfile> = {}) => profileSchema.parse({ id: 'bq', name: 'Disposable BigQuery', engine: 'bigquery', host: 'bigquery.googleapis.com', port: 443, database: 'harbor-fixture', schema: 'synthetic', tls: { enabled: true, rejectUnauthorized: true }, ...patch })
const columns = [{ name: 'id', type: 'INTEGER' },{ name: 'amount', type: 'BIGNUMERIC' }]
const page = { jobComplete: true, schema: { fields: columns }, rows: [{ f: [{ v: '9223372036854775807' },{ v: '12345678901234567890.123456789012345678' }] }] }
function fixture(handler?: (method: string, path: string, body: unknown) => JsonRecord | Promise<JsonRecord>) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  let closed = false
  const service = new BigQueryService(() => ({ close: () => { closed = true }, request: async (method, path, body) => {
    calls.push({ method, path, body })
    if (handler) return handler(method, path, body)
    if (path.includes('/datasets?')) return { datasets: [] }
    if (method === 'POST' && path.endsWith('/jobs')) return { status: { state: 'RUNNING' } }
    if (path.includes('/jobs/') && !path.includes('/cancel')) return { status: { state: 'DONE' }, statistics: { query: { totalBytesProcessed: '9007199254740993' } } }
    if (path.includes('/queries/')) return page
    return {}
  } }))
  services.push(service)
  return { service, calls, closed: () => closed }
}

it('keeps native typed nested values, repeated names, decimals, bytes and epoch timestamps exact', () => {
  const fields = [{ name: 'n', type: 'BIGNUMERIC' },{ name: 'n', type: 'BYTES' },{ name: 'ts', type: 'TIMESTAMP' },{ name: 'items', type: 'INTEGER', mode: 'REPEATED' },{ name: 'obj', type: 'RECORD', fields: [{ name: 'n', type: 'INTEGER' }] },{ name: 'empty', type: 'STRING' }]
  expect(bigQueryRows({ rows: [{ f: [{ v: '12345678901234567890.123456789012345678' },{ v: 'AP8=' },{ v: '1789700000.123456' },{ v: [{ v: '9223372036854775807' }] },{ v: { f: [{ v: '9007199254740993' }] } },{ v: '' }] },{ f: fields.map(() => ({ v: null })) }] }, fields)).toEqual([
    ['12345678901234567890.123456789012345678',{ type: 'binary', base64: 'AP8=' },'1789700000.123456','["9223372036854775807"]','{"fields":[{"name":"n","type":"INTEGER","value":"9007199254740993"}]}',''],
    [null,null,null,null,null,null],
  ])
})

it('binds values through native named parameter fields and rejects rounding-prone or invalid shapes', () => {
  expect(bigQueryParameters([{ name: 'amount', type: 'decimal', value: '12345678901234567890.123456789012345678', secret: true }])[0]).toEqual({ name: 'amount', parameterType: { type: 'BIGNUMERIC' }, parameterValue: { value: '12345678901234567890.123456789012345678' } })
  for (const value of ['1e100','0.' + '1'.repeat(39)]) expect(() => bigQueryParameters([{ name: 'n', type: 'decimal', value, secret: false }])).toThrow(/no rounding/)
  expect(() => bigQueryParameters([{ name: 'n', type: 'integer', value: '9223372036854775808', secret: false }])).toThrow(/64-bit/)
})

it('requires reviewed billing, preserves job/session identity, and pages only the submitted job', async () => {
  const { service, calls, closed } = fixture(), p = profile()
  expect((await service.connect(p, { password: 'synthetic-token' })).state).toBe('connected')
  const input = { connectionId: p.id, sessionId: 'tab', requestId: 'request', database: p.database, sql: 'SELECT @amount AS amount', parameters: [{ name: 'amount', type: 'decimal' as const, value: '1.123456789012345678', secret: true }], maxRows: 1, privateSession: true }
  await expect(service.execute(input)).rejects.toThrow(/billing/)
  expect(calls).toHaveLength(1)
  const result = await service.execute({ ...input, confirm: p.name })
  expect(result.sets[0].rows).toEqual([['9223372036854775807','12345678901234567890.123456789012345678']])
  const submitted = calls.find((call) => call.method === 'POST')!.body as { jobReference: { jobId: string }; configuration: { query: JsonRecord } }
  expect(submitted.configuration.query).toMatchObject({ maximumBytesBilled: '100000000', useLegacySql: false, parameterMode: 'NAMED' })
  expect(calls.filter((call) => call.path.includes('/jobs/')).every((call) => call.path.includes(submitted.jobReference.jobId))).toBe(true)
  expect(service.progress({ connectionId: p.id, sessionId: 'tab', requestId: 'request' })?.processedBytes).toBe('9007199254740993')
  expect(service.progress({ connectionId: p.id, sessionId: 'other', requestId: 'request' })).toBeNull()
  await service.disconnect(p.id); expect(closed()).toBe(true)
})

it('does not resubmit uncertain writes and reports native cancellation as best effort', async () => {
  const { service, calls } = fixture((method, path) => { if (method === 'POST' && path.endsWith('/jobs')) throw new Error('synthetic lost submission acknowledgement'); return {} }), p = profile({ readOnly: false })
  await service.connect(p, { password: 'synthetic-token' })
  await expect(service.execute({ connectionId: p.id, sessionId: 't', requestId: 'r', database: p.database, sql: 'INSERT INTO synthetic.t VALUES(1)', maxRows: 10, privateSession: true, confirm: p.name })).rejects.toThrow(/No retry occurred/)
  expect(calls.filter((call) => call.path.endsWith('/jobs'))).toHaveLength(1)
  expect(calls.filter((call) => call.path.includes('/cancel?location=US'))).toHaveLength(1)
  expect(service.status(p.id).state).toBe('degraded')
})

it('dry-runs without dispatching jobs and preserves byte estimates beyond JavaScript precision', async () => {
  const { service, calls } = fixture((_method, path) => path.endsWith('/queries') ? parse('{"totalBytesProcessed":9007199254740993}') as JsonRecord : {}), p = profile()
  await service.connect(p, { password: 'synthetic-token' })
  expect((await service.estimate({ connectionId: p.id, database: p.database, sql: 'SELECT 1' })).processedBytes).toBe('9007199254740993')
  expect(calls.at(-1)?.body).toMatchObject({ dryRun: true, location: 'US' })
  expect(calls.some((call) => call.path.endsWith('/jobs'))).toBe(false)
})

it('fails closed on insecure endpoint, expired token, readonly write, raw transaction and unreviewed table read', async () => {
  const { service } = fixture(), p = profile()
  expect((await service.connect({ ...p, host: 'other.example' }, { password: 'synthetic' })).state).toBe('failed')
  expect((await service.connect({ ...p, tls: { ...p.tls, rejectUnauthorized: false } }, { password: 'synthetic' })).state).toBe('failed')
  await service.connect(p, { password: 'synthetic' })
  for (const sql of ['DELETE FROM synthetic.t','SET x=1']) await expect(service.execute({ connectionId: p.id, database: p.database, sessionId: 't', requestId: 'r', sql, maxRows: 1, privateSession: true, confirm: p.name })).rejects.toThrow()
  expect(sqlSafety('SELECT `value`, @amount FROM `project.dataset.table`', 'bigquery').readOnly).toBe(true)
  expect(requiredSqlConfirmation('SELECT 1', 'bigquery', p)).toBe(p.name)
  const expired = fixture(() => { throw new CloudHttpError(401) }).service
  expect((await expired.connect(p, { password: 'expired' })).state).toBe('authentication-failed')
})
