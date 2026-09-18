import { afterEach, expect, it } from 'vitest'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { AthenaService, athenaRows } from '../src/main/engines/athena'
import type { AthenaAction } from '../src/main/engines/athena-client'
import type { JsonRecord } from '../src/main/engines/cloud-json'
import { athenaTableDraft } from '../src/shared/athena'
import { requiredSqlConfirmation } from '../src/shared/sql'

const services: AthenaService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.closeAll()
})
const profile = (patch: Partial<ConnectionProfile> = {}) =>
  profileSchema.parse({
    id: 'athena',
    name: 'Synthetic Athena',
    engine: 'athena',
    host: 'athena.us-east-1.amazonaws.com',
    port: 443,
    database: 'fixture',
    schema: '',
    tls: { enabled: true },
    athena: { outputLocation: 's3://synthetic-bucket/results/', expectedBucketOwner: '123456789012' },
    ...patch,
  })
const storage = {
  OutputLocation: 's3://synthetic-bucket/results/',
  ExpectedBucketOwner: '123456789012',
  EncryptionConfiguration: { EncryptionOption: 'SSE_S3' },
}
const group = () => ({
  WorkGroup: {
    Name: 'primary',
    State: 'ENABLED',
    Configuration: {
      EnforceWorkGroupConfiguration: true,
      BytesScannedCutoffPerQuery: 50_000_000,
      ResultConfiguration: storage,
      EngineVersion: { EffectiveEngineVersion: 'Athena engine version 3' },
    },
  },
})
const execution = () => ({
  QueryExecution: {
    QueryExecutionId: 'query1',
    WorkGroup: 'primary',
    SubstatementType: 'SELECT',
    Status: { State: 'SUCCEEDED' },
    Statistics: { DataScannedInBytes: 123 },
    ResultConfiguration: { ...storage, OutputLocation: storage.OutputLocation + 'query1.csv' },
  },
})
const rows = (values: (string | null)[][]) =>
  values.map((values) => ({ Data: values.map((value) => (value === null ? {} : { VarCharValue: value })) }))
const page = (values: (string | null)[][], next?: string) => ({
  ResultSet: { ResultSetMetadata: { ColumnInfo: [{ Name: 'value', Type: 'bigint' }] }, Rows: rows(values) },
  ...(next ? { NextToken: next } : {}),
})
function fixture(
  overrides?: (
    action: AthenaAction,
    input: JsonRecord,
    signal?: AbortSignal,
  ) => JsonRecord | Promise<JsonRecord> | undefined,
) {
  const calls: { action: AthenaAction; input: JsonRecord }[] = []
  const service = new AthenaService(() => ({
    close: () => {},
    call: async (action, input, signal) => {
      calls.push({ action, input })
      const override = await overrides?.(action, input, signal)
      if (override) return override
      if (action === 'GetWorkGroup') return group()
      if (action === 'GetDataCatalog') return { DataCatalog: { Name: 'AwsDataCatalog' } }
      if (action === 'StartQueryExecution') return { QueryExecutionId: 'query1' }
      if (action === 'GetQueryExecution') return execution()
      if (action === 'GetQueryResults') return page([['value'], ['9223372036854775807'], [null], ['']])
      if (action === 'StopQueryExecution') return {}
      return {}
    },
  }))
  services.push(service)
  return { service, calls }
}
const query = (p: ConnectionProfile, patch = {}) => ({
  connectionId: p.id,
  database: p.database,
  sessionId: 'tab',
  requestId: 'request',
  sql: 'SELECT value FROM fixture.t',
  maxRows: 100,
  privateSession: true,
  confirm: p.name,
  ...patch,
})

it('uses native query identity, fixed catalog/workgroup/output scope and exact result pages', async () => {
  const { service, calls } = fixture((action, input) =>
      action === 'GetQueryResults'
        ? input.NextToken
          ? page([['9007199254740993']])
          : page([['value'], ['9223372036854775807']], 'next1')
        : undefined,
    ),
    p = profile()
  expect((await service.connect(p, { password: 'injected test endpoint only' })).state).toBe('connected')
  const result = await service.execute(query(p))
  expect(result.sets[0].rows).toEqual([['9223372036854775807'], ['9007199254740993']])
  expect(calls.filter((call) => call.action === 'StartQueryExecution')).toHaveLength(1)
  expect(calls.find((call) => call.action === 'StartQueryExecution')?.input).toMatchObject({
    QueryExecutionContext: { Catalog: 'AwsDataCatalog', Database: 'fixture' },
    WorkGroup: 'primary',
    ResultConfiguration: {
      OutputLocation: storage.OutputLocation,
      ExpectedBucketOwner: storage.ExpectedBucketOwner,
    },
    ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: false } },
  })
  expect(service.progress({ connectionId: p.id, sessionId: 'tab', requestId: 'request' })).toMatchObject({
    queryId: 'query1',
    phase: 'SUCCEEDED',
    rowsReceived: 2,
    processedBytes: '123',
  })
})

it('preserves duplicate labels, decimal, null, empty, binary and temporal native text', () => {
  const values = [
    '12345678901234567890.123456789012345678',
    null,
    '',
    '00 ff',
    '2026-09-18 00:00:00.123456789',
    'false',
  ]
  expect(
    athenaRows(
      rows([values]),
      ['decimal(38,18)', 'varchar', 'varchar', 'varbinary', 'timestamp', 'boolean'].map((type) => ({
        name: 'same',
        type,
      })),
    ),
  ).toEqual([[...values.slice(0, 5), false]])
  expect(athenaTableDraft('cat', 'd"b', 't')).toBe('SELECT * FROM "cat"."d""b"."t" LIMIT 200;')
})

it('rechecks enforced cutoff and output scope before every dispatch', async () => {
  let drift = false
  const { service, calls } = fixture((action) => {
      if (action !== 'GetWorkGroup') return
      const result = group()
      if (drift)
        result.WorkGroup.Configuration.ResultConfiguration = {
          ...storage,
          ExpectedBucketOwner: '999999999999',
        }
      return result
    }),
    p = profile()
  await service.connect(p, { password: 'injected' })
  drift = true
  await expect(service.execute(query(p))).rejects.toThrow('storage differs')
  expect(calls.some((call) => call.action === 'StartQueryExecution')).toBe(false)
})

it('refuses unreviewed or readonly writes and does not load a custom endpoint', async () => {
  const { service, calls } = fixture(),
    p = profile()
  await service.connect(p, { password: 'injected' })
  await expect(service.execute(query(p, { confirm: undefined }))).rejects.toThrow('exact profile name')
  await expect(service.execute(query(p, { sql: 'DELETE FROM fixture.t' }))).rejects.toThrow('read-only')
  expect(calls.some((call) => call.action === 'StartQueryExecution')).toBe(false)
  expect(requiredSqlConfirmation('SELECT 1', 'athena', p)).toBe(p.name)
  expect((await service.connect({ ...p, host: 'attacker.invalid' }, { password: 'injected' })).state).toBe(
    'failed',
  )
})

it('never resubmits a write after loss of acknowledgement', async () => {
  const { service, calls } = fixture((action) => {
    if (action === 'StartQueryExecution') throw new Error('Synthetic lost acknowledgement')
    return undefined
    }),
    p = profile({ readOnly: false })
  await service.connect(p, { password: 'injected' })
  await expect(service.execute(query(p, { sql: 'INSERT INTO fixture.t VALUES(1)' }))).rejects.toThrow(
    /not acknowledged.*unconfirmed.*no retry/,
  )
  expect(calls.filter((call) => call.action === 'StartQueryExecution')).toHaveLength(1)
  expect(calls.some((call) => call.action === 'StopQueryExecution')).toBe(false)
})

it('refuses result output drift and repeated result cursors', async () => {
  let mode = 0
  const { service } = fixture((action, input) => {
      if (action === 'GetQueryExecution' && mode === 0) {
        const result = execution()
        result.QueryExecution.ResultConfiguration.OutputLocation = 's3://other-bucket/secret'
        return result
      }
      if (action === 'GetQueryResults') return page(input.NextToken ? [['2']] : [['value'], ['1']], 'same')
    }),
    p = profile()
  await service.connect(p, { password: 'injected' })
  await expect(service.execute(query(p))).rejects.toThrow('storage scope')
  mode++
  await service.connect(p, { password: 'injected' })
  await expect(service.execute(query(p))).rejects.toThrow('repeated a result cursor')
})

it('cancels only the matching active job and reports the native cancellation separately', async () => {
  let observed!: () => void
  const started = new Promise<void>((resolve) => {
    observed = resolve
  })
  const { service, calls } = fixture((action, _input, signal) => {
      if (action === 'GetQueryExecution')
        return new Promise((_resolve, reject) => {
          observed()
          signal?.addEventListener('abort', () => reject(new Error('Synthetic cancelled')), { once: true })
        })
    }),
    p = profile()
  await service.connect(p, { password: 'injected' })
  const running = service.execute(query(p))
  const rejected = expect(running).rejects.toThrow(/cancellation acknowledged/)
  await started
  expect(
    (await service.cancel({ connectionId: p.id, sessionId: 'other', requestId: 'request' })).requested,
  ).toBe(false)
  expect(
    (await service.cancel({ connectionId: p.id, sessionId: 'tab', requestId: 'request' })).requested,
  ).toBe(true)
  await rejected
  expect(calls.filter((call) => call.action === 'StopQueryExecution').map((call) => call.input)).toEqual([
    { QueryExecutionId: 'query1' },
  ])
})
