import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'
import { openLocalImport } from '../src/main/persistence/local-import-writer'
import { ImportService } from '../src/main/persistence/transfer-imports'
import { ImportBatchError } from '../src/main/persistence/import-writer'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { importOptionsSchema, importTargetConfirmation } from '../src/shared/imports'

describe.each(['sqlite', 'duckdb'] as const)('native %s streaming import adapter', (engine) => {
  let directory = '',
    profile: ConnectionProfile,
    service: SqliteService | DuckDBService,
    imports: ImportService
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-local-import-'))
    const metadata = join(directory, 'harbor-private.sqlite')
    await writeFile(metadata, 'private metadata boundary')
    service = engine === 'sqlite' ? new SqliteService(metadata) : new DuckDBService(metadata)
    profile = profileSchema.parse({
      id: engine + '-import',
      name: 'Disposable local import',
      engine,
      host: 'local',
      port: 1,
      readOnly: false,
      sqlite: { path: join(directory, 'fixture.sqlite'), mode: 'create' },
      duckdb: { path: join(directory, 'fixture.duckdb'), mode: 'create' },
    })
    const status = await service.connect(profile)
    expect(status.state, status.error).toBe('connected')
    imports = new ImportService({
      openImport: (target, signal) => openLocalImport(service, profile, target, signal),
    })
    await query(
      `CREATE TABLE sample (id BIGINT PRIMARY KEY,label TEXT,amount ${engine === 'sqlite' ? 'TEXT' : 'DECIMAL(38,18)'},bytes BLOB)`,
    )
  })
  afterAll(async () => {
    await imports?.closeAll()
    await service?.closeAll()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  async function query(sql: string) {
    return service.execute({
      connectionId: profile.id,
      sessionId: 'verify',
      requestId: crypto.randomUUID(),
      sql,
      maxRows: 1000,
      privateSession: true,
    })
  }
  function target() {
    return {
      connectionId: profile.id,
      database: 'main',
      schema: 'main',
      table: 'sample',
      columns: ['id', 'label'],
    }
  }

  it('streams more than 200 rows from a native-selected source with independent batch commits', async () => {
    const path = join(directory, 'many.csv')
    await writeFile(
      path,
      'id,label\n' + Array.from({ length: 505 }, (_value, index) => `${index + 1},row${index}`).join('\n'),
    )
    const preview = await imports.previewImport(importOptionsSchema.parse({ format: 'csv' }), path)
    const job = await imports.startImport({
      connectionId: profile.id,
      database: 'main',
      schema: 'main',
      table: 'sample',
      sourceId: preview.sourceId,
      mapping: [
        { source: 0, target: 'id', type: 'integer' },
        { source: 1, target: 'label', type: 'text' },
      ],
      batchSize: 100,
      errorPolicy: 'stop',
      consentBatchCommits: true,
    })
    await expect.poll(() => imports.getJob(job.id).state).not.toBe('running')
    const done = imports.getJob(job.id)
    expect(done.state, done.error).toBe('completed')
    expect(done.committedRows).toBe(505)
    expect(done.committedBatches).toBe(6)
    expect((await query('SELECT count(*) FROM sample')).sets[0].rows[0]).toEqual(['505'])
  })

  it('preserves exact integers, decimals/text, binary and NULL using native binds', async () => {
    const writer = await openLocalImport(
      service,
      profile,
      { ...target(), columns: ['id', 'label', 'amount', 'bytes'] },
      new AbortController().signal,
    )
    try {
      await writer.writeBatch([
        [
          '9007199254740993',
          null,
          '12345678901234567890.123456789012345678',
          { type: 'binary', base64: 'AP+A' },
        ],
      ])
    } finally {
      await writer.close()
    }
    expect(
      (await query('SELECT id,label,amount,bytes FROM sample WHERE id=9007199254740993')).sets[0].rows[0],
    ).toEqual([
      '9007199254740993',
      null,
      '12345678901234567890.123456789012345678',
      { type: 'binary', base64: 'AP+A' },
    ])
  })

  it('rolls back the entire current batch on constraint failure without touching earlier committed rows', async () => {
    const writer = await openLocalImport(service, profile, target(), new AbortController().signal)
    try {
      await writer.writeBatch([
        ['2001', 'first'],
        ['2002', 'second'],
      ])
      await expect(
        writer.writeBatch([
          ['2003', 'private-cell'],
          ['2001', 'duplicate'],
        ]),
      ).rejects.toMatchObject({ outcome: 'rolled-back', rows: 2 })
      expect(
        (await query('SELECT id FROM sample WHERE id BETWEEN 2001 AND 2003 ORDER BY id')).sets[0].rows.map(
          (row) => row[0],
        ),
      ).toEqual(['2001', '2002'])
    } finally {
      await writer.close()
    }
  })

  it('cancels between bounded native operations and confirms rollback without interrupting COMMIT', async () => {
    const controller = new AbortController()
    const execute = service.execute.bind(service)
    // Cancel after the first actual native INSERT, before the next bounded
    // operation. A wall-clock timer can miss an entire batch on fast hosts.
    const observed = vi.spyOn(service, 'execute').mockImplementation(async (input) => {
      const result = await execute(input)
      if (input.sql.startsWith('INSERT INTO') && input.parameters?.[0].value === '3100') controller.abort()
      return result
    })
    const writer = await openLocalImport(service, profile, target(), controller.signal)
    try {
      await writer.writeBatch([['3001', 'committed']])
      const pending = writer.writeBatch(
        Array.from({ length: 100 }, (_value, index) => [String(3100 + index), 'cancelled']),
      )
      try {
        await pending
        throw new Error('Cancellation unexpectedly missed the running batch.')
      } catch (error) {
        expect(error).toBeInstanceOf(ImportBatchError)
        expect((error as ImportBatchError).outcome).toBe('rolled-back')
      }
      expect(
        (await query('SELECT id FROM sample WHERE id BETWEEN 3001 AND 3199 ORDER BY id')).sets[0].rows.map(
          (row) => row[0],
        ),
      ).toEqual(['3001'])
    } finally {
      observed.mockRestore()
      await writer.close()
    }
  })

  it('rejects read-only profiles, views, and unreviewed production targets', async () => {
    await expect(
      openLocalImport(service, { ...profile, readOnly: true }, target(), new AbortController().signal),
    ).rejects.toThrow('read-only')
    await query('CREATE VIEW sample_view AS SELECT * FROM sample')
    await expect(
      openLocalImport(service, profile, { ...target(), table: 'sample_view' }, new AbortController().signal),
    ).rejects.toThrow('base table')
    await expect(
      openLocalImport(
        service,
        { ...profile, environment: 'production' },
        target(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('exact production')
    const confirmed = { ...target(), confirm: importTargetConfirmation(target()) }
    const writer = await openLocalImport(
      service,
      { ...profile, environment: 'production' },
      confirmed,
      new AbortController().signal,
    )
    await writer.close()
  })

  it('rejects known silent numeric narrowing before any batch write', async () => {
    await query('CREATE TABLE narrow (id INTEGER,amount DECIMAL(5,2))')
    const writer = await openLocalImport(
      service,
      profile,
      { ...target(), table: 'narrow', columns: ['id', 'amount'] },
      new AbortController().signal,
    )
    try {
      await expect(writer.writeBatch([['1', '0.123456789012345678901']])).rejects.toThrow(
        engine === 'sqlite' ? 'numeric affinity' : 'precision/scale',
      )
      expect((await query('SELECT count(*) FROM narrow')).sets[0].rows[0]).toEqual(['0'])
    } finally {
      await writer.close()
    }
  })
})
