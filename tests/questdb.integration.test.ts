import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { profileSchema } from '../src/shared/contracts'
import { seriesQuerySchema, seriesConfirmation } from '../src/shared/time-series'
import { TimeSeriesService } from '../src/main/engines/time-series'
const fixture = process.env.HARBOR_QUESTDB_FIXTURE
const service = new TimeSeriesService()
let password: string
const profile = (id = 'quest-native', readOnly = true) =>
  profileSchema.parse({
    id,
    name: id,
    engine: 'questdb',
    host: '127.0.0.1',
    port: 19000,
    username: 'harbor',
    readOnly,
    queryTimeout: 5000,
  })
const input = (changes = {}) =>
  seriesQuerySchema.parse({
    connectionId: 'quest-native',
    sessionId: 'test',
    requestId: crypto.randomUUID(),
    source: 'harbor_series',
    start: '2026-01-01T00:00:00Z',
    stop: '2026-01-02T00:00:00Z',
    ...changes,
  })
async function native(sql: string) {
  const response = await fetch(
    'http://127.0.0.1:19000/exec?' + new URLSearchParams({ query: sql, quoteLargeNum: 'true' }),
    { headers: { Authorization: 'Basic ' + Buffer.from('harbor:' + password).toString('base64') } },
  )
  const text = await response.text()
  if (!response.ok) throw new Error('Disposable fixture setup failed: ' + text)
  return JSON.parse(text)
}
describe.skipIf(!fixture)('QuestDB10.0 native disposable fixture', () => {
  beforeAll(async () => {
    password = JSON.parse(await readFile(fixture!, 'utf8')).questPassword
    await native(
      'CREATE TABLE IF NOT EXISTS harbor_series (ts TIMESTAMP_NS, host SYMBOL, exact LONG, amount DECIMAL(38,18), label VARCHAR) TIMESTAMP(ts) PARTITION BY DAY BYPASS WAL',
    )
    await native('TRUNCATE TABLE harbor_series')
    await native(
      "INSERT INTO harbor_series VALUES (CAST('2026-01-01T00:00:00.123456789Z' AS TIMESTAMP_NS),'a',9223372036854775807,CAST('12345678901234567890.123456789012345678' AS DECIMAL(38,18)),'hello'),(CAST('2026-01-01T00:00:01.123456790Z' AS TIMESTAMP_NS),'a',1,CAST('1.25' AS DECIMAL(38,18)),''),(CAST('2026-01-01T00:00:02.123456791Z' AS TIMESTAMP_NS),'b',2,NULL,NULL)",
    )
    expect(await service.connect(profile(), { password })).toMatchObject({ state: 'connected' })
    expect(await service.connect(profile('quest-write', false), { password })).toMatchObject({
      state: 'connected',
    })
  }, 20000)
  afterAll(() => service.closeAll())
  it('verifies engine identity, authentication, designated timestamp and native catalog', async () => {
    expect(service.status('quest-native').version).toContain('QuestDB 10.0.1')
    expect(await service.catalog({ connectionId: 'quest-native' })).toContainEqual(
      expect.objectContaining({ name: 'harbor_series', timestamp: 'ts', partition: 'DAY' }),
    )
    const metadata = await service.inspect({
      connectionId: 'quest-native',
      sessionId: 'test',
      requestId: crypto.randomUUID(),
      source: 'harbor_series',
      measurement: '',
      start: input().start,
      stop: input().stop,
    })
    expect(metadata.fields).toContainEqual({ name: 'ts', type: 'TIMESTAMP_NS', designated: true })
    expect(
      await service.connect(profile('bad-password'), { password: 'invalid-synthetic-password' }),
    ).toMatchObject({ state: 'authentication-failed' })
  })
  it('retains LONG, DECIMAL and TIMESTAMP_NS representations and NULL/empty distinction', async () => {
    const result = await service.query(input())
    expect(result.rows).toBe(3)
    expect(result.sets[0].rows[0]).toEqual([
      '2026-01-01T00:00:00.123456789Z',
      'a',
      '9223372036854775807',
      '12345678901234567890.123456789012345678',
      'hello',
    ])
    expect(result.sets[0].rows[1][4]).toBe('')
    expect(result.sets[0].rows[2][4]).toBe(null)
  })
  it('applies exact time/tag predicates and server preview bounds', async () => {
    const result = await service.query(input({ limit: 1, tags: [{ key: 'host', value: 'a' }] }))
    expect(result.rows).toBe(1)
    expect(result.truncated).toBe(true)
    const nano = await service.query(
      input({
        start: '2026-01-01T00:00:00.123456789Z',
        stop: '2026-01-01T00:00:00.123456790Z',
        field: 'exact',
      }),
    )
    expect(nano.rows).toBe(1)
    expect(nano.sets[0].rows[0]).toEqual(['9223372036854775807'])
  })
  it('rejects raw SQL for read-only profiles and requires exact target confirmation', async () => {
    await expect(
      service.query(
        input({
          mode: 'sql',
          sql: 'TRUNCATE TABLE harbor_series',
          confirm: seriesConfirmation('quest-native'),
        }),
      ),
    ).rejects.toThrow('Read-only')
    await expect(
      service.query(
        input({
          connectionId: 'quest-write',
          mode: 'sql',
          sql: 'TRUNCATE TABLE harbor_series',
          confirm: 'EXECUTE QUESTDB other',
        }),
      ),
    ).rejects.toThrow('confirm')
    expect((await native('SELECT count() FROM harbor_series')).dataset[0][0]).toBe('3')
  })
  it('executes native reviewed time-series SQL and an acknowledged write once', async () => {
    const sql = 'SELECT host, count() n FROM harbor_series GROUP BY host'
    const result = await service.query(
      input({ connectionId: 'quest-write', mode: 'sql', sql, confirm: seriesConfirmation('quest-write') }),
    )
    expect(result.rows).toBe(2)
    await service.query(
      input({
        connectionId: 'quest-write',
        mode: 'sql',
        sql: "INSERT INTO harbor_series VALUES (CAST('2026-01-01T01:00:00Z' AS TIMESTAMP_NS),'write',3,NULL,'reviewed')",
        confirm: seriesConfirmation('quest-write'),
      }),
    )
    expect((await native("SELECT count() FROM harbor_series WHERE host='write'")).dataset[0][0]).toBe('1')
  })
  it('closes a real long query only for the matching tab/request and reports unconfirmed server cancellation', async () => {
    const query = input({
      connectionId: 'quest-write',
      mode: 'sql',
      sql: 'SELECT sum(sin(x)) FROM long_sequence(1000000000)',
      confirm: seriesConfirmation('quest-write'),
    })
    const pending = service.query(query),
      rejected = expect(pending).rejects.toThrow(/unconfirmed|cancelled|interrupted/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.cancel({ ...query, requestId: crypto.randomUUID() }).requested).toBe(false)
    expect(service.cancel(query).requested).toBe(true)
    await rejected
    expect((await native('SELECT 1')).dataset[0][0]).toBe(1)
  })
  it('does not replay a write whose real server acknowledgement is lost', async () => {
    let writes = 0
    const proxy = http.createServer((req, res) => {
      const query = new URL(req.url!, 'http://127.0.0.1').searchParams.get('query') || ''
      const drop = query.startsWith('INSERT INTO harbor_series')
      if (drop) writes++
      const forward = http.request(
        { host: '127.0.0.1', port: 19000, path: req.url, method: 'GET', headers: req.headers },
        (reply) => {
          if (drop) {
            reply.resume()
            reply.on('end', () => res.destroy())
          } else {
            res.writeHead(reply.statusCode || 502, reply.headers)
            reply.pipe(res)
          }
        },
      )
      forward.on('error', () => res.destroy())
      forward.end()
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const port = (proxy.address() as { port: number }).port
    try {
      expect(await service.connect({ ...profile('quest-loss', false), port }, { password })).toMatchObject({
        state: 'connected',
      })
      await expect(
        service.query(
          input({
            connectionId: 'quest-loss',
            mode: 'sql',
            confirm: seriesConfirmation('quest-loss'),
            sql: "INSERT INTO harbor_series VALUES (CAST('2026-01-01T02:00:00Z' AS TIMESTAMP_NS),'lost',4,NULL,'one')",
          }),
        ),
      ).rejects.toThrow('unconfirmed')
      expect(writes).toBe(1)
      expect((await native("SELECT count() FROM harbor_series WHERE host='lost'")).dataset[0][0]).toBe('1')
    } finally {
      await service.disconnect('quest-loss')
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })
})
