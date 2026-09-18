import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import {
  TransferService,
  type ExportJobSnapshot,
  type FullExportInput,
} from '../src/main/persistence/transfers'
import { profileSchema } from '../src/shared/contracts'

const engines = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
]
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function completed(transfers: TransferService, id: string): Promise<ExportJobSnapshot> {
  const deadline = performance.now() + 30000
  while (performance.now() < deadline) {
    const snapshot = transfers.getJob(id)
    if (snapshot.state !== 'running') return snapshot
    await delay(5)
  }
  throw new Error('Export did not complete within the test deadline.')
}

describe.skipIf(!engines.length)('real database full-result streaming', () => {
  const sql = new SqlService()
  const transfers = new TransferService(sql)
  let directory = ''
  const table = `stream_${crypto.randomUUID().replaceAll('-', '')}`
  const profiles = engines.map((engine) =>
    profileSchema.parse({
      id: `streaming-${engine}`,
      name: 'Disposable streaming fixture',
      engine,
      host: '127.0.0.1',
      port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307,
      username: 'harbor',
      database: 'harbor',
      readOnly: false,
      queryTimeout: 30000,
    }),
  )
  const secrets = { password: 'harbor_test' }
  async function query(id: string, text: string, sessionId = 'setup') {
    return sql.execute({
      connectionId: id,
      sessionId,
      requestId: crypto.randomUUID(),
      sql: text,
      maxRows: 10,
      privateSession: true,
      confirm: 'Disposable streaming fixture',
    })
  }
  function input(connectionId: string, text: string): FullExportInput {
    return { connectionId, sql: text, format: 'jsonl', spreadsheetSafe: true, consentRerun: true }
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-streaming-'))
    for (const profile of profiles) {
      const status = await sql.connect(profile, secrets)
      expect(status.state, status.error).toBe('connected')
      await query(profile.id, `CREATE TABLE ${table} (id INTEGER PRIMARY KEY,label VARCHAR(1000))`)
      const source =
        profile.engine === 'postgres'
          ? "SELECT i,repeat('x',512) FROM generate_series(1,2500) i"
          : profile.engine === 'mariadb'
            ? "SELECT seq,REPEAT('x',512) FROM seq_1_to_2500"
            : "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100) SELECT a.n+100*(b.n-1),REPEAT('x',512) FROM seq a CROSS JOIN seq b WHERE b.n<=25"
      await query(profile.id, `INSERT INTO ${table} ${source}`)
    }
  })
  afterAll(async () => {
    await transfers.closeAll()
    for (const profile of profiles) await query(profile.id, `DROP TABLE IF EXISTS ${table}`)
    await sql.closeAll()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  for (const profile of profiles)
    describe(profile.engine, () => {
      it('exports every row beyond the loaded display cap with ordered JSONL metadata', async () => {
        const text = `SELECT id AS duplicate,label AS duplicate FROM ${table} ORDER BY id`
        const loaded = await query(profile.id, text)
        expect(loaded.sets[0].truncated).toBe(true)
        const path = join(directory, `${profile.engine}-full.jsonl`)
        const job = await transfers.startExport(input(profile.id, text), path)
        const result = await completed(transfers, job.id)
        expect(result.state, result.error).toBe('completed')
        expect(result.rows).toBe(2500)
        expect(result.partialPath).toBeUndefined()
        expect(result.bytes).toBe((await stat(path)).size)
        const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
        expect(lines).toHaveLength(2501)
        expect(JSON.parse(lines[0]).columns.map((column: { name: string }) => column.name)).toEqual([
          'duplicate',
          'duplicate',
        ])
        expect(String(JSON.parse(lines[2500])[0])).toBe('2500')
      })

      it('uses native parameters and retains NULL, binary and exact decimal/integer text', async () => {
        const statement =
          profile.engine === 'postgres'
            ? "SELECT $1::bigint AS n,12345678901234567890.123456789::numeric AS amount,decode('00ff80','hex') AS bytes,NULL AS nullable"
            : "SELECT CAST(? AS SIGNED) AS n,CAST(12345678901234567890.123456789 AS DECIMAL(30,9)) AS amount,UNHEX('00ff80') AS bytes,NULL AS nullable"
        const path = join(directory, `${profile.engine}-typed.jsonl`)
        const job = await transfers.startExport(
          {
            ...input(profile.id, statement),
            parameters: [{ name: 'n', type: 'integer', value: '9007199254740993', secret: false }],
          },
          path,
        )
        const result = await completed(transfers, job.id)
        expect(result.state, result.error).toBe('completed')
        expect(JSON.parse((await readFile(path, 'utf8')).trimEnd().split('\n')[1])).toEqual([
          '9007199254740993',
          '12345678901234567890.123456789',
          { type: 'binary', base64: 'AP+A' },
          null,
        ])
      })

      it('redacts private parameter failures without exposing source SQL or values', async () => {
        const secret = 'private-export-value-not-for-errors'
        const text =
          profile.engine === 'postgres'
            ? 'SELECT no_export_function($1::text)'
            : 'SELECT no_export_function(?)'
        const job = await transfers.startExport(
          {
            ...input(profile.id, text),
            parameters: [{ name: 'private', type: 'text', value: secret, secret: true }],
          },
          join(directory, `${profile.engine}-private-error.jsonl`),
        )
        const result = await completed(transfers, job.id)
        expect(result.state).toBe('failed')
        expect(result.error).toContain('private parameter')
        expect(result.error).not.toContain(secret)
        expect(result.error).not.toContain('no_export_function')
      })

      it('applies sink backpressure instead of issuing concurrent row writes', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let observed = 0
        const stream = sql.streamQuery(input(profile.id, `SELECT * FROM ${table} ORDER BY id`), {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async () => {
            observed++
            if (observed === 1) await gate
          },
        })
        while (!observed) await delay(2)
        await delay(20)
        expect(observed).toBe(1)
        release()
        await stream
        expect(observed).toBe(2500)
      })

      it('uses a fresh snapshot and leaves the active tab transaction intact', async () => {
        await sql.transaction({ connectionId: profile.id, sessionId: 'tx', action: 'begin' })
        try {
          await query(profile.id, `UPDATE ${table} SET label='uncommitted' WHERE id=1`, 'tx')
          const path = join(directory, `${profile.engine}-snapshot.csv`)
          const job = await transfers.startExport(
            { ...input(profile.id, `SELECT label FROM ${table} WHERE id=1`), sessionId: 'tx', format: 'csv' },
            path,
          )
          expect((await completed(transfers, job.id)).state).toBe('completed')
          expect(await readFile(path, 'utf8')).not.toContain('uncommitted')
          expect(sql.getSessionState({ connectionId: profile.id, sessionId: 'tx' }).state).toBe('open')
        } finally {
          await sql.transaction({ connectionId: profile.id, sessionId: 'tx', action: 'rollback' })
        }
      })

      it('rejects mutation reruns and oversized rows without finalizing their partial files', async () => {
        for (const [label, text] of [
          ['write', `DELETE FROM ${table}`],
          ['oversize', "SELECT REPEAT('x',9000000)"],
        ]) {
          const path = join(directory, `${profile.engine}-${label}.jsonl`)
          const job = await transfers.startExport(input(profile.id, text), path)
          const result = await completed(transfers, job.id)
          expect(result.state).toBe('failed')
          expect(result.rows).toBe(0)
          expect(result.error).toMatch(/read-only|8 MiB/)
          await expect(stat(path)).rejects.toThrow()
          expect(result.partialPath).toBeDefined()
        }
        expect(String((await query(profile.id, `SELECT COUNT(*) FROM ${table}`)).sets[0].rows[0][0])).toBe(
          '2500',
        )
      })

      it('leaves accurate partial output on cancellation and never creates a final filename', async () => {
        let id = ''
        const cancelling = new TransferService({
          streamQuery: (source, sink) =>
            sql.streamQuery(source, {
              ...sink,
              onRow: async (row) => {
                await sink.onRow(row)
                if (cancelling.getJob(id).rows === 3) cancelling.cancelJob(id)
              },
            }),
        })
        try {
          const path = join(directory, `${profile.engine}-cancel.jsonl`)
          const job = await cancelling.startExport(input(profile.id, `SELECT * FROM ${table}`), path)
          id = job.id
          const result = await completed(cancelling, id)
          expect(result.state, result.error).toBe('cancelled')
          expect(result.rows).toBe(3)
          await expect(stat(path)).rejects.toThrow()
          expect(result.bytes).toBe((await stat(result.partialPath!)).size)
        } finally {
          await cancelling.closeAll()
        }
      })

      it('cancels a query that is still waiting for its first result row', async () => {
        const path = join(directory, `${profile.engine}-cancel-waiting.jsonl`)
        const text = profile.engine === 'postgres' ? 'SELECT pg_sleep(10)' : 'SELECT SLEEP(10)'
        const job = await transfers.startExport(input(profile.id, text), path)
        await delay(100)
        const started = performance.now()
        transfers.cancelJob(job.id)
        const result = await completed(transfers, job.id)
        expect(result.state, result.error).toBe('cancelled')
        expect(result.rows).toBe(0)
        expect(performance.now() - started).toBeLessThan(2000)
        await expect(stat(path)).rejects.toThrow()
      })

      it('leaves partial output after a real session disconnect and never replays the query', async () => {
        const own = { ...profile, id: profile.id + '-lost' }
        expect((await sql.connect(own, secrets)).state).toBe('connected')
        let rows = 0
        const disconnected = new TransferService({
          streamQuery: (source, sink) =>
            sql.streamQuery(source, {
              ...sink,
              onRow: async (row) => {
                await sink.onRow(row)
                if (++rows === 3) await sql.disconnect(own.id)
              },
            }),
        })
        try {
          const path = join(directory, `${profile.engine}-lost.jsonl`)
          const job = await disconnected.startExport(input(own.id, `SELECT * FROM ${table}`), path)
          const result = await completed(disconnected, job.id)
          expect(result.state).toBe('failed')
          expect(result.rows).toBe(3)
          expect(result.error).toMatch(/ended|lost|closed/i)
          await expect(stat(path)).rejects.toThrow()
          expect(sql.status(own.id).state).toBe('disconnected')
        } finally {
          await disconnected.closeAll()
          await sql.disconnect(own.id)
        }
      })

      it('does not replace a destination that appears during streaming', async () => {
        const path = join(directory, `${profile.engine}-race.csv`)
        const raced = new TransferService({
          streamQuery: (source, sink) =>
            sql.streamQuery(source, {
              ...sink,
              onColumns: async (columns) => {
                await sink.onColumns(columns)
                await writeFile(path, 'pre-existing user data', { flag: 'wx' })
              },
            }),
        })
        try {
          const job = await raced.startExport({ ...input(profile.id, 'SELECT 1'), format: 'csv' }, path)
          const result = await completed(raced, job.id)
          expect(result.state).toBe('failed')
          expect(result.error).toContain('EEXIST')
          expect(await readFile(path, 'utf8')).toBe('pre-existing user data')
        } finally {
          await raced.closeAll()
        }
      })
    })
})
