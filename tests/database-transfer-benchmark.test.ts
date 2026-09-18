import { expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { DatabaseTransferService } from '../src/main/persistence/database-transfer'
import { profileSchema } from '../src/shared/contracts'

it.skipIf(process.env.HARBOR_TRANSFER_BENCHMARK !== '1')(
  'transfers more than 384 MiB through actual PostgreSQL streams with bounded memory and batch backpressure',
  async () => {
    const sql = new SqlService(),
      table = `transfer_memory_${crypto.randomUUID().replaceAll('-', '')}`
    const source = profileSchema.parse({
      id: 'transfer-memory-source',
      name: 'Disposable transfer source',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'harbor',
      database: 'harbor',
      readOnly: true,
    })
    const destination = {
      ...source,
      id: 'transfer-memory-destination',
      name: 'Disposable transfer destination',
      readOnly: false,
    }
    const profiles = new Map([
      [source.id, source],
      [destination.id, destination],
    ])
    let payloadBytes = 0,
      activeRows = 0,
      maxActiveRows = 0,
      maxBufferedRows = 0
    const transfers = new DatabaseTransferService({
      profile: (id) => profiles.get(id)!,
      structure: (target) => sql.structure(target),
      openImport: (target, signal) => sql.openImport(target, signal),
      streamQuery: (input, sink) =>
        sql.streamQuery(input, {
          ...sink,
          onRow: async (row) => {
            activeRows++
            maxActiveRows = Math.max(maxActiveRows, activeRows)
            payloadBytes += Buffer.byteLength(JSON.stringify(row))
            try {
              await sink.onRow(row)
            } finally {
              activeRows--
            }
          },
        }),
    })
    const query = (statement: string) =>
      sql.execute({
        connectionId: destination.id,
        sessionId: 'fixture',
        requestId: crypto.randomUUID(),
        sql: statement,
        maxRows: 1,
        privateSession: true,
        confirm: destination.name,
      })
    let created = false
    try {
      for (const profile of profiles.values())
        expect((await sql.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
      await query(`CREATE TABLE ${table} (id BIGINT PRIMARY KEY,payload TEXT)`)
      created = true
      const preview = await transfers.preview({
        source: {
          connectionId: source.id,
          database: 'harbor',
          sql: "SELECT n::bigint AS id,repeat('x',16384) AS payload FROM generate_series(1,25000) n",
        },
        target: { connectionId: destination.id, database: 'harbor', schema: 'public', table },
      })
      payloadBytes = 0
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
        const job = await transfers.start({
          token: preview.token,
          confirm: preview.confirmation,
          consentBatchCommits: true,
          consentRerun: true,
          maxRows: 25000,
          batchSize: 100,
          mapping: [
            { source: 0, target: 'id', type: 'integer' },
            { source: 1, target: 'payload', type: 'text' },
          ],
        })
        while (transfers.get(job.id).state === 'running') {
          maxBufferedRows = Math.max(maxBufferedRows, transfers.get(job.id).bufferedRows)
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        sample()
        const result = transfers.get(job.id)
        expect(result).toMatchObject({
          state: 'completed',
          committedRows: 25000,
          committedBatches: 250,
          uncertainRows: 0,
          rolledBackRows: 0,
          unwrittenRows: 0,
          bufferedRows: 0,
        })
        expect((await query(`SELECT count(*),sum(length(payload)) FROM ${table}`)).sets[0].rows[0]).toEqual([
          '25000',
          '409600000',
        ])
        const metrics = {
          payloadBytes,
          rows: result.committedRows,
          durationMs: result.durationMs,
          heapDelta: maxHeap - baseline.heapUsed,
          rssDelta: maxRss - baseline.rss,
          maxBufferedRows,
          maxActiveRows,
        }
        console.info('TRANSFER_MEMORY_EVIDENCE', JSON.stringify(metrics))
        expect(payloadBytes).toBeGreaterThan(384 * 1024 * 1024)
        expect(metrics.heapDelta).toBeLessThan(128 * 1024 * 1024)
        expect(metrics.rssDelta).toBeLessThan(192 * 1024 * 1024)
        expect(maxBufferedRows).toBeLessThanOrEqual(100)
        expect(maxActiveRows).toBe(1)
      } finally {
        clearInterval(timer)
      }
    } finally {
      await transfers.closeAll()
      try {
        if (created) await query(`DROP TABLE ${table}`)
      } finally {
        await sql.closeAll()
      }
    }
  },
  120000,
)
