import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { ImportService } from '../src/main/persistence/transfer-imports'
import { profileSchema } from '../src/shared/contracts'
import { importOptionsSchema } from '../src/shared/imports'

it.skipIf(process.env.HARBOR_IMPORT_BENCHMARK !== '1')(
  'imports a real >384 MiB PostgreSQL dataset with bounded memory',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-import-memory-'))
    const source = join(directory, 'large.csv'),
      table = `import_memory_${crypto.randomUUID().replaceAll('-', '')}`
    const sql = new SqlService(),
      imports = new ImportService(sql)
    const profile = profileSchema.parse({
      id: 'import-memory',
      name: 'Disposable import memory fixture',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      database: 'harbor',
      username: 'harbor',
      readOnly: false,
    })
    const query = (text: string) =>
      sql.execute({
        connectionId: profile.id,
        sessionId: 'verify',
        requestId: crypto.randomUUID(),
        sql: text,
        maxRows: 1,
        privateSession: true,
        confirm: profile.name,
      })
    let created = false
    try {
      expect((await sql.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
      await query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY,label TEXT)`)
      created = true
      const file = await open(source, 'wx')
      try {
        await file.writeFile('id,label\n')
        const text = 'x'.repeat(16384)
        for (let start = 1; start <= 25000; start += 50)
          await file.writeFile(
            Array.from({ length: 50 }, (_item, offset) => `${start + offset},${text}\n`).join(''),
          )
      } finally {
        await file.close()
      }
      const bytes = (await stat(source)).size
      expect(bytes).toBeGreaterThan(384 * 1024 * 1024)
      const preview = await imports.previewImport(importOptionsSchema.parse({ format: 'csv' }), source)
      const baseline = process.memoryUsage()
      let maxHeap = baseline.heapUsed,
        maxRss = baseline.rss
      const sample = () => {
        const memory = process.memoryUsage()
        maxHeap = Math.max(maxHeap, memory.heapUsed)
        maxRss = Math.max(maxRss, memory.rss)
      }
      const timer = setInterval(sample, 5)
      try {
        const job = await imports.startImport({
          connectionId: profile.id,
          database: 'harbor',
          schema: 'public',
          table,
          sourceId: preview.sourceId,
          mapping: [
            { source: 0, target: 'id', type: 'integer' },
            { source: 1, target: 'label', type: 'text' },
          ],
          batchSize: 100,
          errorPolicy: 'stop',
          consentBatchCommits: true,
        })
        while (imports.getJob(job.id).state === 'running')
          await new Promise((resolve) => setTimeout(resolve, 5))
        sample()
        const done = imports.getJob(job.id)
        expect(done.state, done.error).toBe('completed')
        expect(done.committedRows).toBe(25000)
        expect(done.committedBatches).toBe(250)
        expect((await query(`SELECT count(*) FROM ${table}`)).sets[0].rows[0]).toEqual(['25000'])
        const metrics = {
          bytes,
          rows: done.committedRows,
          durationMs: done.durationMs,
          heapDelta: maxHeap - baseline.heapUsed,
          rssDelta: maxRss - baseline.rss,
        }
        console.info('IMPORT_MEMORY_EVIDENCE', JSON.stringify(metrics))
        expect(metrics.heapDelta).toBeLessThan(128 * 1024 * 1024)
        expect(metrics.rssDelta).toBeLessThan(192 * 1024 * 1024)
      } finally {
        clearInterval(timer)
      }
    } finally {
      await imports.closeAll()
      if (created) await query(`DROP TABLE ${table}`)
      await sql.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120000,
)
