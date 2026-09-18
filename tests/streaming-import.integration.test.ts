import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { ImportService } from '../src/main/persistence/transfer-imports'
import {
  importOptionsSchema,
  importTargetConfirmation,
  type ImportJobSnapshot,
  type StartImportInput,
} from '../src/shared/imports'
import { profileSchema } from '../src/shared/contracts'

const engines = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
]
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(
  imports: ImportService,
  id: string,
  condition: (snapshot: ImportJobSnapshot) => boolean = (snapshot) => snapshot.state !== 'running',
) {
  const deadline = performance.now() + 30000
  while (performance.now() < deadline) {
    const snapshot = imports.getJob(id)
    if (condition(snapshot)) return snapshot
    await delay(5)
  }
  throw new Error('Import test timed out waiting for native progress.')
}
describe.skipIf(!engines.length)('real streaming SQL imports', () => {
  for (const engine of engines)
    describe(engine, () => {
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
      const table = `import_${suffix}`,
        slow = `import_slow_${suffix}`,
        triggerFn = `import_fn_${suffix}`
      const schema = engine === 'postgres' ? 'public' : 'harbor'
      const sql = new SqlService(),
        imports = new ImportService(sql)
      let directory = ''
      const profile = profileSchema.parse({
        id: `import-${engine}`,
        name: 'Disposable import fixture',
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307,
        username: 'harbor',
        database: 'harbor',
        readOnly: false,
      })
      const target = { connectionId: profile.id, database: 'harbor', schema, table }
      async function query(text: string, connectionId = profile.id) {
        return sql.execute({
          connectionId,
          sessionId: 'verify',
          requestId: crypto.randomUUID(),
          sql: text,
          maxRows: 2000,
          privateSession: true,
          confirm: 'Disposable import fixture',
        })
      }
      async function preview(text: string | Buffer, format: 'csv' | 'jsonl' = 'csv') {
        const path = join(directory, crypto.randomUUID() + '.' + format)
        await writeFile(path, text)
        return { path, preview: await imports.previewImport(importOptionsSchema.parse({ format }), path) }
      }
      function input(sourceId: string, overrides: Partial<StartImportInput> = {}): StartImportInput {
        return {
          ...target,
          sourceId,
          mapping: [
            { source: 0, target: 'id', type: 'integer' },
            { source: 1, target: 'label', type: 'text' },
          ],
          batchSize: 100,
          errorPolicy: 'stop',
          consentBatchCommits: true,
          ...overrides,
        }
      }
      beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'harbor-import-real-'))
        if (engine === 'mysql' && process.env.HARBOR_MYSQL_TLS_CA)
          profile.tls = {
            ...profile.tls,
            enabled: true,
            rejectUnauthorized: true,
            ca: await readFile(process.env.HARBOR_MYSQL_TLS_CA, 'utf8'),
          }
        expect((await sql.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
        await query(
          `CREATE TABLE ${table} (id BIGINT PRIMARY KEY,label TEXT,amount DECIMAL(38,18),payload ${engine === 'postgres' ? 'JSONB' : 'JSON'},bytes ${engine === 'postgres' ? 'BYTEA' : 'BLOB'})`,
        )
        await query(`CREATE TABLE ${slow} (id INTEGER PRIMARY KEY,label VARCHAR(100))`)
        let owner = profile.id
        if (engine !== 'postgres') {
          owner = profile.id + '-owner'
          expect(
            (await sql.connect({ ...profile, id: owner, username: 'root' }, { password: 'harbor_root' }))
              .state,
          ).toBe('connected')
        }
        if (engine === 'postgres') {
          await query(
            `CREATE FUNCTION ${triggerFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`,
          )
          await query(
            `CREATE TRIGGER ${triggerFn} BEFORE INSERT ON ${slow} FOR EACH ROW EXECUTE FUNCTION ${triggerFn}()`,
          )
        } else
          await query(
            `CREATE TRIGGER ${triggerFn} BEFORE INSERT ON ${slow} FOR EACH ROW SET NEW.label=CONCAT(NEW.label,SLEEP(0.2))`,
            owner,
          )
      })
      afterAll(async () => {
        await imports.closeAll()
        await query(`DROP TABLE IF EXISTS ${slow}`)
        await query(`DROP TABLE IF EXISTS ${table}`)
        if (engine === 'postgres') await query(`DROP FUNCTION IF EXISTS ${triggerFn}()`)
        await sql.closeAll()
        if (directory) await rm(directory, { recursive: true, force: true })
      })

      it('streams beyond the old 200-row import cap with bounded batches and exact NULL/text values', async () => {
        const { preview: source } = await preview(
          'id,label\n' +
            Array.from(
              { length: 1005 },
              (_item, index) =>
                `${index + 1},${index === 0 ? '\\N' : index === 1 ? '"\\N"' : '"hello,سلام"'}`,
            ).join('\n'),
        )
        expect(source.rows).toHaveLength(20)
        const job = await imports.startImport(input(source.sourceId))
        const done = await until(imports, job.id)
        expect(done.state, done.error).toBe('completed')
        expect(done.committedRows).toBe(1005)
        expect(done.committedBatches).toBe(11)
        expect(done.uncertainRows).toBe(0)
        expect(done.bytesRead).toBe(done.fileBytes)
        const rows = (await query(`SELECT id,label FROM ${table} WHERE id<=2 ORDER BY id`)).sets[0].rows
        expect(rows.map((row) => row[1])).toEqual([null, '\\N'])
        await expect(imports.startImport(input(source.sourceId))).rejects.toThrow('already used')
      })

      it('binds lossless JSONL numbers and nested JSON without rounding', async () => {
        const { preview: source } = await preview(
          '{"id":9007199254740993,"label":"exact","amount":12345678901234567890.123456789012345678,"payload":{"n":900719925474099312345,"decimal":0.123456789012345678901}}\n',
          'jsonl',
        )
        const job = await imports.startImport(
          input(source.sourceId, {
            mapping: [
              { source: 0, target: 'id', type: 'integer' },
              { source: 1, target: 'label', type: 'text' },
              { source: 2, target: 'amount', type: 'decimal' },
              { source: 3, target: 'payload', type: 'json' },
            ],
          }),
        )
        const done = await until(imports, job.id)
        if (engine === 'mysql') {
          expect(done.state).toBe('failed')
          expect(done.error).toContain('MySQL JSON would round')
          expect(done.committedRows).toBe(0)
          return
        }
        expect(done.state, done.error).toBe('completed')
        const row = (await query(`SELECT id,amount,payload FROM ${table} WHERE id=9007199254740993`)).sets[0]
          .rows[0]
        expect(row[0]).toBe('9007199254740993')
        expect(row[1]).toBe('12345678901234567890.123456789012345678')
        expect(String(row[2])).toContain('900719925474099312345')
        expect(String(row[2])).toContain('0.123456789012345678901')
      })

      it('reports committed batches and an acknowledged failed-batch rollback without retry or leaked values', async () => {
        const { preview: source } = await preview(
          'id,label\n2001,first\n2002,second\n2003,private-import-cell\n2001,duplicate\n2004,later\n',
        )
        const done = await until(
          imports,
          (await imports.startImport(input(source.sourceId, { batchSize: 2 }))).id,
        )
        expect(done.state).toBe('failed')
        expect(done.committedRows).toBe(2)
        expect(done.rolledBackRows).toBe(2)
        expect(done.uncertainRows).toBe(0)
        expect(done.error).not.toContain('private-import-cell')
        expect(done.error).not.toContain('2001')
        expect(
          (
            await query(`SELECT id FROM ${table} WHERE id BETWEEN 2001 AND 2004 ORDER BY id`)
          ).sets[0].rows.map((row) => String(row[0])),
        ).toEqual(['2001', '2002'])
      })

      it('skips only explicit source validation errors and keeps line-number evidence', async () => {
        const { preview: source } = await preview('id,label\n3001,good\nnot-a-number,invalid\n3002,good\n')
        const done = await until(
          imports,
          (await imports.startImport(input(source.sourceId, { errorPolicy: 'skip-invalid' }))).id,
        )
        expect(done.state, done.error).toBe('completed')
        expect(done.committedRows).toBe(2)
        expect(done.skippedRows).toBe(1)
        expect(done.issues[0].line).toBe(3)
        expect(JSON.stringify(done)).not.toContain('not-a-number')
      })

      it('cancels an active native batch, acknowledges rollback, and retains previous commits', async () => {
        const { preview: source } = await preview('id,label\n1,first\n2,second\n3,third\n4,fourth\n5,fifth\n')
        const job = await imports.startImport(input(source.sourceId, { table: slow, batchSize: 2 }))
        await until(imports, job.id, (snapshot) => snapshot.committedRows === 2 && snapshot.rowsRead >= 4)
        await delay(50) // Ensure the second batch is inside its native trigger, rather than still validating the file.
        imports.cancelJob(job.id)
        const done = await until(imports, job.id)
        expect(done.state, done.error).toBe('cancelled')
        expect(done.committedRows).toBe(2)
        expect(done.rolledBackRows).toBe(2)
        expect(done.uncertainRows).toBe(0)
        expect(
          (await query(`SELECT id FROM ${slow} ORDER BY id`)).sets[0].rows.map((row) => String(row[0])),
        ).toEqual(['1', '2'])
      })

      it('rejects changed source files and enforces read-only/production target boundaries', async () => {
        const source = await preview('id,label\n4001,original\n')
        await writeFile(source.path, 'id,label\n4001,modified\n')
        await expect(imports.startImport(input(source.preview.sourceId))).rejects.toThrow(
          'changed after preview',
        )
        const readOnly = { ...profile, id: profile.id + '-readonly', readOnly: true }
        expect((await sql.connect(readOnly, { password: 'harbor_test' })).state).toBe('connected')
        const fresh = await preview('id,label\n4001,reviewed\n')
        await expect(
          imports.startImport(input(fresh.preview.sourceId, { connectionId: readOnly.id })),
        ).rejects.toThrow('read-only')
        const production = { ...profile, id: profile.id + '-production', environment: 'production' }
        expect((await sql.connect(production, { password: 'harbor_test' })).state).toBe('connected')
        const reviewed = await preview('id,label\n4001,reviewed\n')
        await expect(
          imports.startImport(input(reviewed.preview.sourceId, { connectionId: production.id })),
        ).rejects.toThrow('exact production')
        const confirmed = await preview('id,label\n4001,reviewed\n')
        const destination = input(confirmed.preview.sourceId, { connectionId: production.id })
        destination.confirm = importTargetConfirmation(destination)
        expect((await until(imports, (await imports.startImport(destination)).id)).committedRows).toBe(1)
      })

      it('reports an uncertain batch when the server commits but its acknowledgment is lost, without replay', async () => {
        const sockets = new Set<net.Socket>()
        let cut = false
        const proxy = net.createServer((client) => {
          const upstream = net.connect(profile.port, '127.0.0.1')
          sockets.add(client)
          sockets.add(upstream)
          client.on('error', () => undefined)
          upstream.on('error', () => client.destroy())
          client.on('close', () => {
            sockets.delete(client)
            upstream.destroy()
          })
          upstream.on('close', () => {
            sockets.delete(upstream)
            client.destroy()
          })
          let commitSent = false
          client.on('data', (chunk) => {
            if (chunk.includes(Buffer.from('COMMIT'))) commitSent = true
            upstream.write(chunk)
          })
          upstream.on('data', (chunk) => {
            if (commitSent && !cut) {
              cut = true
              client.destroy()
              upstream.destroy()
            } else client.write(chunk)
          })
        })
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
        const proxied = {
          ...profile,
          id: profile.id + '-ack-loss',
          port: (proxy.address() as net.AddressInfo).port,
          tls: { ...profile.tls, enabled: false },
        }
        try {
          expect((await sql.connect(proxied, { password: 'harbor_test' })).state).toBe('connected')
          const { preview: source } = await preview('id,label\n6001,first\n6002,second\n6003,later\n')
          const done = await until(
            imports,
            (await imports.startImport(input(source.sourceId, { connectionId: proxied.id, batchSize: 2 })))
              .id,
          )
          expect(cut).toBe(true)
          expect(done.state).toBe('failed')
          expect(done.uncertainRows).toBe(2)
          expect(done.committedRows).toBe(0)
          expect(done.rolledBackRows).toBe(0)
          expect(done.error).toContain('no writes were replayed')
          expect(
            (
              await query(`SELECT id FROM ${table} WHERE id BETWEEN 6001 AND 6003 ORDER BY id`)
            ).sets[0].rows.map((row) => String(row[0])),
          ).toEqual(['6001', '6002'])
        } finally {
          await sql.disconnect(proxied.id)
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((resolve) => proxy.close(() => resolve()))
        }
      })
    })
})
