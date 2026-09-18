import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { TransferService } from '../src/main/persistence/transfers'
import { profileSchema } from '../src/shared/contracts'

// Writes about 400 MiB per engine into a disposable directory. Explicit opt-in only.
describe.skipIf(process.env.HARBOR_STREAM_BENCHMARK !== '1')('real streaming memory budget', () => {
  for (const engine of ['postgres', 'mariadb', 'mysql'] as const)
    it(`${engine}: exports 100,000 rows larger than the client memory budget`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-stream-benchmark-'))
      const sql = new SqlService()
      const transfers = new TransferService(sql)
      const profile = profileSchema.parse({
        id: `stream-benchmark-${engine}`,
        name: 'Disposable export benchmark',
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307,
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
        const text =
          engine === 'postgres'
            ? "SELECT i,repeat('x',4096) AS payload FROM generate_series(1,100000) i"
            : engine === 'mariadb'
              ? "SELECT seq AS i,REPEAT('x',4096) AS payload FROM seq_1_to_100000"
              : "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100) SELECT a.n+100*(b.n-1)+10000*(c.n-1) AS i,REPEAT('x',4096) AS payload FROM seq a CROSS JOIN seq b CROSS JOIN seq c WHERE c.n<=10"
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
