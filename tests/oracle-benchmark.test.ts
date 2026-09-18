import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OracleService } from '../src/main/engines/oracle'
import { TransferService } from '../src/main/persistence/transfers'
import { profileSchema } from '../src/shared/contracts'

// Opt-in: writes about 400 MiB into a unique temporary directory, then removes it.
describe.skipIf(process.env.HARBOR_ORACLE_BENCHMARK !== '1')(
  'real Oracle native streaming memory budget',
  () => {
    it('streams a dataset larger than the client memory budget to one complete export', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-oracle-benchmark-')),
        service = new OracleService(),
        transfers = new TransferService(service)
      const path = process.env.HARBOR_ORACLE_FIXTURE_ENV
      if (!path) throw new Error('Disposable Oracle credential file required.')
      const password = /^ORACLE_TEST_PASSWORD=(.+)$/m.exec(await readFile(path, 'utf8'))?.[1] ?? ''
      const profile = profileSchema.parse({
        id: 'oracle-benchmark',
        name: 'Oracle benchmark fixture',
        engine: 'oracle',
        host: '127.0.0.1',
        port: 25421,
        username: 'HARBOR_VERIFY',
        database: 'FREEPDB1',
        schema: 'HARBOR_VERIFY',
        readOnly: true,
        queryTimeout: 120000,
      })
      let sampler: ReturnType<typeof setInterval> | undefined
      try {
        const status = await service.connect(profile, { password })
        expect(status.state, status.error).toBe('connected')
        const baseline = process.memoryUsage()
        let peakHeap = baseline.heapUsed,
          peakRss = baseline.rss
        sampler = setInterval(() => {
          const current = process.memoryUsage()
          peakHeap = Math.max(peakHeap, current.heapUsed)
          peakRss = Math.max(peakRss, current.rss)
        }, 10)
        const output = join(directory, 'full.jsonl')
        let job = await transfers.startExport(
            {
              connectionId: profile.id,
              sql: "SELECT LEVEL AS N,RPAD('x',4000,'x') AS PAYLOAD FROM DUAL CONNECT BY LEVEL<=105000",
              format: 'jsonl',
              spreadsheetSafe: true,
              consentRerun: true,
            },
            output,
          )
        const deadline = performance.now() + 125000
        while (job.state === 'running' && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          job = transfers.getJob(job.id)
        }
        expect(job.state, job.error).toBe('completed')
        expect(job.rows).toBe(105000)
        expect(job.bytes).toBe((await stat(output)).size)
        expect(job.bytes).toBeGreaterThan(384 * 1024 * 1024)
        expect(peakHeap - baseline.heapUsed).toBeLessThan(64 * 1024 * 1024)
        expect(peakRss - baseline.rss).toBeLessThan(128 * 1024 * 1024)
        console.info(
          JSON.stringify({
            engine: 'oracle',
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
        await service.closeAll()
        await rm(directory, { recursive: true, force: true })
      }
    }, 135000)
  },
)
