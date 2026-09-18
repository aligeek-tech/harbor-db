import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdapterRegistry, type RelationalAdapter } from '../src/main/engines/adapter'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'
import { profileSchema } from '../src/shared/contracts'
import { exportConsistency } from '../src/shared/transfers'

describe('first-party adapter boundary', () => {
  it('rejects missing and duplicate registrations, mismatched model, and unimplemented declared capabilities', () => {
    const registry = new AdapterRegistry()
    const sqlite = new SqliteService('/unopened-harbor-metadata')
    expect(() => registry.connection('elasticsearch')).toThrow(/not available/)
    expect(() => registry.register('sqlite', sqlite)).toThrow(/SQL capability/)
    expect(() => registry.register('redis', sqlite, sqlite)).toThrow(/SQL capability/)
    expect(() => registry.register('sqlite', sqlite, { ...sqlite } as RelationalAdapter)).toThrow(
      /without an implementation/,
    )
    registry.register('sqlite', sqlite, sqlite)
    expect(registry.relational('sqlite')).toBe(sqlite)
    expect(() => registry.register('sqlite', sqlite, sqlite)).toThrow(/already registered/)
    expect(() => registry.requireCapability('sqlite', 'documents')).toThrow(/does not support/)
    expect(() => registry.relational('mssql')).toThrow(/not available/)
  })
  it('uses engine-specific snapshot promises, never a transactional claim for ClickHouse', () => {
    expect(exportConsistency('mssql')).toContain('ALLOW_SNAPSHOT_ISOLATION')
    expect(exportConsistency('clickhouse')).toContain('no multi-table transactional snapshot')
    expect(exportConsistency('mysql')).toContain('nontransactional tables')
    expect(() => exportConsistency('redis')).toThrow(/does not support/)
  })
})

// These are real engine contracts, not mock-driver compatibility evidence.
for (const engine of ['sqlite', 'duckdb'] as const) {
  it(`${engine}: common adapter preserves exact cells, isolation, rollback, caps, streamed rows, and explicit disconnect`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `harbor-conformance-${engine}-`))
    const path = join(directory, 'fixture.db')
    const adapter: RelationalAdapter =
      engine === 'sqlite'
        ? new SqliteService(join(directory, 'private.sqlite'))
        : new DuckDBService(join(directory, 'private.sqlite'))
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Conformance fixture',
      engine,
      readOnly: false,
      host: 'local',
      port: 1,
      schema: 'main',
      [engine]: { path, mode: 'create' },
    })
    const registry = new AdapterRegistry()
    registry.register(engine, adapter, adapter)
    const run = (sql: string, sessionId = 'tab-a', maxRows = 1000) =>
      registry.relational(engine).execute({
        connectionId: profile.id,
        sessionId,
        requestId: randomUUID(),
        sql,
        maxRows,
        privateSession: true,
      })
    try {
      expect(await registry.connection(engine).connect(profile)).toMatchObject({ state: 'connected' })
      await run(
        `CREATE TABLE records(id BIGINT PRIMARY KEY, label VARCHAR); INSERT INTO records VALUES(9007199254740993,'exact'),(2,NULL),(3,'')`,
      )
      const exact = await run("SELECT id AS duplicate,id AS duplicate,label FROM records WHERE label='exact'")
      expect(exact.sets[0].columns.map((column) => column.name)).toEqual(['duplicate', 'duplicate', 'label'])
      expect(exact.sets[0].rows).toEqual([['9007199254740993', '9007199254740993', 'exact']])
      expect((await run('SELECT label FROM records ORDER BY id')).sets[0].rows).toEqual([
        [null],
        [''],
        ['exact'],
      ])
      expect((await run('SELECT * FROM records ORDER BY id', 'tab-b', 1)).sets[0]).toMatchObject({
        truncated: true,
        rows: [expect.any(Array)],
      })
      const context = { connectionId: profile.id, sessionId: 'tab-a' }
      await adapter.transaction!({ ...context, action: 'begin' })
      await run("UPDATE records SET label='not committed' WHERE id=2")
      expect((await run('SELECT label FROM records WHERE id=2', 'tab-b')).sets[0].rows).toEqual([[null]])
      await adapter.transaction!({ ...context, action: 'rollback' })
      expect((await run('SELECT label FROM records WHERE id=2')).sets[0].rows).toEqual([[null]])
      const rows: unknown[] = []
      await adapter.streamQuery!(
        { connectionId: profile.id, sql: 'SELECT id,label FROM records ORDER BY id' },
        {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async (row) => {
            rows.push(row)
          },
        },
      )
      expect(rows).toEqual([
        ['2', null],
        ['3', ''],
        ['9007199254740993', 'exact'],
      ])
      await adapter.closeSession(context)
      expect((await adapter.getSessionState(context)).state).toBe('idle')
      await adapter.disconnect(profile.id)
      expect(adapter.status(profile.id).state).toBe('disconnected')
      await expect(run('SELECT 1')).rejects.toThrow(/disconnected|connect/i)
    } finally {
      await adapter.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
