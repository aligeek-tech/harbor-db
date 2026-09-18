import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'
import { SchemaChangesService, type SchemaAdapter } from '../src/main/persistence/schema-changes'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import type { SchemaOperation } from '../src/shared/schema-changes'

const resources: { service: SqliteService | DuckDBService; directory: string }[] = []
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.service.closeAll()
    await rm(item.directory, { force: true, recursive: true })
  }
})
async function fixture(engine: 'sqlite' | 'duckdb') {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-schema-native-')),
    metadata = join(directory, 'metadata.sqlite')
  await writeFile(metadata, 'protected metadata fixture')
  const native = engine === 'sqlite' ? new SqliteService(metadata) : new DuckDBService(metadata)
  resources.push({ service: native, directory })
  let profile: ConnectionProfile = profileSchema.parse({
    id: randomUUID(),
    name: `${engine} schema fixture`,
    engine,
    host: 'local',
    port: 1,
    schema: 'main',
    readOnly: false,
    queryTimeout: 10000,
    [engine]: { path: join(directory, engine === 'sqlite' ? 'data.sqlite' : 'data.duckdb'), mode: 'create' },
  })
  const status = await native.connect(profile)
  expect(status, status.error).toMatchObject({ state: 'connected' })
  const adapter: SchemaAdapter = native
  let time = Date.now()
  const service = new SchemaChangesService({ profile: () => profile, adapter: () => adapter }, () => time)
  const target = { connectionId: profile.id, schema: 'main', table: 'sample' }
  const query = (sql: string) =>
    native.execute({
      connectionId: profile.id,
      sessionId: 'setup',
      requestId: randomUUID(),
      sql,
      maxRows: 100,
      privateSession: true,
      confirm: profile.name,
    })
  async function run(operation: SchemaOperation, table = 'sample') {
    const preview = await service.preview({ target: { ...target, table }, operation })
    expect(preview.blockedReasons, preview.blockedReasons.join('\n')).toEqual([])
    return { preview, result: await service.execute({ token: preview.token, confirm: preview.confirmation }) }
  }
  return {
    native,
    service,
    adapter,
    target,
    profile: () => profile,
    query,
    run,
    changeProfile: (value: Partial<ConnectionProfile>) => {
      profile = { ...profile, ...value }
    },
    expire: () => {
      time += 5 * 60000 + 1
    },
  }
}

describe.each(['sqlite', 'duckdb'] as const)('real %s schema workflow', (engine) => {
  it('compares explicitly selected tables and native views across same-engine sources without applying drafts', async () => {
    const desired = await fixture(engine),
      actual = await fixture(engine)
    await desired.query(
      'CREATE TABLE sample(id INTEGER PRIMARY KEY,extra INTEGER); CREATE VIEW sample_view AS SELECT id,extra FROM sample',
    )
    await actual.query(
      'CREATE TABLE sample(id INTEGER PRIMARY KEY,old_value INTEGER); CREATE VIEW sample_view AS SELECT id FROM sample',
    )
    if (engine === 'sqlite')
      await desired.query('CREATE TRIGGER sample_trigger AFTER INSERT ON sample BEGIN SELECT 1; END')
    const contexts = [desired, actual],
      service = new SchemaChangesService({
        profile: (id) => contexts.find((item) => item.target.connectionId === id)!.profile(),
        adapter: (id) => contexts.find((item) => item.target.connectionId === id)!.adapter,
      })
    const comparison = await service.compare({
      source: desired.target,
      target: actual.target,
      objects: [
        { kind: 'table', sourceName: 'sample', targetName: 'sample' },
        { kind: 'view', sourceName: 'sample_view', targetName: 'sample_view' },
        {
          kind: engine === 'sqlite' ? 'trigger' : 'function',
          sourceName: 'sample_trigger',
          targetName: 'sample_trigger',
        },
      ],
    })
    expect(comparison.differences).toContainEqual(
      expect.objectContaining({
        object: expect.stringContaining('column extra'),
        change: 'add',
        supported: true,
      }),
    )
    expect(comparison.differences).toContainEqual(
      expect.objectContaining({
        object: expect.stringContaining('view sample_view'),
        change: 'change',
        supported: false,
      }),
    )
    expect(comparison.differences).toContainEqual(
      expect.objectContaining({
        object: expect.stringContaining(
          engine === 'sqlite' ? 'trigger sample_trigger' : 'function sample_trigger',
        ),
        supported: false,
      }),
    )
    expect((await actual.adapter.structure(actual.target)).columns.map((column) => column.name)).toEqual([
      'id',
      'old_value',
    ])
    expect(comparison.statements.join()).toContain('DROP COLUMN "old_value"')
    await expect(
      service.compare({
        source: desired.target,
        target: actual.target,
        objects: Array.from({ length: 21 }, (_, index) => ({
          kind: 'table',
          sourceName: `table${index}`,
          targetName: `table${index}`,
        })),
      }),
    ).rejects.toThrow()
  })
  it('seals preview content and rolls back every step when adding required data without a default fails', async () => {
    const f = await fixture(engine)
    await f.query('CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample VALUES(1)')
    const preview = await f.service.preview({
      target: f.target,
      operation: {
        kind: 'add-column',
        column: { name: 'required', type: { kind: 'integer' }, nullable: false },
      },
    })
    const original = preview.statements[0]
    preview.statements[0] = 'DROP TABLE sample;'
    const result = await f.service.execute({ token: preview.token, confirm: preview.confirmation })
    expect(result.steps[0].sql).toBe(original)
    expect(result.state, JSON.stringify(result)).toBe('rolled-back')
    expect((await f.adapter.structure(f.target)).columns.map((column) => column.name)).toEqual(['id'])
  })
  it('creates a table, adds/renames/drops columns, creates/drops an index, and reads actual committed schema', async () => {
    const f = await fixture(engine)
    const created = await f.run({
      kind: 'create-table',
      columns: [
        { name: 'id', type: { kind: 'integer' }, nullable: false },
        { name: 'value', type: { kind: 'text' }, nullable: true },
      ],
      constraints: [{ kind: 'primary-key', name: 'sample_pk', columns: ['id'] }],
    })
    expect(created.result.state, JSON.stringify(created.result)).toBe('committed')
    await f.query("INSERT INTO sample VALUES(1,'original')")
    const added = (
      await f.run({
        kind: 'add-column',
        column: {
          name: 'score',
          type: { kind: 'integer' },
          nullable: false,
          default: { kind: 'number', value: '7' },
        },
      })
    ).result
    expect(added.state, JSON.stringify(added)).toBe('committed')
    expect((await f.run({ kind: 'rename-column', name: 'score', newName: 'ranking' })).result.state).toBe(
      'committed',
    )
    expect(
      (await f.run({ kind: 'create-index', name: 'ranking_idx', columns: ['ranking'], unique: false })).result
        .state,
    ).toBe('committed')
    expect((await f.adapter.structure(f.target)).indexes.some((index) => index.name === 'ranking_idx')).toBe(
      true,
    )
    expect((await f.run({ kind: 'drop-index', name: 'ranking_idx' })).result.state).toBe('committed')
    expect((await f.run({ kind: 'drop-column', name: 'ranking' })).result.state).toBe('committed')
    expect((await f.query('SELECT * FROM sample')).sets[0].rows).toEqual([['1', 'original']])
    expect((await f.run({ kind: 'rename-table', name: 'renamed' })).result.state).toBe('committed')
    expect((await f.query('SELECT count(*) FROM renamed')).sets[0].rows).toEqual([['1']])
  })
  it('inspects incoming keys and never executes a stale, mismatched, expired or changed-profile token', async () => {
    const f = await fixture(engine)
    await f.query(
      'CREATE TABLE sample(id INTEGER PRIMARY KEY, value INTEGER); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES sample(id))',
    )
    const operation: SchemaOperation = {
      kind: 'add-column',
      column: { name: 'fresh', type: { kind: 'text' }, nullable: true },
    }
    const preview = await f.service.preview({ target: f.target, operation })
    expect(preview.dependencies.some((dependency) => dependency.name.includes('child'))).toBe(true)
    await expect(f.service.execute({ token: preview.token, confirm: 'wrong' })).rejects.toThrow(
      /exact target/,
    )
    await f.query('ALTER TABLE sample ADD COLUMN concurrent INTEGER')
    const stale = await f.service.execute({ token: preview.token, confirm: preview.confirmation })
    expect(stale.state).toBe('failed')
    expect(stale.steps.every((step) => step.status === 'not-run')).toBe(true)
    expect(stale.warnings.join()).toMatch(/changed after preview/)
    await expect(f.service.execute({ token: preview.token, confirm: preview.confirmation })).rejects.toThrow(
      /expired/,
    )
    const changed = await f.service.preview({ target: f.target, operation })
    f.changeProfile({ readOnly: true })
    await expect(f.service.execute({ token: changed.token, confirm: changed.confirmation })).rejects.toThrow(
      /profile changed/,
    )
    f.changeProfile({ readOnly: false })
    const expired = await f.service.preview({ target: f.target, operation })
    f.expire()
    await expect(f.service.execute({ token: expired.token, confirm: expired.confirmation })).rejects.toThrow(
      /expired/,
    )
    expect((await f.adapter.structure(f.target)).columns.some((column) => column.name === 'fresh')).toBe(
      false,
    )
  })
  it('rolls back a failed unique index and leaves a no-apply comparison draft with unsupported changes marked', async () => {
    const f = await fixture(engine)
    await f.query(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY,value INTEGER,only_target TEXT); INSERT INTO sample VALUES(1,4,'a'),(2,4,'b'); CREATE TABLE desired(id INTEGER PRIMARY KEY,value TEXT,new_field INTEGER)",
    )
    const failed = await f.run({
      kind: 'create-index',
      name: 'unique_value',
      columns: ['value'],
      unique: true,
    })
    expect(failed.result.state, JSON.stringify(failed.result)).toBe('rolled-back')
    expect((await f.adapter.structure(f.target)).indexes.some((item) => item.name === 'unique_value')).toBe(
      false,
    )
    const comparison = await f.service.compare({
      source: { ...f.target, table: 'desired' },
      target: f.target,
    })
    expect(comparison.differences).toContainEqual(
      expect.objectContaining({ object: 'column value', change: 'change', supported: false }),
    )
    expect(comparison.statements.some((sql) => sql.includes('DROP COLUMN "only_target"'))).toBe(true)
    expect(
      (await f.adapter.structure(f.target)).columns.some((column) => column.name === 'only_target'),
    ).toBe(true)
    expect(comparison.warnings.join()).toMatch(/rename/)
  })
  it('validates ordered referenced primary keys and supports create-time foreign/unique/check constraints', async () => {
    const f = await fixture(engine)
    await f.query('CREATE TABLE parent(a INTEGER,b INTEGER,PRIMARY KEY(b,a))')
    const operation: SchemaOperation = {
      kind: 'create-table',
      columns: [
        { name: 'id', type: { kind: 'integer' }, nullable: false },
        { name: 'a', type: { kind: 'integer' }, nullable: true },
        { name: 'b', type: { kind: 'integer' }, nullable: true },
      ],
      constraints: [
        { kind: 'primary-key', name: 'pk', columns: ['id'] },
        { kind: 'unique', name: 'uq', columns: ['a', 'b'] },
        {
          kind: 'check',
          name: 'positive',
          column: 'id',
          operator: '>',
          value: { kind: 'number', value: '0' },
        },
        {
          kind: 'foreign-key',
          name: 'parent_fk',
          columns: ['b', 'a'],
          referencedSchema: 'main',
          referencedTable: 'parent',
          referencedColumns: ['b', 'a'],
        },
      ],
    }
    expect((await f.run(operation)).result.state).toBe('committed')
    await expect(f.query('INSERT INTO sample VALUES(-1,NULL,NULL)')).rejects.toThrow()
    expect((await f.adapter.structure(f.target)).foreignKeys).toContainEqual(
      expect.objectContaining({ columns: ['b', 'a'], referencedColumns: ['b', 'a'] }),
    )
    const invalid = await f.service.preview({
      target: { ...f.target, table: 'bad' },
      operation: {
        ...operation,
        constraints: [
          {
            kind: 'foreign-key',
            name: 'bad_fk',
            columns: ['a', 'b'],
            referencedSchema: 'main',
            referencedTable: 'parent',
            referencedColumns: ['a', 'b'],
          },
        ],
      },
    })
    expect(invalid.blockedReasons.join()).toMatch(/primary key in order/)
  })
})
