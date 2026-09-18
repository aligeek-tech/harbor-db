import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mariadb, { type Connection } from 'mariadb'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlService } from '../src/main/engines/sql'
import { exportLoadedData } from '../src/main/persistence/export'
import { profileSchema, type Cell, type QueryResult } from '../src/shared/contracts'
import { parseCsv, prepareCsvInserts } from '../src/shared/csv'
import type { QueryParameter } from '../src/shared/parameters'

// Opt in separately: compose.mysql.yaml is an isolated, disposable MySQL 8.4 fixture.
const integration = process.env.HARBOR_MYSQL === '1'
const profile = profileSchema.parse({
  id: 'mysql-integration',
  name: 'Local MySQL verification',
  engine: 'mysql',
  host: '127.0.0.1',
  port: 13307,
  username: 'harbor',
  database: 'harbor',
  readOnly: false,
  queryTimeout: 15000,
})
const secrets = { password: 'harbor_test' }
const service = new SqlService()
const suffix = crypto.randomUUID().replaceAll('-', '')
const table = `mysql_checks_${suffix}`
const noKey = `mysql_nokey_${suffix}`
const myisam = `mysql_myisam_${suffix}`
const quoted = `mysql_quote\`_${suffix}`
const quote = (value: string) => '`' + value.replaceAll('`', '``') + '`'
let control: Connection | undefined

function query(
  sql: string,
  sessionId = 'query',
  options: { connectionId?: string; parameters?: QueryParameter[]; maxRows?: number; confirm?: string } = {},
) {
  return service.execute({
    connectionId: options.connectionId || profile.id,
    sessionId,
    requestId: crypto.randomUUID(),
    sql,
    maxRows: options.maxRows ?? 1000,
    privateSession: true,
    confirm: options.confirm ?? profile.name,
    parameters: options.parameters,
  })
}
function row(result: QueryResult): Record<string, Cell> {
  return Object.fromEntries(
    result.sets[0].columns.map((column, index) => [column.name, result.sets[0].rows[0][index]]),
  )
}
const tableInput = {
  connectionId: profile.id,
  schema: 'harbor',
  table,
  offset: 0,
  limit: 20,
  direction: 'asc' as const,
}

describe.skipIf(!integration)('real MySQL 8.4 integration', () => {
  beforeAll(async () => {
    control = await mariadb.createConnection({
      host: '127.0.0.1',
      port: 13307,
      user: 'harbor',
      password: secrets.password,
      database: 'harbor',
      queryTimeout: 0,
    })
    expect(control.serverVersion()).toMatch(/^8\.4\./)
    const state = await service.connect(profile, secrets)
    expect(state.state, state.error).toBe('connected')
    expect(state.version).toMatch(/^8\.4\./)
    await control.query(
      `CREATE TABLE ${quote(table)} (id INTEGER PRIMARY KEY,label VARCHAR(200),big BIGINT,amount DECIMAL(30,9),data BLOB,payload JSON,nullable VARCHAR(20),created DATETIME(6)) ENGINE=InnoDB`,
    )
    await control.query(
      `INSERT INTO ${quote(table)} VALUES (1,'original',9007199254740993,12345678901234567890.123456789,UNHEX('00ff80'),'{"n":9007199254740993}',NULL,'2026-09-18 12:34:56.123456'),(2,'other',2,2,NULL,NULL,'',NULL)`,
    )
    await control.query(`CREATE TABLE ${quote(noKey)} (label VARCHAR(20)) ENGINE=InnoDB`)
    await control.query(
      `CREATE TABLE ${quote(myisam)} (id INTEGER PRIMARY KEY,label VARCHAR(20)) ENGINE=MyISAM`,
    )
    await control.query(
      `CREATE TABLE ${quote(quoted)} (${quote('key`id')} INTEGER PRIMARY KEY,${quote('quoted`label')} VARCHAR(20)) ENGINE=InnoDB`,
    )
    await control.query(`INSERT INTO ${quote(quoted)} VALUES (1,'quoted')`)
  })
  afterAll(async () => {
    await service.closeAll()
    if (control) {
      for (const name of [table, noKey, myisam, quoted])
        await control.query(`DROP TABLE IF EXISTS ${quote(name)}`)
      await control.end()
    }
  })

  it('uses real catalogs, native DDL and exact binary/text/JSON values', async () => {
    expect(await service.listDatabases(profile.id)).toContain('harbor')
    expect(await service.listObjects({ connectionId: profile.id, schema: 'harbor' })).toContainEqual(
      expect.objectContaining({ name: table, kind: 'table' }),
    )
    const structure = await service.structure({ connectionId: profile.id, schema: 'harbor', table })
    expect(structure.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true)
    expect(structure.indexes).toContainEqual(expect.objectContaining({ name: 'PRIMARY' }))
    expect(structure.ddl).toContain('ENGINE=InnoDB')
    const result = await query(
      `SELECT big,amount,data,payload,nullable,created,label AS duplicate,label AS duplicate FROM ${quote(table)} WHERE id=1`,
    )
    expect(result.sets[0].rows[0].slice(0, 6)).toEqual([
      '9007199254740993',
      '12345678901234567890.123456789',
      { type: 'binary', base64: 'AP+A' },
      '{"n": 9007199254740993}',
      null,
      '2026-09-18 12:34:56.123456',
    ])
    expect(result.sets[0].columns.slice(-2).map((column) => column.name)).toEqual(['duplicate', 'duplicate'])
  })

  it('binds parameters natively, preserves literal precision, and rejects script binding', async () => {
    const parameters: QueryParameter[] = [
      { name: 'text', type: 'text', value: "quote'; SELECT 99; --", secret: false },
      { name: 'integer', type: 'integer', value: '9007199254740993', secret: false },
      { name: 'decimal', type: 'decimal', value: '12345678901234567890.123456789', secret: false },
      { name: 'binary', type: 'binary', value: 'AP+A', secret: false },
      { name: 'json', type: 'json', value: '{"n":9007199254740993}', secret: false },
      { name: 'null', type: 'null', value: '', secret: false },
    ]
    const result = await query(
      'SELECT ?,CAST(? AS SIGNED),CAST(? AS DECIMAL(30,9)),CAST(? AS BINARY),CAST(? AS JSON),?',
      'parameters',
      { parameters },
    )
    expect(result.sets[0].rows[0]).toEqual([
      parameters[0].value,
      parameters[1].value,
      parameters[2].value,
      { type: 'binary', base64: 'AP+A' },
      '{"n": 9007199254740993}',
      null,
    ])
    await expect(
      query('SELECT ?; SELECT 2', 'parameters', { parameters: parameters.slice(0, 1) }),
    ).rejects.toThrow('exactly one statement')
    const secret = 'private-never-echoed-in-error'
    await expect(
      query('SELECT CAST(? AS JSON)', 'parameters', {
        parameters: [{ name: 'private', type: 'text', value: secret, secret: true }],
      }),
    ).rejects.toThrow('private parameter')
  })

  it('retains multiple results, affected rows, and bounded output', async () => {
    const result = await query(
      `SELECT 11 AS one; UPDATE ${quote(table)} SET label='original' WHERE id=1; SELECT 22 AS two`,
    )
    expect(result.sets).toHaveLength(3)
    expect(String(result.sets[0].rows[0][0])).toBe('11')
    expect(result.sets[1].affectedRows).toBe(1)
    expect(String(result.sets[2].rows[0][0])).toBe('22')
    const limited = await query(`SELECT * FROM ${quote(table)} ORDER BY id`, 'bounded', { maxRows: 1 })
    expect(limited.sets[0].rows).toHaveLength(1)
    expect(limited.sets[0].truncated).toBe(true)
    const large = await query("SELECT REPEAT('x',9000000)", 'bounded')
    expect(large.sets[0].rows).toHaveLength(0)
    expect(large.sets[0].truncated).toBe(true)
  })

  it('parameterizes table filters, quotes identifiers, and uses stable page ordering', async () => {
    const first = await service.table({ ...tableInput, sessionId: 'browse', limit: 1 })
    const next = await service.table({ ...tableInput, sessionId: 'browse', offset: 1, limit: 1 })
    expect(row(first).id).toBe(1)
    expect(row(next).id).toBe(2)
    const injection = await service.table({
      ...tableInput,
      sessionId: 'browse',
      filter: { column: 'label', operator: 'equals', value: "x' OR 1=1 --" },
    })
    expect(injection.sets[0].rows).toHaveLength(0)
    const escaped = await service.table({
      ...tableInput,
      table: quoted,
      sessionId: 'quoted',
      filter: { column: 'quoted`label', operator: 'equals', value: 'quoted' },
    })
    expect(row(escaped)['key`id']).toBe(1)
  })

  it('isolates tab transactions and rolls back writes on session close', async () => {
    expect(
      (await service.transaction({ connectionId: profile.id, sessionId: 'tx', action: 'begin' })).state,
    ).toBe('open')
    expect((await query(`UPDATE ${quote(table)} SET label='pending' WHERE id=1`, 'tx')).transaction).toBe(
      'open',
    )
    expect((await query(`SELECT label FROM ${quote(table)} WHERE id=1`, 'outside')).sets[0].rows[0][0]).toBe(
      'original',
    )
    await service.closeSession({ connectionId: profile.id, sessionId: 'tx' })
    expect((await query(`SELECT label FROM ${quote(table)} WHERE id=1`, 'outside')).sets[0].rows[0][0]).toBe(
      'original',
    )
    await query('START TRANSACTION', 'raw-tx')
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'raw-tx' }).state).toBe('open')
    expect((await query('ROLLBACK', 'raw-tx')).transaction).toBe('idle')
  })

  it('applies reviewed edits atomically and detects stale rows', async () => {
    const original = row(
      await service.table({
        ...tableInput,
        sessionId: 'edit',
        filter: { column: 'id', operator: 'equals', value: '1' },
      }),
    )
    expect(
      await service.applyEdits({
        connectionId: profile.id,
        sessionId: 'edit',
        schema: 'harbor',
        table,
        changes: [{ kind: 'update', original, values: { label: "quote'; SELECT 99; --" } }],
      }),
    ).toEqual({ affectedRows: 1 })
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'edit',
        schema: 'harbor',
        table,
        changes: [
          { kind: 'insert', values: { id: 3, label: 'must roll back' } },
          { kind: 'delete', original, values: {} },
        ],
      }),
    ).rejects.toThrow('Conflict')
    expect((await query(`SELECT * FROM ${quote(table)} WHERE id=3`)).sets[0].rows).toHaveLength(0)
    await query(`UPDATE ${quote(table)} SET label='original' WHERE id=1`)
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'no-key',
        schema: 'harbor',
        table: noKey,
        changes: [{ kind: 'insert', values: { label: 'blocked' } }],
      }),
    ).rejects.toThrow('primary key')
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'myisam',
        schema: 'harbor',
        table: myisam,
        changes: [{ kind: 'insert', values: { id: 1 } }],
      }),
    ).rejects.toThrow('InnoDB')
  })

  it('enforces read-only mode, production confirmation, and server permissions', async () => {
    const readonly = { ...profile, id: 'mysql-readonly', readOnly: true }
    expect((await service.connect(readonly, secrets)).state).toBe('connected')
    expect((await query('SELECT 1', 'ro', { connectionId: readonly.id })).sets[0].rows).toHaveLength(1)
    await expect(
      query(`UPDATE ${quote(table)} SET label='bad' WHERE id=1`, 'ro', { connectionId: readonly.id }),
    ).rejects.toThrow('read-only')
    await expect(
      query('COMMIT; DELETE FROM ' + quote(table), 'ro', { connectionId: readonly.id }),
    ).rejects.toThrow('read-only')
    const production = { ...profile, id: 'mysql-production', environment: 'production' }
    expect((await service.connect(production, secrets)).state).toBe('connected')
    await expect(
      query(`UPDATE ${quote(table)} SET label='bad' WHERE id=1`, 'production', {
        connectionId: production.id,
        confirm: '',
      }),
    ).rejects.toThrow('confirm')
    await expect(query('SELECT * FROM mysql.user', 'permission')).rejects.toThrow(/denied/i)
    await service.disconnect(readonly.id)
    await service.disconnect(production.id)
  })

  it('reports real bad credentials and rejects a mismatched selected engine', async () => {
    const failed = await service.connect(
      { ...profile, id: 'mysql-bad' },
      { password: 'wrong_private_password' },
    )
    expect(failed.state).toBe('failed')
    expect(failed.error).not.toContain('wrong_private_password')
    const mismatch = await service.connect({ ...profile, id: 'mysql-mismatch', engine: 'mariadb' }, secrets)
    expect(mismatch.state).toBe('failed')
    expect(mismatch.error).toContain('matching engine')
    expect(service.status(profile.id).state).toBe('connected')
  })

  it('supports a server profile without a default database while requiring an explicit catalog to browse', async () => {
    const server = { ...profile, id: 'mysql-server', database: '' }
    expect((await service.connect(server, secrets)).state).toBe('connected')
    expect(await service.listDatabases(server.id)).toContain('harbor')
    await expect(service.listObjects({ connectionId: server.id })).rejects.toThrow('Choose a database')
    expect(await service.listObjects({ connectionId: server.id, schema: 'harbor' })).toContainEqual(
      expect.objectContaining({ name: table }),
    )
    expect(
      (
        await query(`SELECT label FROM harbor.${quote(table)} WHERE id=1`, 'server', {
          connectionId: server.id,
        })
      ).sets[0].rows[0][0],
    ).toBe('original')
    await expect(
      query(`SELECT * FROM ${quote(table)}`, 'server', { connectionId: server.id }),
    ).rejects.toThrow(/No database selected/i)
    await service.disconnect(server.id)
  })

  it('imports reviewed CSV rows and exports actual MySQL result values without numeric coercion', async () => {
    const structure = await service.structure({ connectionId: profile.id, schema: 'harbor', table })
    const csv = parseCsv(
      'id,label,big,amount,nullable\n41,"quoted, label",9007199254740993,12345678901234567890.123456789,\\N',
    )
    const changes = prepareCsvInserts(csv, csv.headers, structure.columns)
    expect(
      await service.applyEdits({
        connectionId: profile.id,
        sessionId: 'csv',
        schema: 'harbor',
        table,
        changes,
      }),
    ).toEqual({ affectedRows: 1 })
    const result = await query(`SELECT id,label,big,amount,nullable FROM ${quote(table)} WHERE id=41`, 'csv')
    expect(result.sets[0].rows[0]).toEqual([
      41,
      'quoted, label',
      '9007199254740993',
      '12345678901234567890.123456789',
      null,
    ])
    const directory = await mkdtemp(join(tmpdir(), 'harbor-mysql-export-'))
    try {
      const path = join(directory, 'results.csv')
      await exportLoadedData(path, {
        format: 'csv',
        columns: result.sets[0].columns,
        rows: result.sets[0].rows,
        spreadsheetSafe: true,
        scope: 'loaded rows',
      })
      expect(parseCsv(await readFile(path, 'utf8')).rows[0]).toEqual([
        '41',
        'quoted, label',
        '9007199254740993',
        '12345678901234567890.123456789',
        null,
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
      await query(`DELETE FROM ${quote(table)} WHERE id=41`, 'csv')
    }
  })

  it('cancels the actual query on a separate control socket and preserves other tabs', async () => {
    const requestId = crypto.randomUUID()
    const running = service.execute({
      connectionId: profile.id,
      sessionId: 'cancel',
      requestId,
      sql: `SELECT SLEEP(10),id FROM ${quote(table)}`,
      maxRows: 10,
      privateSession: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      (await service.cancel({ connectionId: profile.id, sessionId: 'cancel', requestId })).requested,
    ).toBe(true)
    const result = await running
    expect(result.cancelled).toBe(true)
    expect((await query('SELECT 1', 'unrelated')).sets[0].rows).toHaveLength(1)
    expect(
      (await service.cancel({ connectionId: profile.id, sessionId: 'cancel', requestId })).requested,
    ).toBe(false)
  })

  it('uses the server SELECT timeout and preserves its session', async () => {
    const timed = { ...profile, id: 'mysql-select-timeout', queryTimeout: 1000 }
    expect((await service.connect(timed, secrets)).state).toBe('connected')
    const started = performance.now()
    // Including a table makes interruption an error; SELECT SLEEP() alone can return 1.
    await expect(
      query(`SELECT SLEEP(5),id FROM ${quote(table)}`, 'timed', { connectionId: timed.id }),
    ).rejects.toThrow(/time|interrupted/i)
    expect(performance.now() - started).toBeLessThan(4500)
    expect((await query('SELECT 1', 'timed', { connectionId: timed.id })).sets[0].rows).toHaveLength(1)
    await service.disconnect(timed.id)
  })

  it('bounds other statements by closing the session without replaying or restoring transactions', async () => {
    const timed = { ...profile, id: 'mysql-write-timeout', queryTimeout: 1000 }
    expect((await service.connect(timed, secrets)).state).toBe('connected')
    await service.transaction({ connectionId: timed.id, sessionId: 'timed', action: 'begin' })
    await query(`UPDATE ${quote(table)} SET label='uncommitted' WHERE id=1`, 'timed', {
      connectionId: timed.id,
    })
    await expect(query('DO SLEEP(5)', 'timed', { connectionId: timed.id })).rejects.toThrow(
      'No operation was replayed',
    )
    expect(service.getSessionState({ connectionId: timed.id, sessionId: 'timed' }).connected).toBe(false)
    await expect(query('SELECT 1', 'timed', { connectionId: timed.id })).rejects.toThrow('not restored')
    const secretTimeout = query('DO SLEEP(?)', 'private-timeout', {
      connectionId: timed.id,
      parameters: [{ name: 'private-delay', type: 'integer', value: '5', secret: true }],
    })
    await expect(secretTimeout).rejects.toThrow('private parameter')
    await expect(secretTimeout).rejects.toThrow('A write may have reached the server')
    await expect(secretTimeout).rejects.toThrow('No operation was replayed')
    expect((await query(`SELECT label FROM ${quote(table)} WHERE id=1`, 'outside')).sets[0].rows[0][0]).toBe(
      'original',
    )
    await service.disconnect(timed.id)
  })

  it('does not silently reopen a killed session', async () => {
    const pid = Number((await query('SELECT CONNECTION_ID()', 'killed')).sets[0].rows[0][0])
    await control!.query(`KILL CONNECTION ${pid}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(query('SELECT 1', 'killed')).rejects.toThrow(/ended|closed|lost|socket/i)
    expect((await query('SELECT 1', 'unrelated')).sets[0].rows).toHaveLength(1)
  })
})
