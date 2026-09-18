import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/main/engines/clickhouse'
import { TransferService } from '../src/main/persistence/transfers'
import { profileSchema } from '../src/shared/contracts'

// Writes about 400 MiB per engine into a disposable directory. Explicit opt-in only.
describe.skipIf(process.env.HARBOR_CLICKHOUSE_BENCHMARK !== '1')('real streaming memory budget', () => {
  for (const engine of ['clickhouse'] as const)
    it(`${engine}: exports 100,000 rows larger than the client memory budget`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-stream-benchmark-'))
      const sql = new ClickhouseService()
      const transfers = new TransferService(sql)
      const profile = profileSchema.parse({
        id: `stream-benchmark-${engine}`,
        name: 'Disposable export benchmark',
        engine,
        host: '127.0.0.1',
        port: 18123,
        username: 'harbor',
        database: 'harbor',
        readOnly: true,
        queryTimeout: 120000,
      })
      let sampler: ReturnType<typeof setInterval> | undefined
      try {
        const status = await sql.connect(profile, { password: 'harbor_test' })
        expect(status.state, status.error).toBe('connected')
        const baseline = process.memoryUsage()
        let peakRss = baseline.rss
        let peakHeap = baseline.heapUsed
        sampler = setInterval(() => {
          const current = process.memoryUsage()
          peakRss = Math.max(peakRss, current.rss)
          peakHeap = Math.max(peakHeap, current.heapUsed)
        }, 10)
        const text = "SELECT number,repeat('x',4096) AS payload FROM numbers(100000)"
        const path = join(directory, 'full.jsonl')
        let job = await transfers.startExport(
          { connectionId: profile.id, sql: text, format: 'jsonl', spreadsheetSafe: true, consentRerun: true },
          path,
        )
        const deadline = performance.now() + 125000
        while (job.state === 'running' && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          job = transfers.getJob(job.id)
        }
        expect(job.state, job.error).toBe('completed')
        expect(job.rows).toBe(100000)
        expect(job.bytes).toBe((await stat(path)).size)
        expect(job.bytes).toBeGreaterThan(384 * 1024 * 1024)
        // Delta excludes the test runner and loaded application dependencies.
        expect(peakHeap - baseline.heapUsed).toBeLessThan(64 * 1024 * 1024)
        expect(peakRss - baseline.rss).toBeLessThan(128 * 1024 * 1024)
        console.info(
          JSON.stringify({
            engine,
            rows: job.rows,
            bytes: job.bytes,
            durationMs: job.durationMs,
            peakHeapDelta: peakHeap - baseline.heapUsed,
            peakRssDelta: peakRss - baseline.rss,
          }),
        )
      } finally {
        if (sampler) clearInterval(sampler)
        await transfers.closeAll()
        await sql.closeAll()
        await rm(directory, { recursive: true, force: true })
      }
    }, 135000)
})
