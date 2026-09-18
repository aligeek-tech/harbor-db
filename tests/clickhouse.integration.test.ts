import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportService } from '../src/main/persistence/transfer-imports'
import { TransferService } from '../src/main/persistence/transfers'
import { importOptionsSchema } from '../src/shared/imports'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, ClickHouseLogLevel } from '@clickhouse/client'
import { randomUUID } from 'node:crypto'
import { ClickhouseService } from '../src/main/engines/clickhouse'
import { profileSchema, type QueryResult } from '../src/shared/contracts'
import { clickhouseQuote } from '../src/shared/clickhouse'

const enabled = process.env.HARBOR_CLICKHOUSE === '1'
const profile = profileSchema.parse({
  id: 'clickhouse-checks',
  name: 'Disposable ClickHouse',
  engine: 'clickhouse',
  host: '127.0.0.1',
  port: 18123,
  username: 'harbor',
  database: 'harbor',
  readOnly: false,
  queryTimeout: 15000,
})
const secrets = { password: 'harbor_test' },
  service = new ClickhouseService(),
  admin = createClient({
    url: 'http://127.0.0.1:18123',
    username: 'harbor',
    password: secrets.password,
    database: 'harbor',
    log: { level: ClickHouseLogLevel.OFF },
  })
const table = 'clickhouse_' + randomUUID().replaceAll('-', ''),
  other = 'clickhouse_other_' + randomUUID().replaceAll('-', ''),
  quoted = 'clickhouse_`\\_' + randomUUID().replaceAll('-', '')
const execute = (
  sql: string,
  sessionId = 'query',
  extra: Partial<Parameters<typeof service.execute>[0]> = {},
) =>
  service.execute({
    connectionId: profile.id,
    sessionId,
    requestId: randomUUID(),
    sql,
    maxRows: 1000,
    privateSession: true,
    ...extra,
  })
function row(result: QueryResult) {
  return Object.fromEntries(
    result.sets[0].columns.map((column, index) => [column.name, result.sets[0].rows[0][index]]),
  )
}
const target = {
  connectionId: profile.id,
  schema: 'harbor',
  table,
  columns: ['id', 'amount', 'data', 'label'],
  consentNonTransactionalAppend: true as const,
}
describe.skipIf(!enabled)('real ClickHouse 26.3 HTTP adapter', () => {
  beforeAll(async () => {
    const status = await service.connect(profile, secrets)
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toMatch(/^ClickHouse 26\.3/)
    await admin.command({
      query: `CREATE TABLE ${clickhouseQuote(table)} (id UInt64,amount Decimal(38,9),data String,label Nullable(String),created DateTime64(9,'UTC') DEFAULT now64(9),token UUID DEFAULT generateUUIDv4()) ENGINE=MergeTree ORDER BY id PARTITION BY intDiv(id,100)`,
    })
    await admin.command({
      query: `CREATE TABLE ${clickhouseQuote(quoted)} (\`odd\\\`name\` String) ENGINE=MergeTree ORDER BY tuple()`,
    })
    await admin.command({ query: `CREATE DATABASE ${clickhouseQuote(other)}` })
    await admin.command({
      query: `INSERT INTO ${clickhouseQuote(table)} (id,amount,data,label,created) VALUES(9007199254740993,12345678901234567890.123456789,unhex('00ff80'),NULL,'2026-09-18 12:34:56.123456789'),(2,2,'hello','literal\\\\N','2026-09-18 12:34:56.123456789')`,
    })
  }, 30000)
  afterAll(async () => {
    await service.closeAll()
    for (const name of [table, quoted])
      await admin.command({ query: `DROP TABLE IF EXISTS ${clickhouseQuote(name)} SYNC` })
    await admin.command({ query: `DROP DATABASE IF EXISTS ${clickhouseQuote(other)} SYNC` })
    await admin.close()
  })
  it('preserves UInt64, Decimal, DateTime64 nanoseconds, null, binary and duplicate labels', async () => {
    const value = row(await execute(`SELECT * FROM ${clickhouseQuote(table)} WHERE id=9007199254740993`))
    expect(value.id).toBe('9007199254740993')
    expect(value.amount).toBe('12345678901234567890.123456789')
    expect(value.created).toBe('2026-09-18 12:34:56.123456789')
    expect(value.label).toBeNull()
    expect(value.data).toEqual({ type: 'binary', base64: 'AP+A' })
    const duplicate = await execute(
      'SELECT a.value,b.value FROM (SELECT 1 AS value) a CROSS JOIN (SELECT 2 AS value) b',
    )
    expect(duplicate.sets[0].columns.map((column) => column.name)).toEqual(['value', 'b.value'])
    expect(duplicate.sets[0].rows).toEqual([['1', '2']])
  })
  it('binds native parameters without exposing private conversion errors', async () => {
    expect(
      row(
        await execute('SELECT {number:UInt64} AS n', 'parameters', {
          parameters: [{ name: 'number', type: 'integer', secret: true, value: '9007199254740993' }],
        }),
      ).n,
    ).toBe('9007199254740993')
    await expect(
      execute('SELECT {value:UInt8}', 'private', {
        parameters: [{ name: 'value', type: 'text', secret: true, value: 'DO_NOT_ECHO_PRIVATE' }],
      }),
    ).rejects.not.toThrow('DO_NOT_ECHO_PRIVATE')
  })
  it('browses database catalogs, real native keys and quoted identifiers', async () => {
    expect(await service.listDatabases(profile.id)).toContain(other)
    expect(
      (await service.listObjects({ connectionId: profile.id })).some(
        (object) => object.name === table && object.schema === 'harbor',
      ),
    ).toBe(true)
    const structure = await service.structure({ ...target })
    expect(structure.ddl).toContain('MergeTree')
    expect(structure.indexes.find((index) => index.name === 'Partition key')?.definition).toContain('intDiv')
    expect(structure.columns.every((column) => !column.primaryKey)).toBe(true)
    expect((await service.structure({ ...target, table: quoted })).columns[0].name).toBe('odd`name')
    const filtered = await service.table({
      ...target,
      sessionId: 'browse',
      offset: 0,
      limit: 20,
      direction: 'asc',
      filters: {
        match: 'all',
        conditions: [{ column: 'id', operator: 'equals', value: '9007199254740993' }],
      },
    })
    expect(filtered.sets[0].rows).toHaveLength(1)
    expect(filtered.tableQuery?.sql).toContain('{filter0:String}')
  })
  it('binds tabs to their database and rejects mutation/session/format overrides', async () => {
    await execute('SELECT currentDatabase()', 'bound')
    await expect(execute('SELECT 1', 'bound', { database: other })).rejects.toThrow('another database')
    for (const sql of [
      'INSERT INTO x VALUES(1)',
      'SELECT 1; SELECT 2',
      'SELECT 1 SETTINGS readonly=0',
      "BACKUP TABLE x TO Disk('x','x')",
      'SELECT 1 FORMAT JSON',
      'SELECT 1 WITH TOTALS',
    ])
      await expect(execute(sql)).rejects.toThrow()
  })
  it('bounds loaded rows and streams all requested rows with backpressure', async () => {
    const limited = await execute('SELECT number FROM numbers(10000)', 'limit', { maxRows: 5 })
    expect(limited.sets[0].rows).toHaveLength(5)
    expect(limited.sets[0].truncated).toBe(true)
    let count = 0
    await service.streamQuery(
      { connectionId: profile.id, sql: 'SELECT number FROM numbers(20000)' },
      {
        signal: new AbortController().signal,
        onColumns: async (columns) => expect(columns[0].type).toBe('UInt64'),
        onRow: async () => {
          count++
          if (count % 1000 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
        },
      },
    )
    expect(count).toBe(20000)
  })
  it('cancels native query_id and does not leave server work running', async () => {
    const pending = execute('SELECT sleepEachRow(0.0001) FROM numbers(1000000000)', 'cancel')
    void pending.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    await service.cancel({ connectionId: profile.id, sessionId: 'cancel' })
    expect((await pending).cancelled).toBe(true)
    const result = await admin.query({
      query:
        "SELECT count() AS n FROM system.processes WHERE user='harbor' AND startsWith(query,'SELECT sleepEachRow')",
      format: 'JSONEachRow',
    })
    expect((await result.json<{ n: number }>())[0].n).toBe(0)
  })
  it('rejects late stream errors and oversized rows as incomplete', async () => {
    let rows = 0
    await expect(
      service.streamQuery(
        {
          connectionId: profile.id,
          sql: "SELECT number,repeat('x',100),throwIf(number=900000, 'fixture late error') FROM numbers(1000000)",
        },
        {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async () => {
            rows++
          },
        },
      ),
    ).rejects.toThrow('interrupted')
    // Native server errors must never finalize a partial stream.
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(1000000)
    await expect(
      execute("SELECT arrayStringConcat(arrayMap(x->repeat('x',1000000),range(9)),'')"),
    ).rejects.toThrow('8 MiB')
  })
  it('provides native explain and exact CREATE inspection', async () => {
    const inspected = await service.inspectObject({ ...target, name: table, kind: 'table' })
    expect(inspected.definition?.source).toBe('server')
    expect(inspected.properties.find((property) => property.name === 'engine')?.value).toBe('MergeTree')
    expect(
      (
        await service.explain({
          connectionId: profile.id,
          sessionId: 'plan',
          requestId: randomUUID(),
          sql: `SELECT * FROM ${clickhouseQuote(table)} WHERE id=2`,
          mode: 'estimate',
        })
      ).raw,
    ).toContain('ReadFromMergeTree')
  })
  it('requires append consent and acknowledges real append batches without transaction claims', async () => {
    await expect(
      service.openImport(
        { ...target, consentNonTransactionalAppend: undefined },
        new AbortController().signal,
      ),
    ).rejects.toThrow('confirmation')
    const writer = await service.openImport(target, new AbortController().signal)
    expect(writer.commitModel).toBe('append')
    await writer.writeBatch([
      ['42', '12345678901234567890.123456789', { type: 'binary', base64: 'AP+A' }, null],
    ])
    await writer.close()
    const value = row(await execute(`SELECT * FROM ${clickhouseQuote(table)} WHERE id=42`))
    expect(value.amount).toBe('12345678901234567890.123456789')
    expect(value.data).toEqual({ type: 'binary', base64: 'AP+A' })
    expect(value.label).toBeNull()
  })
  it('prevents silent decimal rounding and integer wrapping before dispatch', async () => {
    const writer = await service.openImport(target, new AbortController().signal)
    try {
      await expect(writer.writeBatch([['18446744073709551616', '1', 'x', 'bad']])).rejects.toMatchObject({
        outcome: 'rolled-back',
      })
      await expect(writer.writeBatch([['43', '1.0000000001', 'x', 'bad']])).rejects.toMatchObject({
        outcome: 'rolled-back',
      })
      expect(row(await execute(`SELECT count() AS n FROM ${clickhouseQuote(table)} WHERE id=43`)).n).toBe('0')
    } finally {
      await writer.close()
    }
  })
  it('preserves imported nanoseconds and rejects timestamp precision loss before dispatch', async () => {
    const writer = await service.openImport(
      { ...target, columns: [...target.columns, 'created'] },
      new AbortController().signal,
    )
    try {
      await writer.writeBatch([['45', '1', 'time', null, '2026-09-18T12:34:56.123456789Z']])
      expect(row(await execute(`SELECT created FROM ${clickhouseQuote(table)} WHERE id=45`)).created).toBe(
        '2026-09-18 12:34:56.123456789',
      )
      await expect(
        writer.writeBatch([['46', '1', 'time', null, '2026-09-18T12:34:56.1234567891Z']]),
      ).rejects.toMatchObject({ outcome: 'rolled-back' })
    } finally {
      await writer.close()
    }
  })
  it('reports failed dispatched append batches as uncertain without replay', async () => {
    const writer = await service.openImport(
      { ...target, columns: [...target.columns, 'token'] },
      new AbortController().signal,
    )
    try {
      await expect(writer.writeBatch([['44', '1', 'x', 'bad', 'not-a-uuid']])).rejects.toMatchObject({
        outcome: 'uncertain',
      })
      expect(
        Number(row(await execute(`SELECT count() AS n FROM ${clickhouseQuote(table)} WHERE id=44`)).n),
      ).toBeLessThanOrEqual(1)
    } finally {
      await writer.close()
    }
  })
  it('honors real read-only roles and propagates denied target access', async () => {
    const user = 'readonly_' + randomUUID().replaceAll('-', ''),
      id = 'readonly-profile'
    await admin.command({
      query: `CREATE USER ${clickhouseQuote(user)} IDENTIFIED BY 'fixture_only_password' SETTINGS readonly=1`,
    })
    try {
      await admin.command({
        query: `GRANT SELECT ON harbor.${clickhouseQuote(table)} TO ${clickhouseQuote(user)}`,
      })
      const status = await service.connect(
        { ...profile, id, username: user, readOnly: true },
        { password: 'fixture_only_password' },
      )
      expect(status.state, status.error).toBe('connected')
      expect(
        (await execute(`SELECT count() FROM ${clickhouseQuote(table)}`, 'role', { connectionId: id })).sets[0]
          .rows.length,
      ).toBe(1)
      await expect(
        service.openImport({ ...target, connectionId: id }, new AbortController().signal),
      ).rejects.toThrow('read-only')
      await expect(execute('SELECT * FROM system.users', 'denied', { connectionId: id })).rejects.toThrow(
        'denied',
      )
    } finally {
      await service.disconnect(id)
      await admin.command({ query: `DROP USER IF EXISTS ${clickhouseQuote(user)}` })
    }
  })

  it('runs the full CSV append pipeline with acknowledged progress and native streaming export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-clickhouse-jobs-')),
      imports = new ImportService(service),
      exports = new TransferService(service)
    try {
      const source = join(directory, 'input.csv')
      await writeFile(
        source,
        'id,amount,data,label\n' +
          Array.from({ length: 505 }, (_, i) => `${10000 + i},123.000000001,payload,\\N`).join('\n') +
          '\n',
      )
      const preview = await imports.previewImport(importOptionsSchema.parse({ format: 'csv' }), source)
      let job = await imports.startImport({
        connectionId: profile.id,
        schema: 'harbor',
        table,
        consentNonTransactionalAppend: true,
        sourceId: preview.sourceId,
        mapping: [
          { source: 0, target: 'id', type: 'integer' },
          { source: 1, target: 'amount', type: 'decimal' },
          { source: 2, target: 'data', type: 'text' },
          { source: 3, target: 'label', type: 'text' },
        ],
        batchSize: 100,
        errorPolicy: 'stop',
        consentBatchCommits: true,
      })
      const deadline = Date.now() + 15000
      while (job.state === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        job = imports.getJob(job.id)
      }
      expect(job.state, job.error).toBe('completed')
      expect(job.commitModel).toBe('append')
      expect(job.committedRows).toBe(505)
      expect(job.committedBatches).toBe(6)
      expect(job.rolledBackRows).toBe(0)
      const destination = join(directory, 'full.jsonl')
      let exported = await exports.startExport(
        {
          connectionId: profile.id,
          sql: `SELECT id,amount,data,label FROM ${clickhouseQuote(table)} WHERE id>=10000 AND id<10505 ORDER BY id`,
          format: 'jsonl',
          spreadsheetSafe: true,
          consentRerun: true,
        },
        destination,
      )
      while (exported.state === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        exported = exports.getJob(exported.id)
      }
      expect(exported.state, exported.error).toBe('completed')
      expect(exported.rows).toBe(505)
      expect(exported.consistency).toContain('no multi-table transactional snapshot')
      expect((await readFile(destination, 'utf8')).split('\n')[1]).toContain('123.000000001')
      const partial = join(directory, 'late-error.jsonl')
      let failed = await exports.startExport(
        {
          connectionId: profile.id,
          sql: "SELECT number,repeat('x',100),throwIf(number=900000,'fixture late error') FROM numbers(1000000)",
          format: 'jsonl',
          spreadsheetSafe: true,
          consentRerun: true,
        },
        partial,
      )
      const errorDeadline = Date.now() + 15000
      while (failed.state === 'running' && Date.now() < errorDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        failed = exports.getJob(failed.id)
      }
      expect(failed.state).toBe('failed')
      expect(failed.rows).toBeGreaterThan(0)
      await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(failed.partialPath!)).size).toBe(failed.bytes)
    } finally {
      await imports.closeAll()
      await exports.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
