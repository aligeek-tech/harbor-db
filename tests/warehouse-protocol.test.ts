import { afterEach, expect, it } from 'vitest'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { WarehouseService, warehouseRows } from '../src/main/engines/warehouses'
import { type JsonRecord } from '../src/main/engines/cloud-json'
import { warehouseTableDraft } from '../src/shared/warehouses'
import { requiredSqlConfirmation } from '../src/shared/sql'

const services: WarehouseService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.closeAll()
})
const profile = (engine: 'snowflake' | 'databricks', patch: Partial<ConnectionProfile> = {}) =>
  profileSchema.parse({
    id: engine,
    name: engine + ' fixture',
    engine,
    host: engine === 'snowflake' ? 'synthetic.snowflakecomputing.com' : 'synthetic.cloud.databricks.com',
    port: 443,
    database: 'catalog',
    schema: 'synthetic',
    tls: { enabled: true },
    warehouse: { warehouse: 'warehouse1' },
    ...patch,
  })
const snowPage = (value: string, type = 'text') => ({
  statementHandle: 'stmt1',
  code: '090001',
  resultSetMetaData: {
    rowType: [{ name: 'value', type, precision: '38', scale: '18' }],
    partitionInfo: [{}],
  },
  data: [[value]],
})
const dbPage = (value: string) => ({
  statement_id: 'stmt1',
  status: { state: 'SUCCEEDED' },
  manifest: { schema: { columns: [{ name: 'value', type_text: 'DECIMAL(38,18)' }] }, truncated: false },
  result: { data_array: [[value]] },
})
function fixture(
  engine: 'snowflake' | 'databricks',
  handler: (method: string, path: string, body: JsonRecord) => JsonRecord | Promise<JsonRecord>,
) {
  const calls: { method: string; path: string; body: JsonRecord }[] = []
  const service = new WarehouseService(engine, () => ({
    close: () => {},
    request: async (method, path, body) => {
      const input = (body || {}) as JsonRecord
      calls.push({ method, path, body: input })
      if (path.includes('/warehouses/')) return { id: 'warehouse1', state: 'RUNNING' }
      if (input.statement === 'SELECT CURRENT_VERSION()') return snowPage('10.1.2')
      return handler(method, path, input)
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
  sql: 'SELECT amount FROM synthetic.t',
  maxRows: 100,
  privateSession: true,
  confirm: p.name,
  ...patch,
})

it('preserves ordered duplicate types, decimal, null, empty, native timestamp and binary values', () => {
  expect(
    warehouseRows(
      'snowflake',
      [
        [
          '12345678901234567890.123456789012345678',
          '00ff',
          null,
          '',
          '2026-09-18 00:00:00.123456789 +03:30',
          'false',
        ],
      ],
      [
        { name: 'a', type: 'fixed(38,18)' },
        { name: 'a', type: 'binary' },
        { name: 'n', type: 'text' },
        { name: 's', type: 'text' },
        { name: 't', type: 'timestamp_tz' },
        { name: 'b', type: 'boolean' },
      ],
    ),
  ).toEqual([
    [
      '12345678901234567890.123456789012345678',
      { type: 'binary', base64: 'AP8=' },
      null,
      '',
      '2026-09-18 00:00:00.123456789 +03:30',
      false,
    ],
  ])
  expect(warehouseRows('databricks', [['AP8=']], [{ name: 'bytes', type: 'BINARY' }])).toEqual([['AP8=']])
})

it('polls Snowflake native identity and follows only locally constructed result partitions', async () => {
  let polls = 0
  const { service, calls } = fixture('snowflake', (method, path) => {
      if (method === 'POST') return { statementHandle: 'stmt1', code: '333334' }
      if (path.endsWith('partition=1')) return { data: [['9223372036854775807']] }
      polls++
      return {
        ...snowPage('9007199254740993', 'fixed'),
        resultSetMetaData: {
          rowType: [{ name: 'value', type: 'fixed', precision: '38', scale: '0' }],
          partitionInfo: [{}, {}],
        },
        statementStatusUrl: 'https://attacker.invalid/private',
      }
    }),
    p = profile('snowflake')
  expect((await service.connect(p, { password: 'synthetic' })).state).toBe('connected')
  const result = await service.execute(query(p))
  expect(result.sets[0].rows).toEqual([['9007199254740993'], ['9223372036854775807']])
  expect(polls).toBe(1)
  expect(calls.every((call) => !call.path.includes('attacker'))).toBe(true)
  expect(calls.find((call) => call.body.statement === query(p).sql)?.body).toMatchObject({
    warehouse: 'warehouse1',
    database: 'catalog',
    schema: 'synthetic',
    parameters: {
      MULTI_STATEMENT_COUNT: '1',
      CLIENT_RESULT_CHUNK_SIZE: 16,
      TIMESTAMP_TZ_OUTPUT_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM',
    },
  })
})

it('uses Databricks INLINE chunk indexes, never external URLs or provision/start endpoints', async () => {
  const { service, calls } = fixture('databricks', (_method, path) =>
      path.includes('/result/chunks/1')
        ? { data_array: [['2.000000000000000001']] }
        : {
            ...dbPage('1.000000000000000001'),
            result: {
              data_array: [['1.000000000000000001']],
              next_chunk_index: 1,
              next_chunk_internal_link: 'https://attacker.invalid/secret',
            },
          },
    ),
    p = profile('databricks')
  await service.connect(p, { password: 'synthetic' })
  expect((await service.execute(query(p))).sets[0].rows).toEqual([
    ['1.000000000000000001'],
    ['2.000000000000000001'],
  ])
  expect(calls.find((call) => call.body.statement)?.body).toMatchObject({
    warehouse_id: 'warehouse1',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
    byte_limit: 16777216,
    wait_timeout: '0s',
  })
  expect(calls.some((call) => /attacker|\/start|\/create/.test(call.path))).toBe(false)
})

it('requires cost review, does not interpolate parameters, and rejects readonly writes before submission', async () => {
  const { service, calls } = fixture('snowflake', () => snowPage('ok')),
    p = profile('snowflake')
  await service.connect(p, { password: 'synthetic' })
  await expect(service.execute(query(p, { confirm: undefined }))).rejects.toThrow(/compute charges/)
  await expect(
    service.execute(
      query(p, { parameters: [{ name: 'secret', value: 'private', type: 'text', secret: true }] }),
    ),
  ).rejects.toThrow(/not interpolated/)
  await expect(service.execute(query(p, { sql: 'DELETE FROM synthetic.t' }))).rejects.toThrow(/read-only/)
  expect(calls).toHaveLength(1)
  expect(requiredSqlConfirmation('SELECT 1', 'snowflake', p)).toBe(p.name)
  expect(requiredSqlConfirmation('SELECT 1', 'databricks', p)).toBe(p.name)
})

it('does not replay a lost write submission and identifies unconfirmed cancellation without a native handle', async () => {
  const { service, calls } = fixture('databricks', () => {
      throw new Error('Synthetic lost submission acknowledgement')
    }),
    p = profile('databricks', { readOnly: false })
  await service.connect(p, { password: 'synthetic' })
  await expect(service.execute(query(p, { sql: 'INSERT INTO synthetic.t VALUES(1)' }))).rejects.toThrow(
    /not acknowledged.*unconfirmed.*No retry/,
  )
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  expect(service.getSessionState({ connectionId: p.id, sessionId: 'tab' }).running).toBe(false)
})

it('fails closed on truncated INLINE results, external storage transfer and nonofficial endpoints', async () => {
  let mode = 0
  const { service } = fixture('databricks', () =>
      mode === 0
        ? { ...dbPage('x'), manifest: { schema: { columns: [] }, truncated: true } }
        : { ...dbPage('x'), result: { external_links: [{ external_link: 'https://storage.invalid' }] } },
    ),
    p = profile('databricks')
  await service.connect(p, { password: 'synthetic' })
  await expect(service.execute(query(p))).rejects.toThrow(/INLINE result exceeded/)
  mode++
  await service.connect(p, { password: 'synthetic' })
  await expect(service.execute(query(p))).rejects.toThrow(/External result links/)
  expect(
    (await service.connect({ ...p, host: 'databricks.attacker.invalid' }, { password: 'synthetic' })).state,
  ).toBe('failed')
})

it('generates inert quoted warehouse drafts without changing the target identifier', () => {
  expect(warehouseTableDraft('snowflake', 'db', 'schema', 't"name')).toBe(
    'SELECT * FROM "db"."schema"."t""name" LIMIT 200;',
  )
  expect(warehouseTableDraft('databricks', 'cat', 'schema', 't`name')).toBe(
    'SELECT * FROM `cat`.`schema`.`t``name` LIMIT 200;',
  )
  expect(() => warehouseTableDraft('bigquery', 'project', 'schema', 'bad\nname')).toThrow()
})

it('accepts successful Databricks commands without a result manifest without inventing affected rows', async () => {
  const { service, calls } = fixture('databricks', () => ({
      statement_id: 'stmt1',
      status: { state: 'SUCCEEDED' },
    })),
    p = profile('databricks', { readOnly: false })
  await service.connect(p, { password: 'synthetic' })
  const result = await service.execute(query(p, { sql: 'CREATE TABLE synthetic.t (id BIGINT)' }))
  expect(result.sets[0]).toMatchObject({ columns: [], rows: [], affectedRows: 0, truncated: false })
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
})
