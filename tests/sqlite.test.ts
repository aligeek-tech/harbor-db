import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, link, symlink, stat, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  profileSchema,
  type ConnectionProfile,
  type QueryInput,
  type QueryResult,
  type Cell,
} from '../src/shared/contracts'
import { SqliteService } from '../src/main/engines/sqlite'

let directory: string
let path: string
let metadata: string
let service: SqliteService
let profile: ConnectionProfile

function fixture(sql: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
async function connect(overrides: Partial<ConnectionProfile> = {}): Promise<ConnectionProfile> {
  const target = { ...profile, ...overrides }
  expect(await service.connect(target)).toMatchObject({ state: 'connected', transport: 'Local file' })
  return target
}
function query(sql: string, overrides: Partial<QueryInput> = {}): Promise<QueryResult> {
  return service.execute({
    connectionId: profile.id,
    sessionId: 'tab-a',
    requestId: randomUUID(),
    sql,
    maxRows: 1000,
    privateSession: false,
    ...overrides,
  })
}
function row(result: QueryResult, index = 0): Record<string, Cell> {
  return Object.fromEntries(
    result.sets[0].columns.map((column, columnIndex) => [
      column.name,
      result.sets[0].rows[index][columnIndex],
    ]),
  )
}
async function untilRunning(sessionId: string): Promise<void> {
  await expect.poll(() => service.getSessionState({ connectionId: profile.id, sessionId }).running).toBe(true)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harbor-sqlite-test-'))
  path = join(directory, 'managed.sqlite')
  metadata = join(directory, 'harbor.sqlite3')
  const workspace = new DatabaseSync(metadata)
  workspace.exec(
    "CREATE TABLE protected_state (value TEXT); INSERT INTO protected_state VALUES ('preserve me')",
  )
  workspace.close()
  service = new SqliteService(metadata)
  profile = profileSchema.parse({
    id: randomUUID(),
    name: 'SQLite fixture',
    engine: 'sqlite',
    host: 'local',
    port: 1,
    readOnly: false,
    queryTimeout: 10000,
    sqlite: { path, mode: 'open', busyTimeoutMs: 60 },
  })
})
afterEach(async () => {
  await service.closeAll()
  await rm(directory, { recursive: true, force: true })
})

describe('real SQLite worker adapter', () => {
  it('streams all rows under backpressure from a dedicated read-only snapshot, excluding the active tab transaction', async () => {
    fixture(
      'PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER); WITH RECURSIVE r(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM r WHERE i<2999) INSERT INTO sample SELECT i FROM r',
    )
    await connect()
    await query('BEGIN; INSERT INTO sample VALUES(9999)')
    let count = 0
    let busy = false
    let names: string[] = []
    await service.streamQuery(
      { connectionId: profile.id, sql: 'SELECT id AS duplicate,id AS duplicate FROM sample ORDER BY id' },
      {
        signal: new AbortController().signal,
        onColumns: async (columns) => {
          names = columns.map((column) => column.name)
        },
        onRow: async (row) => {
          expect(busy).toBe(false)
          busy = true
          expect(row).toEqual([String(count), String(count)])
          if (count % 100 === 0) await new Promise((done) => setTimeout(done, 1))
          count++
          busy = false
        },
      },
    )
    expect(names).toEqual(['duplicate', 'duplicate'])
    expect(count).toBe(3000)
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('open')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'rollback' })
  })
  it('cleans dedicated export sessions after abort or sink failure and rejects write re-execution', async () => {
    fixture('CREATE TABLE sample(id INTEGER)')
    await connect()
    const controller = new AbortController()
    let count = 0
    await expect(
      service.streamQuery(
        {
          connectionId: profile.id,
          sql: 'WITH RECURSIVE r(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM r WHERE i<9999) SELECT i FROM r',
        },
        {
          signal: controller.signal,
          onColumns: async () => {},
          onRow: async () => {
            if (++count === 3) controller.abort()
          },
        },
      ),
    ).rejects.toThrow(/cancel/i)
    expect(count).toBe(3)
    const sink = { signal: new AbortController().signal, onColumns: async () => {}, onRow: async () => {} }
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql: 'SELECT 1' },
        {
          ...sink,
          onRow: async () => {
            throw new Error('simulated disk failure')
          },
        },
      ),
    ).rejects.toThrow('simulated disk failure')
    await expect(
      service.streamQuery({ connectionId: profile.id, sql: 'INSERT INTO sample VALUES(1)' }, sink),
    ).rejects.toThrow('read-only')
    expect((await query('SELECT count(*) FROM sample')).sets[0].rows).toEqual([['0']])
  })
  it('exposes composite foreign keys in native order and resolves an omitted parent key by ordinal', async () => {
    fixture(
      'CREATE TABLE parent(a INTEGER,b INTEGER,PRIMARY KEY(b,a)); CREATE TABLE child(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES parent ON DELETE CASCADE); CREATE TABLE explicit_child(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES parent(b,a))',
    )
    await connect()
    for (const table of ['child', 'explicit_child']) {
      const structure = await service.structure({ connectionId: profile.id, schema: 'main', table })
      expect(structure.foreignKeys).toEqual([
        expect.objectContaining({
          columns: ['x', 'y'],
          referencedSchema: 'main',
          referencedTable: 'parent',
          referencedColumns: ['b', 'a'],
        }),
      ])
    }
    expect(
      (await service.structure({ connectionId: profile.id, schema: 'main', table: 'child' })).foreignKeys?.[0]
        .onDelete,
    ).toBe('CASCADE')
  })
  it('reads committed WAL data without changing journal mode or treating the database file as a backup', async () => {
    const writer = new DatabaseSync(path)
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'wal row')",
      )
      await connect({ readOnly: true })
      expect((await query('SELECT * FROM sample')).sets[0].rows).toEqual([['1', 'wal row']])
      writer.exec("INSERT INTO sample VALUES(2,'later commit')")
      expect((await query('SELECT count(*) FROM sample')).sets[0].rows).toEqual([['2']])
      await service.disconnect(profile.id)
      expect(writer.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(writer.prepare('SELECT count(*) AS total FROM sample').get()?.total).toBe(2)
    } finally {
      writer.close()
    }
  })

  it('never implicitly creates an open-existing file and creates only with explicit exclusive intent', async () => {
    expect(await service.connect(profile)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('does not exist'),
    })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await service.connect({ ...profile, readOnly: true, sqlite: { ...profile.sqlite, mode: 'create' } }),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('requires writes') })
    await connect({ sqlite: { ...profile.sqlite, mode: 'create' } })
    await query(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'first');",
    )
    await service.disconnect(profile.id)
    expect(
      await service.connect({ ...profile, sqlite: { ...profile.sqlite, mode: 'create' } }),
    ).toMatchObject({ state: 'failed' })
    await connect()
    expect((await query('SELECT value FROM sample')).sets[0].rows).toEqual([['first']])
  })

  it('rejects Harbor metadata by path, symbolic link, hard link and create through a directory alias', async () => {
    const hard = join(directory, 'metadata-hard.sqlite')
    const symbolic = join(directory, 'metadata-symbolic.sqlite')
    await link(metadata, hard)
    await symlink(metadata, symbolic)
    for (const candidate of [metadata, hard, symbolic]) {
      expect(
        await service.connect({ ...profile, sqlite: { ...profile.sqlite, path: candidate } }),
      ).toMatchObject({ state: 'failed', error: expect.stringContaining('metadata') })
    }
    const other = join(directory, 'application-data')
    const alias = join(directory, 'alias')
    await mkdir(other)
    await symlink(other, alias)
    const missingMetadata = join(other, 'harbor.sqlite3')
    const otherService = new SqliteService(missingMetadata)
    try {
      expect(
        await otherService.connect({
          ...profile,
          sqlite: { ...profile.sqlite, mode: 'create', path: join(alias, 'harbor.sqlite3') },
        }),
      ).toMatchObject({ state: 'failed', error: expect.stringContaining('metadata') })
      await expect(stat(missingMetadata)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await otherService.closeAll()
    }
    const db = new DatabaseSync(metadata, { readOnly: true })
    expect(db.prepare('SELECT value FROM protected_state').get()?.value).toBe('preserve me')
    db.close()
  })

  it('preserves signed 64-bit integers, duplicate column positions, binary, NULL and stored decimal text', async () => {
    fixture(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY, exact_text TEXT, bytes BLOB, optional TEXT); INSERT INTO sample VALUES(9007199254740993,'12345678901234567890.12345678',X'00ff',NULL)",
    )
    await connect()
    const result = await query(
      'SELECT id AS duplicate, -9223372036854775808 AS duplicate, exact_text, bytes, optional, 12.5 AS real_value FROM sample',
    )
    expect(result.sets[0].columns.slice(0, 2).map((column) => column.name)).toEqual([
      'duplicate',
      'duplicate',
    ])
    expect(result.sets[0].rows).toEqual([
      [
        '9007199254740993',
        '-9223372036854775808',
        '12345678901234567890.12345678',
        { type: 'binary', base64: 'AP8=' },
        null,
        '12.5',
      ],
    ])
    expect(result.messages.join(' ')).toContain('does not guarantee arbitrary precision')
  })

  it('binds typed parameters natively without SQL substitution and rejects multi-statement parameter use', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY, label TEXT)')
    await connect()
    await query('INSERT INTO sample VALUES (?, ?)', {
      parameters: [
        { name: 'id', type: 'integer', secret: false, value: '9007199254740993' },
        { name: 'label', type: 'text', secret: false, value: "x'); DROP TABLE sample; --" },
      ],
    })
    expect((await query('SELECT * FROM sample')).sets[0].rows).toEqual([
      ['9007199254740993', "x'); DROP TABLE sample; --"],
    ])
    await expect(
      query('SELECT ?; SELECT 2', {
        parameters: [{ name: 'id', type: 'integer', secret: false, value: '1' }],
      }),
    ).rejects.toThrow('exactly one')
    await expect(
      query('SELECT no_such_function(?)', {
        parameters: [{ name: 'token', type: 'text', secret: true, value: 'fixture-private' }],
      }),
    ).rejects.toThrow('private parameter')
  })

  it('enforces read-only at the file boundary and denies file escape, unsafe pragmas and extension loading', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY)')
    await connect({ readOnly: true })
    await expect(query('INSERT INTO sample VALUES(1)')).rejects.toThrow('read-only')
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'edit',
        schema: 'main',
        table: 'sample',
        changes: [{ kind: 'insert', values: { id: '1' } }],
      }),
    ).rejects.toThrow('read-only')
    await connect()
    const escaped = join(directory, 'must-not-exist.sqlite').replaceAll("'", "''")
    for (const sql of [
      `ATTACH DATABASE '${escaped}' AS other`,
      `VACUUM INTO '${escaped}'`,
      'PRAGMA writable_schema=ON',
      'PRAGMA trusted_schema=ON',
      "SELECT load_extension('not-a-module')",
    ])
      await expect(query(sql)).rejects.toThrow(/authoriz|extension/)
    await expect(stat(join(directory, 'must-not-exist.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await query('SELECT count(*) FROM sample')).sets[0].rows).toEqual([['0']])
  })

  it('discovers tables, views, indexes, triggers and primary/foreign key structure without changing journal mode', async () => {
    fixture(
      "CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id), value TEXT); CREATE INDEX child_value ON child(value); CREATE VIEW child_view AS SELECT * FROM child; CREATE TRIGGER child_label AFTER INSERT ON child BEGIN UPDATE child SET value='set' WHERE id=NEW.id; END",
    )
    await connect()
    expect(await service.listDatabases(profile.id)).toEqual(['main'])
    const objects = await service.listObjects({ connectionId: profile.id, schema: 'main' })
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'child', kind: 'table' }),
        expect.objectContaining({ name: 'child_view', kind: 'view' }),
        expect.objectContaining({ name: 'child_label', kind: 'trigger' }),
      ]),
    )
    const description = await service.structure({ connectionId: profile.id, schema: 'main', table: 'child' })
    expect(description.columns[0]).toMatchObject({ name: 'id', primaryKey: true, primaryKeyPosition: 1 })
    expect(description.indexes).toContainEqual(expect.objectContaining({ name: 'child_value' }))
    expect(
      description.constraints.some((constraint) => constraint.definition.includes('REFERENCES "parents"')),
    ).toBe(true)
    expect(description.ddl).toContain('CREATE TABLE child')
    const db = new DatabaseSync(path)
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
    db.close()
  })

  it('browses filtered and sorted pages using the same executable SQL, retaining bounded result data', async () => {
    fixture(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'a'),(2,'a'),(3,'b'),(4,'b'),(5,'c')",
    )
    await connect()
    const result = await service.table({
      connectionId: profile.id,
      sessionId: 'browse',
      schema: 'main',
      table: 'sample',
      offset: 0,
      limit: 1,
      sort: 'id',
      direction: 'desc',
      filter: { column: 'value', operator: 'equals', value: 'b' },
    })
    expect(result.sets[0].rows).toEqual([['4', 'b']])
    expect((await query(result.tableQuery!.editorSql)).sets[0].rows).toEqual(result.sets[0].rows)
    const limited = await query('SELECT * FROM sample; SELECT 99', { maxRows: 2 })
    expect(limited.sets[0].rows).toHaveLength(2)
    expect(limited.sets[0].affectedRows).toBe(5)
    expect(limited.sets[0].truncated).toBe(true)
    expect(limited.sets[1].rows).toEqual([])
    expect(limited.sets[1].truncated).toBe(true)
    await expect(query('SELECT zeroblob(9000000)')).rejects.toThrow(/too big/)
  })

  it('uses SQLite statement boundaries for trigger bodies and reports CTE mutation counts', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)')
    await connect()
    const result = await query(
      "CREATE TRIGGER set_label AFTER INSERT ON sample BEGIN UPDATE sample SET value='semi;colon' WHERE id=NEW.id; END; INSERT INTO sample VALUES(1,'x'); SELECT * FROM sample;",
    )
    expect(result.sets).toHaveLength(3)
    expect(result.sets[0].affectedRows).toBe(0)
    expect(result.sets[1].affectedRows).toBe(1)
    expect(result.sets[2].rows).toEqual([['1', 'semi;colon']])
    const updated = await query(
      "WITH ids AS (SELECT 1 AS id) UPDATE sample SET value='updated' WHERE id IN (SELECT id FROM ids)",
    )
    expect(updated.sets[0].affectedRows).toBe(1)
  })

  it('keeps transactions on their tab and rolls back on close without replay', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY)')
    await connect()
    expect(
      await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'begin' }),
    ).toEqual({ state: 'open' })
    await query('INSERT INTO sample VALUES(1)')
    expect((await query('SELECT count(*) FROM sample', { sessionId: 'tab-b' })).sets[0].rows).toEqual([['0']])
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('open')
    await service.closeSession({ connectionId: profile.id, sessionId: 'tab-a' })
    expect((await query('SELECT count(*) FROM sample', { sessionId: 'tab-b' })).sets[0].rows).toEqual([['0']])
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-b', action: 'begin' })
    await query('INSERT INTO sample VALUES(2)', { sessionId: 'tab-b' })
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-b', action: 'commit' })
    await service.disconnect(profile.id)
    await connect()
    expect((await query('SELECT id FROM sample')).sets[0].rows).toEqual([['2']])
  })

  it('applies reviewed insert/update/delete atomically and rolls back the entire batch on stale original', async () => {
    fixture(
      "CREATE TABLE sample(a INTEGER, b TEXT, value TEXT, PRIMARY KEY(b,a)); INSERT INTO sample VALUES(1,'x','first'),(2,'x','second')",
    )
    await connect()
    const fetched = await query('SELECT * FROM sample ORDER BY a')
    const first = row(fetched),
      second = row(fetched, 1)
    const base = { connectionId: profile.id, sessionId: 'edit', schema: 'main', table: 'sample' }
    fixture("UPDATE sample SET value='concurrent' WHERE a=2")
    await expect(
      service.applyEdits({
        ...base,
        changes: [
          { kind: 'update', original: first, values: { value: 'should roll back' } },
          { kind: 'delete', original: second, values: {} },
        ],
      }),
    ).rejects.toThrow('Conflict')
    expect((await query('SELECT value FROM sample ORDER BY a')).sets[0].rows).toEqual([
      ['first'],
      ['concurrent'],
    ])
    expect(
      await service.applyEdits({
        ...base,
        changes: [
          { kind: 'update', original: first, values: { value: 'saved' } },
          { kind: 'insert', values: { a: '3', b: 'x', value: 'new' } },
        ],
      }),
    ).toEqual({ affectedRows: 2 })
    const added = row(await query('SELECT * FROM sample WHERE a=3'))
    expect(
      await service.applyEdits({ ...base, changes: [{ kind: 'delete', original: added, values: {} }] }),
    ).toEqual({ affectedRows: 1 })
  })

  it('rejects edits to views/generated columns and returns busy locking without disturbing the owning transaction', async () => {
    fixture(
      'CREATE TABLE sample(id INTEGER PRIMARY KEY, value INTEGER, doubled INTEGER GENERATED ALWAYS AS(value*2)); INSERT INTO sample(id,value) VALUES(1,10); CREATE VIEW sample_view AS SELECT * FROM sample',
    )
    await connect()
    const original = row(await query('SELECT * FROM sample'))
    const base = { connectionId: profile.id, sessionId: 'edit', schema: 'main', table: 'sample' }
    await expect(
      service.applyEdits({
        ...base,
        table: 'sample_view',
        changes: [{ kind: 'update', original, values: { value: '20' } }],
      }),
    ).rejects.toThrow('base tables')
    await expect(
      service.applyEdits({ ...base, changes: [{ kind: 'update', original, values: { doubled: '999' } }] }),
    ).rejects.toThrow('generated')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'begin' })
    await query('UPDATE sample SET value=11 WHERE id=1')
    await expect(
      service.applyEdits({ ...base, changes: [{ kind: 'update', original, values: { value: '20' } }] }),
    ).rejects.toThrow(/locked/)
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('open')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'rollback' })
    expect((await query('SELECT value FROM sample')).sets[0].rows).toEqual([['10']])
  })

  it('cancels a streaming query, closes its transaction and releases the write lock without automatic replay', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY)')
    await connect()
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'begin' })
    await query('INSERT INTO sample VALUES(1)')
    const requestId = randomUUID()
    const running = query(
      'WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100000000) SELECT n FROM numbers',
      { requestId, maxRows: 2 },
    )
    await untilRunning('tab-a')
    const started = performance.now()
    expect(await service.cancel({ connectionId: profile.id, sessionId: 'tab-a', requestId })).toMatchObject({
      requested: true,
      message: expect.stringContaining('native SQLite step'),
    })
    expect(await running).toMatchObject({ cancelled: true, transaction: 'idle' })
    expect(performance.now() - started).toBeLessThan(5000)
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' })).toMatchObject({
      connected: false,
      running: false,
    })
    await expect(query('SELECT 1')).rejects.toThrow('Reconnect')
    expect((await query('SELECT count(*) FROM sample', { sessionId: 'tab-b' })).sets[0].rows).toEqual([['0']])
    await query('INSERT INTO sample VALUES(2)', { sessionId: 'tab-b' })
    expect((await query('SELECT id FROM sample', { sessionId: 'tab-b' })).sets[0].rows).toEqual([['2']])
  })

  it('keeps the main event loop responsive, rejects simultaneous tab work and times out without reopening', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY)')
    await connect({ queryTimeout: 1000 })
    let heartbeat = false
    const timer = setTimeout(() => {
      heartbeat = true
    }, 30)
    const running = query(
      'WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100000000) SELECT n FROM numbers',
      { maxRows: 1 },
    )
    const assertion = expect(running).rejects.toThrow('timed out')
    await untilRunning('tab-a')
    await expect(query('SELECT 2')).rejects.toThrow('running operation')
    await assertion
    clearTimeout(timer)
    expect(heartbeat).toBe(true)
    await expect(query('SELECT 1')).rejects.toThrow('Reconnect')
  })

  it('rejects retargeting/reserved sessions and notices replacement of the selected file', async () => {
    fixture('CREATE TABLE sample(id INTEGER PRIMARY KEY)')
    await connect()
    await expect(query('SELECT 1', { sessionId: '_metadata' })).rejects.toThrow('reserved')
    await expect(query('SELECT 1', { database: 'other' })).rejects.toThrow('main namespace')
    await expect(service.listObjects({ connectionId: profile.id, schema: 'other' })).rejects.toThrow(
      'main namespace',
    )
    await rename(path, path + '.original')
    fixture('CREATE TABLE replacement(id INTEGER PRIMARY KEY)')
    await expect(query('SELECT 1', { sessionId: 'new-tab' })).rejects.toThrow('changed before')
  })
})
