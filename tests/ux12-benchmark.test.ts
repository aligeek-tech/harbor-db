import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RedisService } from '../src/main/engines/redis'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'

const enabled = process.env.HARBOR_UX12_BENCHMARK === '1'
// Reference-machine budgets: Apple M4 / 10 logical CPUs / 24 GiB / macOS arm64.
// Keep this test opt-in when running on a materially different machine or loaded CI host.
const budgets = {
  sqlElapsedMs: 5000,
  redisElapsedMs: 2000,
  maxEventLoopDelayMs: 100,
  cancellationLatencyMs: 1000,
  peakHeapDeltaBytes: 128 * 1024 * 1024,
  peakRssDeltaBytes: 256 * 1024 * 1024,
}

test.skipIf(!enabled)(
  'bounds concurrent million-row SQL drains and million-key-equivalent lazy Redis probes',
  async () => {
    const sql = new SqlService()
    const redis = new RedisService()
    const profiles = (['postgres', 'mariadb'] as const).map((engine) =>
      profileSchema.parse({
        id: `ux12-${engine}`,
        name: `UX12 ${engine}`,
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : 13306,
        username: 'harbor',
        database: 'harbor',
        schema: engine === 'postgres' ? 'public' : 'harbor',
        readOnly: true,
        queryTimeout: 120000,
      }),
    )
    const redisProfile = profileSchema.parse({
      id: 'ux12-redis',
      name: 'UX12 Redis',
      engine: 'redis',
      host: '127.0.0.1',
      port: 16379,
      readOnly: true,
    })
    const baseline = process.memoryUsage()
    let peakHeap = baseline.heapUsed
    let peakRss = baseline.rss
    let eventLoopTicks = 0
    let maxEventLoopDelayMs = 0
    let expectedTick = performance.now() + 10
    const sampler = setInterval(() => {
      const memory = process.memoryUsage()
      peakHeap = Math.max(peakHeap, memory.heapUsed)
      peakRss = Math.max(peakRss, memory.rss)
      const now = performance.now()
      maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - expectedTick)
      expectedTick = now + 10
      eventLoopTicks++
    }, 10)
    try {
      for (const profile of profiles)
        expect((await sql.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
      expect((await redis.connect(redisProfile, { password: 'harbor_test' })).state).toBe('connected')

      const sqlStarted = performance.now()
      const sqlResults = await Promise.all(
        profiles.flatMap((profile) =>
          [0, 500000].map((offset, tab) =>
            sql.execute({
              connectionId: profile.id,
              sessionId: `ux12-tab-${tab}`,
              requestId: randomUUID(),
              privateSession: true,
              sql: millionRowHalf(profile, offset),
              maxRows: 200,
            }),
          ),
        ),
      )
      const sqlElapsedMs = performance.now() - sqlStarted
      const sqlIpcBytes = sqlResults.map((result) => Buffer.byteLength(JSON.stringify(result)))
      for (const result of sqlResults) {
        expect(result.sets[0].rows).toHaveLength(200)
        expect(result.sets[0].truncated).toBe(true)
        expect(result.messages.join(' ')).toContain('remaining result rows were drained without retention')
      }
      expect(Math.max(...sqlIpcBytes)).toBeLessThan(8 * 1024 * 1024)

      const redisStarted = performance.now()
      const redisPages: Awaited<ReturnType<RedisService['scan']>>[] = []
      for (let wave = 0; wave < 5; wave++)
        redisPages.push(
          ...(await Promise.all(
            Array.from({ length: 2 }, () =>
              redis.scan({
                connectionId: redisProfile.id,
                cursor: '0',
                pattern: 'harbor:benchmark:*',
                count: 200,
              }),
            ),
          )),
        )
      const redisElapsedMs = performance.now() - redisStarted
      expect(redisPages.every((page) => page.keys.length > 0 && page.keys.length <= 1000)).toBe(true)
      const redisIpcBytes = redisPages.map((page) => Buffer.byteLength(JSON.stringify(page)))
      expect(Math.max(...redisIpcBytes)).toBeLessThan(4 * 1024 * 1024)

      const cancelRequest = randomUUID()
      const cancellationStarted = performance.now()
      const running = sql.execute({
        connectionId: profiles[0].id,
        sessionId: 'ux12-cancel',
        requestId: cancelRequest,
        privateSession: true,
        sql: 'SELECT pg_sleep(10)',
        maxRows: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(
        await sql.cancel({
          connectionId: profiles[0].id,
          sessionId: 'ux12-cancel',
          requestId: cancelRequest,
        }),
      ).toMatchObject({ requested: true })
      await expect(running).resolves.toMatchObject({ cancelled: true, transaction: 'idle' })
      const cancellationLatencyMs = performance.now() - cancellationStarted - 150
      expect(eventLoopTicks).toBeGreaterThan(0)
      expect(sqlElapsedMs).toBeLessThan(budgets.sqlElapsedMs)
      expect(redisElapsedMs).toBeLessThan(budgets.redisElapsedMs)
      expect(maxEventLoopDelayMs).toBeLessThan(budgets.maxEventLoopDelayMs)
      expect(cancellationLatencyMs).toBeLessThan(budgets.cancellationLatencyMs)
      expect(peakHeap - baseline.heapUsed).toBeLessThan(budgets.peakHeapDeltaBytes)
      expect(peakRss - baseline.rss).toBeLessThan(budgets.peakRssDeltaBytes)

      const evidence = {
        machine: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        sql: {
          engines: profiles.map((profile) => profile.engine),
          concurrentTabsPerEngine: 2,
          generatedRowsPerTab: 500000,
          generatedRowsPerEngine: 1000000,
          payloadBytesPerRow: 128,
          retainedRowsPerTab: 200,
          elapsedMs: Number(sqlElapsedMs.toFixed(2)),
          ipcBytesPerTab: sqlIpcBytes,
        },
        redis: {
          fixtureUniqueKeys: 100000,
          totalLazyProbes: 10,
          maxConcurrentLazyProbes: 2,
          aggregateFixtureKeyEquivalent: 1000000,
          uniqueKeysClaimed: 100000,
          scope:
            'Five waves of two concurrent bounded opening-page probes; not a one-million-unique-key fixture or full enumeration. A prior ten-way attempt hit the finite Redis client command queue.',
          elapsedMs: Number(redisElapsedMs.toFixed(2)),
          returnedKeysPerProbe: redisPages.map((page) => page.keys.length),
          ipcBytesPerProbe: redisIpcBytes,
        },
        responsiveness: {
          eventLoopTicks,
          maxObservedEventLoopDelayMs: Number(maxEventLoopDelayMs.toFixed(2)),
          cancellationLatencyMs: Number(cancellationLatencyMs.toFixed(2)),
        },
        memory: {
          baselineHeapBytes: baseline.heapUsed,
          peakHeapBytes: peakHeap,
          peakHeapDeltaBytes: peakHeap - baseline.heapUsed,
          baselineRssBytes: baseline.rss,
          peakRssBytes: peakRss,
          peakRssDeltaBytes: peakRss - baseline.rss,
        },
        budgets,
      }
      await writeFile(join(tmpdir(), 'harbor-ux12-benchmark.json'), JSON.stringify(evidence, null, 2))
      console.info(JSON.stringify(evidence))
    } finally {
      clearInterval(sampler)
      await sql.closeAll()
      await redis.closeAll()
    }
  },
  180000,
)

function millionRowHalf(profile: ConnectionProfile, offset: number): string {
  if (profile.engine === 'postgres')
    return `SELECT ${offset} + i AS id, repeat('x',128) AS payload, 9007199254740993::numeric AS exact FROM generate_series(1,500000) i`
  return `SELECT ${offset} + seq AS id, REPEAT('x',128) AS payload, CAST(9007199254740993 AS DECIMAL(30,0)) AS exact FROM seq_1_to_500000`
}
