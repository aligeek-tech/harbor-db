import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { profileSchema } from '../src/shared/contracts'
import { seriesQuerySchema } from '../src/shared/time-series'
import { TimeSeriesService } from '../src/main/engines/time-series'
const fixture = process.env.HARBOR_TIME_SERIES_FIXTURE
const service = new TimeSeriesService()
let secret: { influxToken: string; influxOrgId: string; questPassword: string }
const profile = (id = 'influx-native') =>
  profileSchema.parse({
    id,
    name: id,
    engine: 'influxdb',
    host: '127.0.0.1',
    port: 18086,
    timeSeries: { orgId: secret.influxOrgId },
    readOnly: true,
    queryTimeout: 5000,
  })
const input = (changes = {}) =>
  seriesQuerySchema.parse({
    connectionId: 'influx-native',
    sessionId: 'test',
    requestId: crypto.randomUUID(),
    source: 'metrics',
    measurement: 'harbor_exact',
    field: 'signed',
    start: '2026-01-01T00:00:00Z',
    stop: '2026-01-02T00:00:00Z',
    ...changes,
  })
describe.skipIf(!fixture)('InfluxDB 2 native disposable fixture', () => {
  beforeAll(async () => {
    secret = JSON.parse(await readFile(fixture!, 'utf8'))
    if (!secret.influxOrgId) throw new Error('Prepared disposable Influx organization is required.')
    const response = await fetch(
      `http://127.0.0.1:18086/api/v2/write?org=${secret.influxOrgId}&bucket=metrics&precision=ns`,
      {
        method: 'POST',
        headers: { Authorization: 'Token ' + secret.influxToken, 'Content-Type': 'text/plain' },
        body: 'harbor_exact,host=a signed=9223372036854775807i,unsigned=18446744073709551615u,label="",value=1.25 1767225600123456789\nharbor_exact,host=b signed=-9223372036854775808i,unsigned=0u,label="hello,world",value=2.5 1767225600123456790\nharbor_exact,host=a signed=1i,unsigned=1u,value=3.75 1767225601123456789',
      },
    )
    expect(response.status).toBe(204)
    expect(await service.connect(profile(), { password: secret.influxToken })).toMatchObject({
      state: 'connected',
    })
  }, 20000)
  afterAll(() => service.closeAll())
  it('authenticates, verifies server generation and organization and browses buckets', async () => {
    expect(service.status('influx-native').version).toMatch(/InfluxDB v?2\.9\.1/)
    expect(await service.catalog({ connectionId: 'influx-native' })).toContainEqual(
      expect.objectContaining({ name: 'metrics' }),
    )
    expect(
      await service.connect(profile('bad-token'), { password: 'synthetic-invalid-token' }),
    ).toMatchObject({ state: 'authentication-failed' })
    expect(
      await service.connect(
        { ...profile('bad-org'), timeSeries: { generation: '2-flux', orgId: '0000000000000000' } },
        { password: secret.influxToken },
      ),
    ).toMatchObject({ state: 'failed' })
  })
  it('inspects real measurements and field names within the selected range', async () => {
    const meta = await service.inspect({
      connectionId: 'influx-native',
      sessionId: 'test',
      requestId: crypto.randomUUID(),
      source: 'metrics',
      measurement: '',
      start: input().start,
      stop: input().stop,
    })
    expect(meta.measurements).toContain('harbor_exact')
    const fields = await service.inspect({
      connectionId: 'influx-native',
      sessionId: 'test',
      requestId: crypto.randomUUID(),
      source: 'metrics',
      measurement: 'harbor_exact',
      start: input().start,
      stop: input().stop,
    })
    expect(fields.fields.map((f) => f.name)).toContain('unsigned')
  })
  it('preserves signed/unsigned 64-bit values and nanosecond UTC timestamps', async () => {
    let result = await service.query(input())
    let rows = result.sets.flatMap((s) =>
      s.rows.map((row) => Object.fromEntries(s.columns.map((c, i) => [c.name, row[i]]))),
    )
    expect(rows.map((r) => r._value)).toContain('9223372036854775807')
    expect(rows.map((r) => r._value)).toContain('-9223372036854775808')
    expect(rows.map((r) => r._time)).toContain('2026-01-01T00:00:00.123456789Z')
    result = await service.query(input({ field: 'unsigned' }))
    rows = result.sets.flatMap((s) =>
      s.rows.map((row) => Object.fromEntries(s.columns.map((c, i) => [c.name, row[i]]))),
    )
    expect(rows.map((r) => r._value)).toContain('18446744073709551615')
  })
  it('filters native tags, bounds a preview and retains an empty field string', async () => {
    const filtered = await service.query(input({ tags: [{ key: 'host', value: 'a' }], limit: 1 }))
    expect(filtered.rows).toBe(1)
    expect(filtered.truncated).toBe(true)
    const empty = await service.query(input({ field: 'label', tags: [{ key: 'host', value: 'a' }] }))
    const set = empty.sets[0]
    expect(set.rows[0][set.columns.findIndex((c) => c.name === '_value')]).toBe('')
  })
  it('accepts a limited read token and preserves native denial of a write-only token', async () => {
    const catalog = await service.catalog({ connectionId: 'influx-native' }),
      bucket = catalog.find((b) => b.name === 'metrics')!
    const issue = async (action: 'read' | 'write') => {
      const response = await fetch('http://127.0.0.1:18086/api/v2/authorizations', {
        method: 'POST',
        headers: { Authorization: 'Token ' + secret.influxToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgID: secret.influxOrgId,
          permissions: [{ action, resource: { type: 'buckets', id: bucket.id, orgID: secret.influxOrgId } }],
        }),
      })
      expect(response.status).toBe(201)
      return (await response.json()) as { token: string }
    }
    const read = await issue('read')
    expect(await service.connect(profile('limited-reader'), { password: read.token })).toMatchObject({
      state: 'connected',
    })
    expect((await service.query(input({ connectionId: 'limited-reader' }))).rows).toBe(3)
    const write = await issue('write')
    const state = await service.connect(profile('write-only'), { password: write.token })
    if (state.state === 'connected')
      await expect(service.query(input({ connectionId: 'write-only' }))).rejects.toThrow()
    else expect(['failed', 'authentication-failed']).toContain(state.state)
  })
  it('runs native window aggregation and refuses arbitrary Flux before dispatch', async () => {
    const result = await service.query(
      input({ field: 'value', aggregate: 'mean', interval: '1s', tags: [{ key: 'host', value: 'a' }] }),
    )
    expect(result.rows).toBe(2)
    await expect(service.query(input({ mode: 'sql', sql: 'import "http"' }))).rejects.toThrow(
      'generated Flux',
    )
    await expect(
      service.query(input({ tags: [{ key: 'host', value: '${http.post(url:"remote")}' }] })),
    ).rejects.toThrow('interpolation')
  })
})
