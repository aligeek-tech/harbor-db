import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, stat, symlink, link, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DuckDBInstance } from '@duckdb/node-api'
import { profileSchema, type ConnectionProfile, type QueryInput } from '../src/shared/contracts'
import { DuckDBService } from '../src/main/engines/duckdb'
import type { DuckDBFileGrant } from '../src/main/engines/duckdb-worker'

let directory: string
let path: string
let metadata: string
let service: DuckDBService
let profile: ConnectionProfile
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harbor-duckdb-test-'))
  path = join(directory, 'analytics.duckdb')
  metadata = join(directory, 'harbor.sqlite3')
  await writeFile(metadata, 'private workspace metadata')
  service = new DuckDBService(metadata)
  profile = profileSchema.parse({
    id: randomUUID(),
    name: 'DuckDB fixture',
    engine: 'duckdb',
    readOnly: false,
    host: 'local',
    port: 1,
    queryTimeout: 10000,
    duckdb: { path, mode: 'create' },
  })
})
afterEach(async () => {
  await service.closeAll()
  await rm(directory, { recursive: true, force: true })
})
async function connect(overrides: Partial<ConnectionProfile> = {}): Promise<void> {
  const status = await service.connect({ ...profile, ...overrides })
  expect(status, status.error).toMatchObject({ state: 'connected' })
}
function query(sql: string, overrides: Partial<QueryInput> = {}) {
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
async function grant(
  name: string,
  contents: string,
  format: DuckDBFileGrant['format'],
): Promise<DuckDBFileGrant> {
  const file = join(directory, name)
  await writeFile(file, contents)
  const identity = await stat(file)
  return { path: file, device: identity.dev, inode: identity.ino, format }
}
describe('real DuckDB worker adapter', () => {
  it('creates only by deliberate request, persists, never overwrites and never creates an absent open target', async () => {
    expect(await service.connect({ ...profile, duckdb: { path, mode: 'open' } })).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('does not exist'),
    })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await connect()
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0)
    await query(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY,value VARCHAR); INSERT INTO sample VALUES(1,'saved')",
    )
    await service.disconnect(profile.id)
    const before = await readFile(path)
    expect(await service.connect(profile)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('already exists'),
    })
    expect(await readFile(path)).toEqual(before)
    await connect({ duckdb: { path, mode: 'open' } })
    expect((await query('SELECT * FROM sample')).sets[0].rows).toEqual([['1', 'saved']])
  })
  it('protects metadata and all alias paths, and rejects invalid database files', async () => {
    for (const target of [metadata, join(directory, 'alias'), join(directory, 'hard')]) {
      if (target.endsWith('alias')) await symlink(metadata, target)
      if (target.endsWith('hard')) await link(metadata, target)
      expect(await service.connect({ ...profile, duckdb: { path: target, mode: 'open' } })).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('metadata'),
      })
    }
    const bad = join(directory, 'bad.duckdb')
    await writeFile(bad, 'not a database')
    expect(await service.connect({ ...profile, duckdb: { path: bad, mode: 'open' } })).toMatchObject({
      state: 'failed',
    })
    expect(await readFile(metadata, 'utf8')).toBe('private workspace metadata')
  })
  it('keeps memory data shared across tab connections, isolated from other profiles and disposable', async () => {
    await connect({ duckdb: { path: '', mode: 'memory' } })
    await query('CREATE TABLE memory_data(id INTEGER); INSERT INTO memory_data VALUES(42)')
    expect((await query('SELECT * FROM memory_data', { sessionId: 'tab-b' })).sets[0].rows).toEqual([['42']])
    await service.disconnect(profile.id)
    await connect({ duckdb: { path: '', mode: 'memory' } })
    await expect(query('SELECT * FROM memory_data')).rejects.toThrow('does not exist')
  })
  it('preserves int128, uint128, exact decimals, nanoseconds, binary, null, nested values and duplicate column ordering', async () => {
    await connect()
    const result = await query(
      "SELECT 170141183460469231731687303715884105727::HUGEINT AS n,340282366920938463463374607431768211455::UHUGEINT AS n,12345678901234567890.123456789::DECIMAL(38,9) AS d,TIMESTAMP_NS '2026-09-18 12:34:56.123456789' AS t,'\\x00\\xFF'::BLOB AS b,NULL AS nil,[9223372036854775807::BIGINT,NULL] AS items,{'number': 9223372036854775807::BIGINT} AS obj",
    )
    expect(result.sets[0].columns.slice(0, 2).map((column) => column.name)).toEqual(['n', 'n'])
    expect(result.sets[0].rows[0].slice(0, 6)).toEqual([
      '170141183460469231731687303715884105727',
      '340282366920938463463374607431768211455',
      '12345678901234567890.123456789',
      '2026-09-18 12:34:56.123456789',
      { type: 'binary', base64: 'AP8=' },
      null,
    ])
    expect(result.sets[0].rows[0][6]).toContain('9223372036854775807')
    expect(result.sets[0].rows[0][7]).toContain('9223372036854775807')
  })
  it('binds values natively, preserves integer precision and rejects multi-statement parameter ambiguity', async () => {
    await connect()
    expect(
      (
        await query('SELECT $1::HUGEINT, $2::VARCHAR', {
          parameters: [
            { name: '1', type: 'integer', value: '9223372036854775807', secret: false },
            { name: '2', type: 'text', value: "'; DROP TABLE x; --", secret: false },
          ],
        })
      ).sets[0].rows,
    ).toEqual([['9223372036854775807', "'; DROP TABLE x; --"]])
    await expect(
      query('SELECT ?; SELECT 2', {
        parameters: [{ name: '1', type: 'text', value: 'value', secret: false }],
      }),
    ).rejects.toThrow('one statement')
    await expect(
      query('SELECT ?::INTEGER', {
        parameters: [{ name: '1', type: 'text', value: 'do-not-log-me', secret: true }],
      }),
    ).rejects.toThrow('private parameter')
  })
  it('uses engine-enforced read-only files and locked external access, even for stored views', async () => {
    await connect()
    await query('CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1)')
    const denied = [
      'SET enable_external_access=true',
      "SET allowed_paths=['/etc/passwd']",
      'SET lock_configuration=false',
      `SELECT * FROM read_csv('${metadata}')`,
      "SELECT * FROM read_csv('https://example.invalid/data.csv')",
      'INSTALL httpfs',
      'LOAD httpfs',
      `ATTACH '${join(directory, 'escape.duckdb')}' AS other`,
      `COPY sample TO '${join(directory, 'escape.csv')}'`,
    ]
    for (const sql of denied) await expect(query(sql)).rejects.toThrow()
    await expect(stat(join(directory, 'escape.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(directory, 'escape.duckdb'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.disconnect(profile.id)
    await connect({ readOnly: true, duckdb: { path, mode: 'open' } })
    await expect(query('INSERT INTO sample VALUES(2)')).rejects.toThrow('read-only')
    expect((await query('SELECT * FROM sample')).sets[0].rows).toEqual([['1']])
  })
  it('provides catalogs, schemas, exact DDL, ordered keys and parameterized table filtering', async () => {
    await connect()
    await query(
      "CREATE SCHEMA sales; CREATE TABLE sales.orders(id BIGINT PRIMARY KEY, name VARCHAR NOT NULL, amount DECIMAL(18,2) DEFAULT 0); CREATE INDEX by_name ON sales.orders(name); INSERT INTO sales.orders VALUES(1,'one',1.50),(2,'two',2.50); CREATE VIEW sales.names AS SELECT name FROM sales.orders",
    )
    expect(await service.listObjects({ connectionId: profile.id })).toContainEqual({
      schema: 'sales',
      name: 'orders',
      kind: 'table',
    })
    const description = await service.structure({
      connectionId: profile.id,
      schema: 'sales',
      table: 'orders',
    })
    expect(description.columns[0]).toMatchObject({ name: 'id', primaryKey: true, primaryKeyPosition: 1 })
    expect(description.indexes[0].name).toBe('by_name')
    expect(description.ddl).toContain('CREATE TABLE')
    expect(
      (
        await service.table({
          connectionId: profile.id,
          sessionId: 'tab-a',
          schema: 'sales',
          table: 'orders',
          offset: 0,
          limit: 20,
          direction: 'desc',
          sort: 'id',
          filter: { column: 'name', operator: 'contains', value: 'two' },
        })
      ).sets[0].rows,
    ).toEqual([['2', 'two', '2.50']])
  })
  it('bounds retained rows and bytes while draining native chunks and preserving multiple result sets', async () => {
    await connect()
    const result = await query('SELECT * FROM range(5000); SELECT 7 AS final', { maxRows: 5 })
    expect(result.sets[0].rows).toHaveLength(5)
    expect(result.sets[0].affectedRows).toBe(5000)
    expect(result.sets[0].truncated).toBe(true)
    expect(result.sets[1].rows).toHaveLength(0)
    const bytes = await query("SELECT repeat('x', 1000000) FROM range(20)")
    expect(bytes.sets[0].rows.length).toBeLessThan(9)
    expect(bytes.sets[0].truncated).toBe(true)
  })
  it('isolates tab transactions, rolls back on close and rejects stale edit batches atomically', async () => {
    await connect()
    await query(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY,value VARCHAR); INSERT INTO sample VALUES(1,'before')",
    )
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'begin' })
    await query("UPDATE sample SET value='uncommitted' WHERE id=1")
    expect((await query('SELECT value FROM sample', { sessionId: 'tab-b' })).sets[0].rows).toEqual([
      ['before'],
    ])
    await service.closeSession({ connectionId: profile.id, sessionId: 'tab-a' })
    expect((await query('SELECT value FROM sample')).sets[0].rows).toEqual([['before']])
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'tab-a',
        schema: 'main',
        table: 'sample',
        changes: [
          { kind: 'insert', values: { id: '2', value: 'rollback me' } },
          { kind: 'update', values: { value: 'bad' }, original: { id: '1', value: 'stale' } },
        ],
      }),
    ).rejects.toThrow('Conflict')
    expect((await query('SELECT * FROM sample')).sets[0].rows).toEqual([['1', 'before']])
    expect(
      await service.applyEdits({
        connectionId: profile.id,
        sessionId: 'tab-a',
        schema: 'main',
        table: 'sample',
        changes: [{ kind: 'update', values: { value: 'after' }, original: { id: '1', value: 'before' } }],
      }),
    ).toEqual({ affectedRows: 1 })
  })
  it('interrupts a running native aggregate without blocking the main event loop, rolls back and permits explicit subsequent work', async () => {
    await connect()
    await query('CREATE TABLE sample(id INTEGER)')
    await query('BEGIN; INSERT INTO sample VALUES(1)')
    const requestId = randomUUID()
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const running = query('SELECT sum(sin(i)) FROM range(10000000000) t(i)', { requestId })
    await new Promise((done) => setTimeout(done, 100))
    expect(
      await service.cancel({ connectionId: profile.id, sessionId: 'tab-a', requestId: 'wrong' }),
    ).toMatchObject({ requested: false })
    expect(await service.cancel({ connectionId: profile.id, sessionId: 'tab-a', requestId })).toMatchObject({
      requested: true,
    })
    const result = await running
    clearInterval(timer)
    expect(result.cancelled).toBe(true)
    expect(result.transaction).toBe('idle')
    expect(ticks).toBeGreaterThan(3)
    expect((await query('SELECT count(*) FROM sample')).sets[0].rows).toEqual([['0']])
  })
  it('previews and transactionally imports only native-granted CSV and JSON paths without allowing editor access', async () => {
    await connect()
    const csv = await grant('data.csv', 'id,name\n1,first\n2,second\n', 'csv')
    const json = await grant('data.json', '[{"id":9223372036854775807,"value":"exact"}]', 'json')
    for (const [source, table] of [
      [csv, 'csv_data'],
      [json, 'json_data'],
    ] as const) {
      const input = { connectionId: profile.id, sessionId: 'tab-a', requestId: randomUUID(), grant: source }
      expect((await service.previewFile(input)).sets[0].rows.length).toBeGreaterThan(0)
      expect((await service.importFile({ ...input, schema: 'main', table })).affectedRows).toBeGreaterThan(0)
      await expect(service.importFile({ ...input, schema: 'main', table })).rejects.toThrow('already exists')
      await expect(query(`SELECT * FROM read_csv('${source.path}')`)).rejects.toThrow()
    }
    expect((await query('SELECT * FROM json_data')).sets[0].rows[0][0]).toBe('9223372036854775807')
  })
  it('imports Parquet native chunks with exact decimals, nested data and replacement rejection', async () => {
    const parquet = join(directory, 'data.parquet')
    const fixture = await DuckDBInstance.create(':memory:')
    const writer = await fixture.connect()
    await writer.run(
      `COPY (SELECT 12345678901234567890.123456789::DECIMAL(38,9) AS amount, [9223372036854775807::BIGINT] AS items) TO '${parquet}' (FORMAT PARQUET)`,
    )
    writer.closeSync()
    fixture.closeSync()
    const identity = await stat(parquet)
    const file: DuckDBFileGrant = {
      path: parquet,
      device: identity.dev,
      inode: identity.ino,
      format: 'parquet',
    }
    await connect()
    const input = { connectionId: profile.id, sessionId: 'tab-a', requestId: randomUUID(), grant: file }
    expect(await service.importFile({ ...input, schema: 'main', table: 'parquet_data' })).toEqual({
      affectedRows: 1,
    })
    const row = (await query('SELECT * FROM parquet_data')).sets[0].rows[0]
    expect(row[0]).toBe('12345678901234567890.123456789')
    expect(row[1]).toContain('9223372036854775807')
    await rm(parquet)
    await writeFile(parquet, 'changed')
    await expect(service.previewFile(input)).rejects.toThrow('changed')
  })
  it('returns native composite foreign keys with exact schema and column order', async () => {
    await connect()
    await query(
      'CREATE SCHEMA sales; CREATE TABLE sales.parent(a INTEGER,b INTEGER,PRIMARY KEY(b,a)); CREATE TABLE sales.child(x INTEGER,y INTEGER,FOREIGN KEY(x,y) REFERENCES sales.parent(b,a))',
    )
    const structure = await service.structure({ connectionId: profile.id, schema: 'sales', table: 'child' })
    expect(structure.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ['x', 'y'],
        referencedSchema: 'sales',
        referencedTable: 'parent',
        referencedColumns: ['b', 'a'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      }),
    ])
  })
  it('surfaces a real other-process file lock without overwriting or retrying the write', async () => {
    const code = `const {DuckDBInstance}=require('@duckdb/node-api');(async()=>{const db=await DuckDBInstance.create(process.argv[1]);const c=await db.connect();await c.run('CREATE TABLE owned(id INTEGER)');process.stdout.write('ready');process.stdin.once('data',()=>{c.closeSync();db.closeSync();process.exit(0)})})().catch(e=>{console.error(e.message);process.exit(1)})`
    const child = spawn(process.execPath, ['-e', code, path], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    try {
      const [ready] = await once(child.stdout, 'data')
      expect(String(ready)).toBe('ready')
      expect(await service.connect({ ...profile, duckdb: { path, mode: 'open' } })).toMatchObject({
        state: 'failed',
        error: expect.stringMatching(/lock/i),
      })
      child.stdin.write('close')
      await exited
      await connect({ duckdb: { path, mode: 'open' } })
      expect(
        (await service.listObjects({ connectionId: profile.id })).some((object) => object.name === 'owned'),
      ).toBe(true)
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await exited
      }
    }
  })
  it('detects native MVCC edit conflicts between tab transactions and keeps the winning write', async () => {
    await connect()
    await query(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY,value VARCHAR); INSERT INTO sample VALUES(1,'initial')",
    )
    await query("BEGIN; UPDATE sample SET value='winner' WHERE id=1")
    await query('BEGIN', { sessionId: 'tab-b' })
    await expect(query("UPDATE sample SET value='loser' WHERE id=1", { sessionId: 'tab-b' })).rejects.toThrow(
      /conflict/i,
    )
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-b' }).state).toBe('failed')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-b', action: 'rollback' })
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'commit' })
    expect((await query('SELECT value FROM sample')).sets[0].rows).toEqual([['winner']])
  })
  it('times out through native interruption and cancels a file import transaction without a partial target', async () => {
    await connect({ queryTimeout: 1000 })
    const timed = await query('SELECT sum(sin(i)) FROM range(10000000000) t(i)')
    expect(timed.cancelled).toBe(true)
    const file = await grant(
      'many.csv',
      'id,name\n' + Array.from({ length: 200000 }, (_, i) => `${i},${'x'.repeat(30)}`).join('\n'),
      'csv',
    )
    const requestId = randomUUID()
    const importing = service.importFile({
      connectionId: profile.id,
      sessionId: 'tab-a',
      requestId,
      grant: file,
      schema: 'main',
      table: 'cancelled_import',
    })
    // Capture rejection before requesting cancellation so an expected cancellation
    // cannot briefly become an unhandled promise rejection.
    const outcome = importing.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await new Promise((done) => setTimeout(done, 20))
    const cancelled = await service.cancel({ connectionId: profile.id, sessionId: 'tab-a', requestId })
    expect(cancelled.requested).toBe(true)
    expect(await outcome).toHaveProperty('error')
    expect(
      (await service.listObjects({ connectionId: profile.id })).some(
        (object) => object.name === 'cancelled_import',
      ),
    ).toBe(false)
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('idle')
  })
  it('exports every row with backpressure from a separate read-only snapshot, preserving duplicate columns', async () => {
    await connect()
    await query(
      'CREATE TABLE sample(id INTEGER); INSERT INTO sample SELECT * FROM range(3000); BEGIN; INSERT INTO sample VALUES(9999)',
    )
    const controller = new AbortController()
    const rows: string[] = []
    let names: string[] = []
    let active = 0
    await service.streamQuery(
      { connectionId: profile.id, sql: 'SELECT id AS duplicate,id AS duplicate FROM sample ORDER BY id' },
      {
        signal: controller.signal,
        onColumns: async (columns) => {
          names = columns.map((column) => column.name)
        },
        onRow: async (row) => {
          expect(active++).toBe(0)
          if (rows.length % 100 === 0) await new Promise((done) => setTimeout(done, 1))
          rows.push(String(row[0]))
          active--
        },
      },
    )
    expect(names).toEqual(['duplicate', 'duplicate'])
    expect(rows).toHaveLength(3000)
    expect(rows.at(-1)).toBe('2999')
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('open')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'rollback' })
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql: 'INSERT INTO sample VALUES(7)' },
        { signal: controller.signal, onColumns: async () => {}, onRow: async () => {} },
      ),
    ).rejects.toThrow('read-only')
  })
  it('cleans export sessions after abort, sink errors, oversized rows and native read-only side effects', async () => {
    await connect()
    await query('CREATE SEQUENCE seq')
    const controller = new AbortController()
    let count = 0
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql: 'SELECT * FROM range(100000)' },
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
      service.streamQuery({ connectionId: profile.id, sql: "SELECT repeat('x', 9000000)" }, sink),
    ).rejects.toThrow('8 MiB')
    await expect(
      service.streamQuery({ connectionId: profile.id, sql: "SELECT nextval('seq')" }, sink),
    ).rejects.toThrow(/read.only/i)
    expect((await query('SELECT 42')).sets[0].rows).toEqual([['42']])
  })
})
