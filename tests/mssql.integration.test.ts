import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Connection, Request } from 'tedious'
import { MssqlService } from '../src/main/engines/mssql'
import { profileSchema, type ConnectionProfile, type QueryInput } from '../src/shared/contracts'

// Opt in only to the separately authorized loopback disposable fixture. The
// private file contains newly generated credentials and is never checked in.
const privateFile = process.env.HARBOR_MSSQL_TEST_ENV_FILE
describe.skipIf(!privateFile)('real disposable SQL Server adapter', () => {
  let service: MssqlService
  let admin: Connection
  let profile: ConnectionProfile
  let password: string
  const database = 'harbor_test_' + randomUUID().replaceAll('-', '')
  async function raw(sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      admin.execSqlBatch(new Request(sql, (error) => (error ? reject(error) : resolve()))),
    )
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
  beforeAll(async () => {
    const text = await readFile(privateFile!, 'utf8')
    password = /^HARBOR_MSSQL_TEST_PASSWORD=(.+)$/m.exec(text)?.[1] || ''
    if (!password) throw new Error('Disposable SQL Server credential file is incomplete.')
    admin = new Connection({
      server: '127.0.0.1',
      authentication: { type: 'default', options: { userName: 'sa', password } },
      options: {
        port: 25433,
        database: 'master',
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 15000,
        requestTimeout: 15000,
        maxRetriesOnTransientErrors: 0,
      },
    })
    await new Promise<void>((resolve, reject) => {
      admin.once('connect', (e) => (e ? reject(e) : resolve()))
      admin.connect()
    })
    await raw(`CREATE DATABASE [${database}]`)
    await raw(`ALTER DATABASE [${database}] SET ALLOW_SNAPSHOT_ISOLATION ON`)
    service = new MssqlService()
    profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Disposable SQL Server',
      engine: 'mssql',
      host: '127.0.0.1',
      port: 25433,
      username: 'sa',
      database,
      schema: 'dbo',
      readOnly: false,
      queryTimeout: 10000,
      tls: { enabled: false, rejectUnauthorized: false },
    })
    const status = await service.connect(profile, { password })
    expect(status, status.error).toMatchObject({ state: 'connected' })
  }, 30000)
  afterAll(async () => {
    await service?.closeAll()
    if (admin) {
      try {
        await raw(`IF DB_ID(N'${database}') IS NOT NULL DROP DATABASE [${database}]`)
      } finally {
        admin.close()
      }
    }
  }, 30000)
  it('proves native server version and lossless duplicate integer/decimal/temporal/binary results', async () => {
    expect(service.status(profile.id).version).toContain('SQL Server 16.')
    const result = await query(
      "SELECT CAST(9223372036854775807 AS bigint) AS value,CAST(12345678901234567890.123456789 AS decimal(38,9)) AS value,CAST('2026-09-18T12:34:56.1234567+03:30' AS datetimeoffset(7)) AS offset_value,CAST('2026-09-18T12:34:56.1234567' AS datetime2(7)) AS time_value,CAST('12:34:56.1234567' AS time(7)) AS t,CAST(0x00FF AS varbinary(max)) AS b,CAST(NULL AS int) AS nil,CAST(1 AS bit) AS truth",
    )
    const set = result.sets.find((set) => set.columns.length)!
    expect(set.columns.slice(0, 2).map((c) => c.name)).toEqual(['value', 'value'])
    expect(set.rows[0]).toEqual([
      '9223372036854775807',
      '12345678901234567890.123456789',
      '2026-09-18 12:34:56.1234567 +03:30',
      '2026-09-18 12:34:56.1234567',
      '12:34:56.1234567',
      { type: 'binary', base64: 'AP8=' },
      null,
      true,
    ])
  })
  it('binds native parameter declarations exactly and does not echo private errors', async () => {
    const result = await query('SELECT @amount AS amount,@label AS label,@binary AS b,@clock AS t', {
      parameters: [
        { name: 'amount', type: 'decimal', value: '12345678901234567890.123456789', secret: false },
        { name: 'label', type: 'text', value: "quote'; SELECT 999; --", secret: false },
        { name: 'binary', type: 'binary', value: 'AP8=', secret: false },
        { name: 'clock', type: 'timestamp', value: '2026-09-18T12:34:56.1234567+03:30', secret: false },
      ],
    })
    expect(result.sets[0].rows[0]).toEqual([
      '12345678901234567890.123456789',
      "quote'; SELECT 999; --",
      { type: 'binary', base64: 'AP8=' },
      '2026-09-18 12:34:56.1234567 +03:30',
    ])
    await expect(
      query('SELECT CONVERT(int,@secret)', {
        parameters: [{ name: 'secret', type: 'text', value: 'private-do-not-print', secret: true }],
      }),
    ).rejects.toThrow('private parameter')
  })
  it('inspects catalog keys/indexes/views and pages with exact bound filters', async () => {
    await query(
      "CREATE TABLE dbo.parent(a int NOT NULL,b int NOT NULL,CONSTRAINT parent_pk PRIMARY KEY(a,b)); CREATE TABLE dbo.records(id int PRIMARY KEY,pa int,pb int,label nvarchar(200),amount decimal(38,9),CONSTRAINT related_parent FOREIGN KEY(pa,pb) REFERENCES dbo.parent(a,b),CONSTRAINT positive_id CHECK(id>0)); CREATE INDEX labels ON dbo.records(label) INCLUDE(amount); INSERT INTO dbo.parent VALUES(1,2); INSERT INTO dbo.records VALUES(1,1,2,N'100%_value',12345678901234567890.123456789),(2,NULL,NULL,N'other',1),(3,NULL,NULL,N'other',2)",
    )
    await query('CREATE VIEW dbo.record_view AS SELECT id,label FROM dbo.records')
    expect(await service.listDatabases(profile.id)).toContain(database)
    expect(await service.listObjects({ connectionId: profile.id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'dbo', name: 'records', kind: 'table' }),
        expect.objectContaining({ name: 'record_view', kind: 'view' }),
      ]),
    )
    const structure = await service.structure({ connectionId: profile.id, schema: 'dbo', table: 'records' })
    expect(structure.columns.find((c) => c.name === 'id')?.primaryKey).toBe(true)
    expect(structure.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ['pa', 'pb'],
        referencedSchema: 'dbo',
        referencedTable: 'parent',
        referencedColumns: ['a', 'b'],
      }),
    ])
    expect(structure.indexes.some((i) => i.name === 'labels' && i.definition.includes('INCLUDE'))).toBe(true)
    expect(structure.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'positive_id', definition: expect.stringMatching(/^CHECK /) }),
        expect.objectContaining({
          definition: expect.stringMatching(/^PRIMARY KEY CLUSTERED \(\[id\] ASC\)/),
        }),
        expect.objectContaining({
          name: 'related_parent',
          definition:
            'FOREIGN KEY ([pa], [pb]) REFERENCES [dbo].[parent] ([a], [b]) ON UPDATE NO ACTION ON DELETE NO ACTION',
        }),
      ]),
    )
    await query('ALTER TABLE dbo.parent ADD CONSTRAINT parent_unique UNIQUE(b,a)')
    expect(
      (await service.structure({ connectionId: profile.id, schema: 'dbo', table: 'parent' })).constraints,
    ).toContainEqual({ name: 'parent_unique', definition: 'UNIQUE NONCLUSTERED ([b] ASC, [a] ASC)' })
    const page = await service.table({
      connectionId: profile.id,
      sessionId: 'table-tab',
      schema: 'dbo',
      table: 'records',
      offset: 0,
      limit: 10,
      direction: 'asc',
      sorts: [{ column: 'amount', direction: 'desc' }],
      filters: {
        match: 'all',
        conditions: [
          { column: 'label', operator: 'contains', value: '%_' },
          { column: 'id', operator: 'greater than', value: '0' },
        ],
      },
    })
    expect(page.sets[0].rows).toHaveLength(1)
    expect(page.sets[0].rows[0][0]).toBe('1')
    expect(page.tableQuery?.sql).toContain('OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY')
    expect((await query(page.tableQuery!.editorSql)).sets[0].rows).toEqual(page.sets[0].rows)
  })
  it('isolates tab transactions and atomically rejects stale reviewed edits', async () => {
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'begin' })
    await query("INSERT INTO dbo.records(id,label) VALUES(4,N'pending')")
    expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tab-a' }).state).toBe('open')
    await service.transaction({ connectionId: profile.id, sessionId: 'tab-a', action: 'rollback' })
    expect((await query('SELECT COUNT(*) AS count FROM dbo.records WHERE id=4')).sets[0].rows[0][0]).toBe('0')
    const snapshot = (await query('SELECT * FROM dbo.records WHERE id=1')).sets[0]
    const original = Object.fromEntries(snapshot.columns.map((c, i) => [c.name, snapshot.rows[0][i]]))
    await query("UPDATE dbo.records SET label=N'changed' WHERE id=1", { sessionId: 'tab-b' })
    await expect(
      service.applyEdits({
        connectionId: profile.id,
        sessionId: 'edit-tab',
        schema: 'dbo',
        table: 'records',
        changes: [
          { kind: 'insert', values: { id: '5', label: 'must roll back' } },
          { kind: 'update', original, values: { label: 'stale' } },
        ],
      }),
    ).rejects.toThrow('Conflict')
    expect((await query('SELECT COUNT(*) AS count FROM dbo.records WHERE id=5')).sets[0].rows[0][0]).toBe('0')
    const current = (await query('SELECT * FROM dbo.records WHERE id=1')).sets[0]
    const fresh = Object.fromEntries(current.columns.map((c, i) => [c.name, current.rows[0][i]]))
    expect(
      await service.applyEdits({
        connectionId: profile.id,
        sessionId: 'edit-tab',
        schema: 'dbo',
        table: 'records',
        changes: [{ kind: 'update', original: fresh, values: { label: 'reviewed' } }],
      }),
    ).toEqual({ affectedRows: 1 })
  })
  it('acknowledges native cancellation, keeps transaction state truthful, and never replays', async () => {
    const requestId = randomUUID()
    const pending = query("WAITFOR DELAY '00:00:20'; INSERT INTO dbo.records(id,label) VALUES(6,N'never')", {
      requestId,
    })
    let cancellation = { requested: false, message: '' }
    for (let count = 0; count < 50 && !cancellation.requested; count++) {
      await new Promise((r) => setTimeout(r, 20))
      cancellation = await service.cancel({ connectionId: profile.id, sessionId: 'tab-a', requestId })
    }
    expect(cancellation.requested).toBe(true)
    expect(await pending).toMatchObject({ cancelled: true, transaction: 'idle' })
    expect((await query('SELECT COUNT(*) AS count FROM dbo.records WHERE id=6')).sets[0].rows[0][0]).toBe('0')
  }, 15000)
  it('streams all rows with backpressure in an independent snapshot and aborts cleanly', async () => {
    const sql =
      'SELECT TOP (3000) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b'
    expect((await query(sql, { maxRows: 2 })).sets[0]).toMatchObject({
      truncated: true,
      rows: [['1'], ['2']],
    })
    const controller = new AbortController()
    let rows = 0
    let inCallback = false
    await service.streamQuery(
      { connectionId: profile.id, sql },
      {
        signal: controller.signal,
        onColumns: async (columns) => {
          expect(columns[0].name).toBe('n')
        },
        onRow: async (row) => {
          expect(inCallback).toBe(false)
          inCallback = true
          rows++
          expect(row[0]).toBe(String(rows))
          if (rows % 100 === 0) await new Promise((r) => setTimeout(r, 1))
          inCallback = false
        },
      },
    )
    expect(rows).toBe(3000)
    const aborted = new AbortController()
    let count = 0
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql },
        {
          signal: aborted.signal,
          onColumns: async () => {},
          onRow: async () => {
            if (++count === 3) aborted.abort()
          },
        },
      ),
    ).rejects.toThrow(/cancel/i)
    expect(count).toBe(3)
    expect((await query('SELECT 1 AS healthy')).sets[0].rows).toEqual([['1']])
  }, 20000)
  it('fails closed for readonly writes, legacy precision loss and unavailable result descriptions', async () => {
    const readonly = { ...profile, id: randomUUID(), readOnly: true }
    expect(await service.connect(readonly, { password })).toMatchObject({ state: 'connected' })
    for (const sql of [
      'DELETE FROM dbo.records',
      'SELECT 1 INTO dbo.forbidden',
      'SELECT NEXT VALUE FOR dbo.counter',
    ])
      await expect(query(sql, { connectionId: readonly.id })).rejects.toThrow('read-only')
    await expect(query('SELECT CAST(1.1234 AS money)')).rejects.toThrow('explicit lossless conversion')
    expect(
      (await query('SELECT CONVERT(nvarchar(max),CAST(1.1234 AS money),2) AS amount')).sets[0].rows,
    ).toEqual([['1.1234']])
    await expect(query('DECLARE @x decimal(38,9)=1.123456789; SELECT @x')).rejects.toThrow(
      'lossless server conversion',
    )
    await expect(query('SELECT 1;\nGO')).rejects.toThrow('batch separator')
  })
  it('preserves legacy money/datetime in controlled table projections and reviewed edits', async () => {
    await query(
      "CREATE TABLE dbo.legacy_values(id int PRIMARY KEY,amount money,clock datetime,label nvarchar(200)); INSERT INTO dbo.legacy_values VALUES(1,1.1234,'2026-09-18T12:34:56.123',N'日本語 فارسی 🌊')",
    )
    const input = {
      connectionId: profile.id,
      sessionId: 'legacy-tab',
      schema: 'dbo',
      table: 'legacy_values',
      offset: 0,
      limit: 10,
      direction: 'asc' as const,
    }
    const page = await service.table(input)
    expect(page.sets[0].rows).toEqual([['1', '1.1234', '2026-09-18T12:34:56.123', '日本語 فارسی 🌊']])
    expect(page.sets[0].columns.map((column) => column.type)).toEqual([
      'int',
      'money',
      'datetime',
      'nvarchar(200)',
    ])
    const original = Object.fromEntries(
      page.sets[0].columns.map((column, index) => [column.name, page.sets[0].rows[0][index]]),
    )
    expect(
      await service.applyEdits({
        ...input,
        changes: [{ kind: 'update', original, values: { amount: '9.8765' } }],
      }),
    ).toEqual({ affectedRows: 1 })
    expect((await service.table(input)).sets[0].rows[0][1]).toBe('9.8765')
    const columns = await Promise.all([
      service.structure(input),
      service.listObjects({ connectionId: profile.id }),
      service.listDatabases(profile.id),
    ])
    expect(columns).toHaveLength(3)
  })
  it('fails verified TLS against an untrusted fixture certificate and supports explicit encrypted local testing', async () => {
    const strict = {
      ...profile,
      id: randomUUID(),
      tls: { ...profile.tls, enabled: true, rejectUnauthorized: true },
    }
    const rejected = await service.connect(strict, { password })
    expect(rejected.state).toBe('failed')
    expect(rejected.error).toMatch(/certificate|self.signed|verify/i)
    const local = { ...strict, id: randomUUID(), tls: { ...strict.tls, rejectUnauthorized: false } }
    expect(await service.connect(local, { password })).toMatchObject({ state: 'connected', transport: 'TLS' })
    expect((await query('SELECT 7 AS n', { connectionId: local.id })).sets[0].rows).toEqual([['7']])
    const failedAuth = await service.connect(
      { ...profile, id: randomUUID() },
      { password: 'incorrect-disposable-password' },
    )
    expect(failedAuth.state).toBe('failed')
    expect(failedAuth.error).not.toContain('incorrect-disposable-password')
  })
  it('times out once without replay and detects a terminated tab session', async () => {
    const limited = { ...profile, id: randomUUID(), queryTimeout: 1000 }
    expect(await service.connect(limited, { password })).toMatchObject({ state: 'connected' })
    await expect(
      query("WAITFOR DELAY '00:00:05'; INSERT INTO dbo.records(id,label) VALUES(8,N'never')", {
        connectionId: limited.id,
      }),
    ).rejects.toThrow(/timeout|failed to complete/i)
    expect((await query('SELECT COUNT(*) AS n FROM dbo.records WHERE id=8')).sets[0].rows).toEqual([['0']])
    const session = 'terminated-tab'
    const spid = (await query('SELECT @@SPID AS id', { sessionId: session })).sets[0].rows[0][0]
    expect(String(spid)).toMatch(/^\d+$/)
    await raw(`KILL ${spid}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(query('SELECT 1', { sessionId: session })).rejects.toThrow(/ended|disconnected/i)
    expect(service.getSessionState({ connectionId: profile.id, sessionId: session }).connected).toBe(false)
  }, 10000)
  it('stops a stream on sink failure and rejects an oversized row without finalizing output', async () => {
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql: 'SELECT 1 AS n' },
        {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async () => {
            throw new Error('disposable sink failed')
          },
        },
      ),
    ).rejects.toThrow('disposable sink failed')
    await expect(
      service.streamQuery(
        {
          connectionId: profile.id,
          sql: "SELECT REPLICATE(CONVERT(varchar(max),'x'),8388609) AS large_value",
        },
        {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async () => {
            throw new Error('oversized row must not reach consumer')
          },
        },
      ),
    ).rejects.toThrow('8 MiB row limit')
    expect((await query('SELECT 9 AS healthy')).sets[0].rows).toEqual([['9']])
  }, 10000)
})
