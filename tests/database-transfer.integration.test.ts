import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { link, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { SqlService } from '../src/main/engines/sql'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'
import { DatabaseTransferService } from '../src/main/persistence/database-transfer'
import { openLocalImport } from '../src/main/persistence/local-import-writer'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import type {
  PreviewDatabaseTransferInput,
  StartDatabaseTransferInput,
} from '../src/shared/database-transfer'

const engines = ['postgres', 'sqlite', 'duckdb'] as const
describe.skipIf(process.env.HARBOR_TRANSFER !== '1')('real database transfer matrix', () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const sourceTable = `transfer_source_${suffix}`,
    targetTable = `transfer_target_${suffix}`
  const sql = new SqlService()
  let directory: string, sqlite: SqliteService, duckdb: DuckDBService, transfers: DatabaseTransferService
  const profiles = new Map<string, ConnectionProfile>()
  const connection = (engine: (typeof engines)[number], side: 'source' | 'target') =>
    profiles.get(`${engine}-${side}`)!
  const service = (profile: ConnectionProfile) =>
    profile.engine === 'postgres' ? sql : profile.engine === 'sqlite' ? sqlite : duckdb
  const query = (profile: ConnectionProfile, statement: string) =>
    service(profile).execute({
      connectionId: profile.id,
      sessionId: 'verify',
      database: profile.database || 'main',
      sql: statement,
      requestId: crypto.randomUUID(),
      privateSession: true,
      confirm: profile.name,
      maxRows: 2000,
    })
  const target = (profile: ConnectionProfile, table = targetTable) => ({
    connectionId: profile.id,
    database: profile.database || 'main',
    schema: profile.engine === 'postgres' ? 'public' : 'main',
    table,
  })
  const input = (
    source: ConnectionProfile,
    destination: ConnectionProfile,
    statement = `SELECT id,label,amount,bytes FROM ${sourceTable} ORDER BY id`,
    table = targetTable,
  ): PreviewDatabaseTransferInput => ({
    source: { connectionId: source.id, database: source.database || 'main', sql: statement },
    target: target(destination, table),
  })
  const mapping: StartDatabaseTransferInput['mapping'] = [
    { source: 0, target: 'id', type: 'integer' },
    { source: 1, target: 'label', type: 'text' },
    { source: 2, target: 'amount', type: 'decimal' },
    { source: 3, target: 'bytes', type: 'binary' },
  ]
  const wait = async (id: string) => {
    await expect.poll(() => transfers.get(id).state, { timeout: 30000, interval: 20 }).not.toBe('running')
    return transfers.get(id)
  }
  const transfer = async (
    request: PreviewDatabaseTransferInput,
    changes: Partial<StartDatabaseTransferInput> = {},
  ) => {
    const preview = await transfers.preview(request)
    return wait(
      (
        await transfers.start({
          token: preview.token,
          confirm: preview.confirmation,
          mapping,
          consentBatchCommits: true,
          consentRerun: true,
          batchSize: 2,
          maxRows: 10000,
          ...changes,
        })
      ).id,
    )
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-transfer-matrix-'))
    sqlite = new SqliteService(join(directory, 'private.sqlite'))
    duckdb = new DuckDBService(join(directory, 'private.sqlite'))
    for (const engine of engines)
      for (const side of ['source', 'target'] as const) {
        const profile = profileSchema.parse({
          id: `${engine}-${side}`,
          name: `Disposable ${engine} ${side}`,
          engine,
          host: '127.0.0.1',
          port: 15432,
          database: engine === 'postgres' ? 'harbor' : '',
          username: 'harbor',
          readOnly: false,
          sqlite: { path: join(directory, `${side}.sqlite`), mode: 'create' },
          duckdb: { path: join(directory, `${side}.duckdb`), mode: 'create' },
        })
        profiles.set(profile.id, profile)
        const status =
          engine === 'postgres'
            ? await sql.connect(profile, { password: 'harbor_test' })
            : await service(profile).connect(profile, {})
        expect(status.state, status.error).toBe('connected')
        const amount = engine === 'sqlite' ? 'TEXT' : 'DECIMAL(38,18)',
          bytes = engine === 'postgres' ? 'BYTEA' : 'BLOB'
        await query(
          profile,
          `CREATE TABLE ${side === 'source' ? sourceTable : targetTable} (id BIGINT PRIMARY KEY,label TEXT,amount ${amount},bytes ${bytes})`,
        )
        if (side === 'source') {
          const byteValue =
            engine === 'postgres'
              ? "decode('00ff80','hex')"
              : engine === 'sqlite'
                ? "X'00ff80'"
                : "'\\x00\\xFF\\x80'::BLOB"
          await query(
            profile,
            `INSERT INTO ${sourceTable} VALUES (9007199254740993,NULL,'12345678901234567890.123456789012345678',${byteValue}),(9007199254740994,'','0.000000000000000001',NULL),(9007199254740995,'hello,سلام','-1.500000000000000000',${byteValue})`,
          )
        }
      }
    transfers = new DatabaseTransferService({
      profile: (id) => profiles.get(id)!,
      structure: (value) => service(profiles.get(value.connectionId)!).structure(value),
      streamQuery: (value, sink) => service(profiles.get(value.connectionId)!).streamQuery(value, sink),
      openImport: (value, signal) => {
        const profile = profiles.get(value.connectionId)!
        return profile.engine === 'postgres'
          ? sql.openImport(value, signal)
          : openLocalImport(service(profile) as SqliteService | DuckDBService, profile, value, signal)
      },
    })
  })
  afterAll(async () => {
    await transfers?.closeAll()
    for (const name of [
      sourceTable,
      targetTable,
      `${targetTable}_generated`,
      `${targetTable}_slow`,
      `${targetTable}_narrow`,
    ])
      await query(connection('postgres', 'target'), `DROP TABLE IF EXISTS ${name}`).catch(() => undefined)
    await query(connection('postgres', 'target'), `DROP FUNCTION IF EXISTS ${targetTable}_delay()`).catch(
      () => undefined,
    )
    await Promise.allSettled([sql.closeAll(), sqlite?.closeAll(), duckdb?.closeAll()])
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  for (const from of engines)
    for (const to of engines)
      it(`${from} → ${to}: preserves exact integer/decimal/binary/NULL/empty values with independent commits`, async () => {
        const source = connection(from, 'source'),
          destination = connection(to, 'target')
        await query(destination, `DELETE FROM ${targetTable}`)
        const result = await transfer(input(source, destination))
        expect(result.state, result.error).toBe('completed')
        expect(result.committedRows).toBe(3)
        expect(result.committedBatches).toBe(2)
        const rows = (
          await query(destination, `SELECT id,label,amount,bytes FROM ${targetTable} ORDER BY id`)
        ).sets[0].rows
        expect(rows).toEqual([
          [
            '9007199254740993',
            null,
            '12345678901234567890.123456789012345678',
            { type: 'binary', base64: 'AP+A' },
          ],
          ['9007199254740994', '', '0.000000000000000001', null],
          ['9007199254740995', 'hello,سلام', '-1.500000000000000000', { type: 'binary', base64: 'AP+A' }],
        ])
      })
  for (const engine of engines)
    it(`${engine}: leaves prior batch committed and confirms rollback of a conflicting batch without replay`, async () => {
      const destination = connection(engine, 'target')
      await query(destination, `DELETE FROM ${targetTable}`)
      const result = await transfer(
        input(
          connection('postgres', 'source'),
          destination,
          "SELECT n::text AS id,'private-transfer-value'::text AS label FROM (VALUES(1,1),(2,2),(3,3),(4,1),(5,5)) v(ord,n) ORDER BY ord",
        ),
        { mapping: mapping.slice(0, 2) },
      )
      expect(result).toMatchObject({
        state: 'failed',
        committedRows: 2,
        committedBatches: 1,
        rolledBackRows: 2,
        uncertainRows: 0,
      })
      expect((await query(destination, `SELECT id FROM ${targetTable} ORDER BY id`)).sets[0].rows).toEqual([
        ['1'],
        ['2'],
      ])
      expect(JSON.stringify(result)).not.toContain('private-transfer-value')
    })
  it('honors explicit row scope while streaming beyond the 20-row preview and refuses source writes', async () => {
    const source = connection('postgres', 'source'),
      destination = connection('sqlite', 'target')
    await query(destination, `DELETE FROM ${targetTable}`)
    const request = input(
      source,
      destination,
      "SELECT n::text AS id,'bounded'::text AS label FROM generate_series(1,1001) n",
    )
    const preview = await transfers.preview(request)
    expect(preview.rows).toHaveLength(20)
    const result = await wait(
      (
        await transfers.start({
          token: preview.token,
          confirm: preview.confirmation,
          mapping: mapping.slice(0, 2),
          consentBatchCommits: true,
          consentRerun: true,
          batchSize: 100,
          maxRows: 505,
        })
      ).id,
    )
    expect(result).toMatchObject({
      state: 'completed',
      committedRows: 505,
      committedBatches: 6,
      limitReached: true,
    })
    expect((await query(destination, `SELECT count(*) FROM ${targetTable}`)).sets[0].rows[0]).toEqual(['505'])
    await expect(
      transfers.preview(input(source, destination, `DELETE FROM ${sourceTable} RETURNING *`)),
    ).rejects.toThrow()
    expect((await query(source, `SELECT count(*) FROM ${sourceTable}`)).sets[0].rows[0]).toEqual(['3'])
  })
  it('omits PostgreSQL identity-always/generated columns, rejects overrides and detects schema changes after review', async () => {
    const source = connection('postgres', 'source'),
      destination = connection('postgres', 'target'),
      name = `${targetTable}_generated`
    await query(
      destination,
      `CREATE TABLE ${name} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,label TEXT NOT NULL,derived TEXT GENERATED ALWAYS AS (label || '!') STORED)`,
    )
    const request = input(source, destination, "SELECT 'generated'::text AS label", name),
      preview = await transfers.preview(request)
    expect(preview.targetColumns.find((column) => column.name === 'id')?.identity).toBe('always')
    await expect(
      transfers.start({
        token: preview.token,
        confirm: preview.confirmation,
        mapping: [{ source: 0, target: 'id', type: 'integer' }],
        consentBatchCommits: true,
        consentRerun: true,
        maxRows: 10,
        batchSize: 1,
      }),
    ).rejects.toThrow(/identity/)
    expect((await transfer(request, { mapping: [{ source: 0, target: 'label', type: 'text' }] })).state).toBe(
      'completed',
    )
    expect((await query(destination, `SELECT id,label,derived FROM ${name}`)).sets[0].rows[0]).toEqual([
      '1',
      'generated',
      'generated!',
    ])
    const stale = await transfers.preview(request)
    await query(destination, `ALTER TABLE ${name} ADD COLUMN later TEXT`)
    await expect(
      transfers.start({
        token: stale.token,
        confirm: stale.confirmation,
        mapping: [{ source: 0, target: 'label', type: 'text' }],
        consentBatchCommits: true,
        consentRerun: true,
        maxRows: 10,
        batchSize: 1,
      }),
    ).rejects.toThrow(/schema changed/)
  })
  it('cancels inside a real PostgreSQL trigger, rolls back current batch and retains earlier commits', async () => {
    const destination = connection('postgres', 'target'),
      name = `${targetTable}_slow`
    await query(
      destination,
      `CREATE TABLE ${name} (id BIGINT PRIMARY KEY,label TEXT); CREATE FUNCTION ${targetTable}_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$; CREATE TRIGGER delay BEFORE INSERT ON ${name} FOR EACH ROW EXECUTE FUNCTION ${targetTable}_delay()`,
    )
    const preview = await transfers.preview(
      input(
        connection('postgres', 'source'),
        destination,
        "SELECT n::text AS id,'slow'::text AS label FROM generate_series(1,100) n",
        name,
      ),
    )
    const job = await transfers.start({
      token: preview.token,
      confirm: preview.confirmation,
      mapping: mapping.slice(0, 2),
      consentBatchCommits: true,
      consentRerun: true,
      maxRows: 100,
      batchSize: 2,
    })
    await expect.poll(() => transfers.get(job.id).committedRows).toBe(2)
    await expect.poll(() => transfers.get(job.id).rowsRead).toBeGreaterThanOrEqual(4)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = performance.now()
    transfers.cancel(job.id)
    const result = await wait(job.id)
    expect(result).toMatchObject({
      state: 'cancelled',
      committedRows: 2,
      rolledBackRows: 2,
      uncertainRows: 0,
    })
    expect(performance.now() - started).toBeLessThan(5000)
    expect((await query(destination, `SELECT id FROM ${name} ORDER BY id`)).sets[0].rows).toEqual([
      ['1'],
      ['2'],
    ])
  })
  it('rejects a hard-linked alias of the source file before opening any destination session', async () => {
    const source = connection('sqlite', 'source'),
      alias = join(directory, 'hard-linked-source.sqlite')
    await link(source.sqlite.path, alias)
    const duplicate = {
      ...source,
      id: 'sqlite-alias',
      name: 'Source alias',
      sqlite: { ...source.sqlite, path: alias },
    }
    profiles.set(duplicate.id, duplicate)
    try {
      await expect(transfers.preview(input(source, duplicate))).rejects.toThrow(/same local database file/)
    } finally {
      profiles.delete(duplicate.id)
    }
  })
  it('uses SQLite generated values when omitted and rejects DuckDB generated destinations explicitly', async () => {
    const source = connection('postgres', 'source'),
      destination = connection('sqlite', 'target'),
      name = `${targetTable}_generated`
    await query(
      destination,
      `CREATE TABLE ${name} (id INTEGER PRIMARY KEY,label TEXT,derived TEXT GENERATED ALWAYS AS (label || '!') STORED)`,
    )
    expect(
      (
        await transfer(input(source, destination, "SELECT 'sqlite generated'::text AS label", name), {
          mapping: [{ source: 0, target: 'label', type: 'text' }],
        })
      ).state,
    ).toBe('completed')
    expect((await query(destination, `SELECT id,label,derived FROM ${name}`)).sets[0].rows[0]).toEqual([
      '1',
      'sqlite generated',
      'sqlite generated!',
    ])
    const duck = connection('duckdb', 'target')
    await query(
      duck,
      `CREATE TABLE ${name} (id BIGINT,label VARCHAR,derived VARCHAR GENERATED ALWAYS AS (label || '!'))`,
    )
    await expect(
      transfers.preview(input(source, duck, "SELECT 'generated'::text AS label", name)),
    ).rejects.toThrow(/generated columns/)
  })
  it('reports actual lost COMMIT acknowledgement as uncertain without replaying a transfer batch', async () => {
    const destination = connection('postgres', 'target')
    await query(destination, `DELETE FROM ${targetTable}`)
    const sockets = new Set<net.Socket>()
    let cut = false,
      commits = 0
    const proxy = net.createServer((client) => {
      const upstream = net.connect(destination.port, '127.0.0.1')
      sockets.add(client)
      sockets.add(upstream)
      client.on('error', () => {})
      upstream.on('error', () => client.destroy())
      client.on('close', () => {
        sockets.delete(client)
        upstream.destroy()
      })
      upstream.on('close', () => {
        sockets.delete(upstream)
        client.destroy()
      })
      let commit = false
      client.on('data', (chunk) => {
        if (chunk.includes(Buffer.from('COMMIT'))) {
          commit = true
          commits++
        }
        upstream.write(chunk)
      })
      upstream.on('data', (chunk) => {
        if (commit && !cut) {
          cut = true
          client.destroy()
          upstream.destroy()
        } else client.write(chunk)
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxied = { ...destination, id: 'target-ack-loss', port: (proxy.address() as net.AddressInfo).port }
    profiles.set(proxied.id, proxied)
    try {
      expect((await sql.connect(proxied, { password: 'harbor_test' })).state).toBe('connected')
      const result = await transfer(
        input(
          connection('postgres', 'source'),
          proxied,
          "SELECT n::text AS id,'uncertain'::text AS label FROM generate_series(1,5) n",
        ),
        { mapping: mapping.slice(0, 2) },
      )
      expect(cut).toBe(true)
      expect(commits).toBe(1)
      expect(result).toMatchObject({
        state: 'failed',
        committedRows: 0,
        uncertainRows: 2,
        rolledBackRows: 0,
        bufferedRows: 0,
      })
      expect((await query(destination, `SELECT id FROM ${targetTable} ORDER BY id`)).sets[0].rows).toEqual([
        ['1'],
        ['2'],
      ])
    } finally {
      await sql.disconnect(proxied.id)
      profiles.delete(proxied.id)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })
  for (const engine of ['postgres', 'duckdb'] as const)
    it(`${engine}: refuses narrowing decimal and floating-point destinations before any batch writes`, async () => {
      const destination = connection(engine, 'target'),
        name = `${targetTable}_narrow`
      await query(
        destination,
        `CREATE TABLE ${name} (amount DECIMAL(5,2),single_value REAL,double_value DOUBLE PRECISION)`,
      )
      const result = await transfer(
        input(connection('postgres', 'source'), destination, 'SELECT 0.123456789::numeric AS amount', name),
        { mapping: [{ source: 0, target: 'amount', type: 'decimal' }] },
      )
      expect(result).toMatchObject({ state: 'failed', committedRows: 0 })
      for (const [statement, field] of [
        ['SELECT 16777217::bigint AS value', 'single_value'],
        ['SELECT 9007199254740993::bigint AS value', 'double_value'],
      ]) {
        const narrowed = await transfer(
          input(connection('postgres', 'source'), destination, statement, name),
          { mapping: [{ source: 0, target: field, type: 'integer' }] },
        )
        expect(narrowed).toMatchObject({
          state: 'failed',
          committedRows: 0,
          uncertainRows: 0,
          rolledBackRows: 0,
        })
      }
      expect((await query(destination, `SELECT count(*) FROM ${name}`)).sets[0].rows[0]).toEqual(['0'])
    })
})
