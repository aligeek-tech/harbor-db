import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlService } from '../src/main/engines/sql'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'
import { openLocalImport } from '../src/main/persistence/local-import-writer'
import { profileSchema } from '../src/shared/contracts'
import type { ImportWriter } from '../src/main/persistence/import-writer'

for (const engine of ['postgres', 'mariadb', 'sqlite', 'duckdb'] as const)
  it.skipIf(['postgres', 'mariadb'].includes(engine) && process.env.HARBOR_INTEGRATION !== '1')(
    `${engine} pins column metadata for every committed import batch and rejects later schema narrowing`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-import-schema-')),
        table = `import_schema_${crypto.randomUUID().replaceAll('-', '')}`
      const profile = profileSchema.parse({
        id: 'schema-drift',
        name: 'Disposable schema drift',
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : 13306,
        username: 'harbor',
        database: ['postgres', 'mariadb'].includes(engine) ? 'harbor' : '',
        schema: engine === 'postgres' ? 'public' : engine === 'mariadb' ? 'harbor' : 'main',
        readOnly: false,
        sqlite: { path: join(directory, 'fixture.sqlite'), mode: 'create' },
        duckdb: { path: join(directory, 'fixture.duckdb'), mode: 'create' },
      })
      const service =
        engine === 'sqlite'
          ? new SqliteService(join(directory, 'private.sqlite'))
          : engine === 'duckdb'
            ? new DuckDBService(join(directory, 'private.sqlite'))
            : new SqlService()
      const query = (sql: string) =>
        service.execute({
          connectionId: profile.id,
          sessionId: 'setup',
          requestId: crypto.randomUUID(),
          sql,
          maxRows: 10,
          privateSession: true,
          confirm: profile.name,
        })
      let created = false,
        writer: ImportWriter | undefined
      try {
        expect((await service.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
        await query(
          `CREATE TABLE ${table} (id INTEGER PRIMARY KEY,amount ${engine === 'sqlite' ? 'TEXT' : 'DECIMAL(10,4)'})`,
        )
        created = true
        const target = {
          connectionId: profile.id,
          database: profile.database || 'main',
          schema: profile.schema,
          table,
          columns: ['id', 'amount'],
        }
        writer =
          service instanceof SqlService
            ? await service.openImport(target, new AbortController().signal)
            : await openLocalImport(service, profile, target, new AbortController().signal)
        await writer.writeBatch([['1', '1.0000']])
        await query(
          engine === 'sqlite'
            ? `ALTER TABLE ${table} RENAME COLUMN amount TO old_amount; ALTER TABLE ${table} ADD COLUMN amount INTEGER`
            : engine === 'mariadb'
              ? `ALTER TABLE ${table} MODIFY amount DECIMAL(5,2)`
              : `ALTER TABLE ${table} ALTER COLUMN amount TYPE DECIMAL(5,2)`,
        )
        await expect(
          writer.writeBatch([['2', engine === 'sqlite' ? '9223372036854775808' : '1.2345']]),
        ).rejects.toMatchObject({ outcome: 'rolled-back', rows: 1 })
        expect(
          (await query(`SELECT id FROM ${table} ORDER BY id`)).sets[0].rows.map((row) => String(row[0])),
        ).toEqual(['1'])
      } finally {
        await writer?.close()
        try {
          if (created) await query(`DROP TABLE ${table}`)
        } finally {
          await service.closeAll()
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
  )
