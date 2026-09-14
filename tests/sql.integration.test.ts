import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import mariadb from 'mariadb'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema, type Cell, type ConnectionProfile, type QueryResult } from '../src/shared/contracts'

const integration = process.env.HARBOR_INTEGRATION === '1'
const profiles = (['postgres', 'mariadb'] as const).map((engine) =>
  profileSchema.parse({
    id: `test-${engine}`,
    name: `Integration ${engine}`,
    engine,
    host: '127.0.0.1',
    port: engine === 'postgres' ? 15432 : 13306,
    username: 'harbor',
    database: 'harbor',
    schema: engine === 'postgres' ? 'public' : 'harbor',
    readOnly: false,
    queryTimeout: 15000,
  }),
)
const secret = { password: 'harbor_test' }
const service = new SqlService()
function query(profile: ConnectionProfile, sql: string, sessionId = 'test', maxRows = 1000) {
  return service.execute({
    connectionId: profile.id,
    sessionId,
    requestId: crypto.randomUUID(),
    sql,
    maxRows,
    privateSession: true,
    confirm: profile.name,
  })
}
function rowObject(result: QueryResult): Record<string, Cell> {
  return Object.fromEntries(
    result.sets[0].columns.map((column, i) => [column.name, result.sets[0].rows[0][i]]),
  )
}

describe.skipIf(!integration)('real PostgreSQL and MariaDB integration', () => {
  beforeAll(async () => {
    for (const profile of profiles) {
      const state = await service.connect(profile, secret)
      expect(state.state, `${profile.engine}: ${state.error}`).toBe('connected')
      await query(profile, 'DROP TABLE IF EXISTS harbor_sql_checks')
      const blob = profile.engine === 'postgres' ? 'BYTEA' : 'BLOB'
      await query(
        profile,
        `CREATE TABLE harbor_sql_checks (id INTEGER PRIMARY KEY,label VARCHAR(200),big BIGINT,amount DECIMAL(30,9),data ${blob},payload ${profile.engine === 'postgres' ? 'JSON' : 'JSON'},nullable VARCHAR(20))`,
      )
      const binary = profile.engine === 'postgres' ? "decode('00ff80','hex')" : "UNHEX('00ff80')"
      await query(
        profile,
        `INSERT INTO harbor_sql_checks VALUES (1,'original',9007199254740993,12345678901234567890.123456789,${binary},'{"n":9007199254740993}',NULL),(2,'other',2,2,NULL,NULL,'')`,
      )
      await query(profile, 'DROP TABLE IF EXISTS harbor_sql_benchmark')
      await query(profile, 'CREATE TABLE harbor_sql_benchmark (id INTEGER PRIMARY KEY,label VARCHAR(80))')
      await query(
        profile,
        profile.engine === 'postgres'
          ? "INSERT INTO harbor_sql_benchmark SELECT i,repeat('x',80) FROM generate_series(1,50000) i"
          : "INSERT INTO harbor_sql_benchmark SELECT seq,REPEAT('x',80) FROM seq_1_to_50000",
      )
    }
  })
  afterAll(async () => {
    await service.closeAll()
  })

  for (const profile of profiles)
    describe(profile.engine, () => {
      const schema = profile.engine === 'postgres' ? 'public' : 'harbor'
      it('browses real schema, metadata and tables with lossless ordered values', async () => {
        expect(await service.listDatabases(profile.id)).toContain('harbor')
        expect(await service.listObjects({ connectionId: profile.id, schema })).toContainEqual(
          expect.objectContaining({ name: 'harbor_sql_checks', kind: 'table' }),
        )
        const structure = await service.structure({
          connectionId: profile.id,
          schema,
          table: 'harbor_sql_checks',
        })
        expect(structure.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true)
        expect(structure.indexes.length).toBeGreaterThan(0)
        const result = await query(
          profile,
          'SELECT big,amount,data,payload,nullable,label AS duplicate,label AS duplicate FROM harbor_sql_checks WHERE id=1',
        )
        expect(result.sets[0].rows[0].slice(0, 5)).toEqual([
          '9007199254740993',
          '12345678901234567890.123456789',
          { type: 'binary', base64: 'AP+A' },
          '{"n":9007199254740993}',
          null,
        ])
        expect(result.sets[0].columns.map((column) => column.name).slice(-2)).toEqual([
          'duplicate',
          'duplicate',
        ])
        expect(result.sets[0].rows[0]).toHaveLength(7)
      })
      it('retains each result set and actual affected-row count', async () => {
        const result = await query(
          profile,
          "SELECT 11 AS one; UPDATE harbor_sql_checks SET label='original' WHERE id=1; SELECT 22 AS two;",
        )
        expect(result.sets).toHaveLength(3)
        expect(String(result.sets[0].rows[0][0])).toBe('11')
        expect(result.sets[1].affectedRows).toBe(1)
        expect(String(result.sets[2].rows[0][0])).toBe('22')
      })
      it('isolates transactions by physical tab session and rolls back on close', async () => {
        expect(
          (await service.transaction({ connectionId: profile.id, sessionId: 'tx', action: 'begin' })).state,
        ).toBe('open')
        expect(
          (await query(profile, "UPDATE harbor_sql_checks SET label='pending' WHERE id=1", 'tx')).transaction,
        ).toBe('open')
        expect(
          (await query(profile, 'SELECT label FROM harbor_sql_checks WHERE id=1', 'outside')).sets[0]
            .rows[0][0],
        ).toBe('original')
        await service.closeSession({ connectionId: profile.id, sessionId: 'tx' })
        expect(
          (await query(profile, 'SELECT label FROM harbor_sql_checks WHERE id=1', 'outside')).sets[0]
            .rows[0][0],
        ).toBe('original')
        await query(profile, 'BEGIN', 'raw-tx')
        const rolled = await query(profile, 'ROLLBACK', 'raw-tx')
        expect(rolled.transaction).toBe('idle')
      })
      it('parameterizes filtering and edits, preserves row identity, and rejects concurrent changes', async () => {
        const table = await service.table({
          connectionId: profile.id,
          sessionId: 'edit',
          schema,
          table: 'harbor_sql_checks',
          offset: 0,
          limit: 200,
          direction: 'asc',
          filter: { column: 'id', operator: 'equals', value: '1' },
        })
        const original = rowObject(table)
        expect(
          await service.applyEdits({
            connectionId: profile.id,
            sessionId: 'edit',
            schema,
            table: 'harbor_sql_checks',
            changes: [{ kind: 'update', original, values: { label: "quote'; SELECT 99; --" } }],
          }),
        ).toEqual({ affectedRows: 1 })
        expect(
          (await query(profile, 'SELECT label FROM harbor_sql_checks WHERE id=1')).sets[0].rows[0][0],
        ).toBe("quote'; SELECT 99; --")
        await expect(
          service.applyEdits({
            connectionId: profile.id,
            sessionId: 'edit',
            schema,
            table: 'harbor_sql_checks',
            changes: [{ kind: 'delete', original, values: {} }],
          }),
        ).rejects.toThrow('Conflict')
        expect(
          String((await query(profile, 'SELECT COUNT(*) FROM harbor_sql_checks')).sets[0].rows[0][0]),
        ).toBe('2')
        await query(profile, "UPDATE harbor_sql_checks SET label='original' WHERE id=1")
        const injection = await service.table({
          connectionId: profile.id,
          sessionId: 'filter',
          schema,
          table: 'harbor_sql_checks',
          offset: 0,
          limit: 200,
          direction: 'asc',
          filter: { column: 'label', operator: 'equals', value: "x' OR 1=1 --" },
        })
        expect(injection.sets[0].rows).toHaveLength(0)
      })
      it('applies row and byte budgets to streamed large output', async () => {
        const sql = 'SELECT * FROM harbor_sql_benchmark ORDER BY id'
        const started = performance.now()
        const result = await query(profile, sql, 'large', 37)
        expect(result.sets[0].rows).toHaveLength(37)
        expect(result.sets[0].truncated).toBe(true)
        console.info(
          `${profile.engine}: drained 50,000 rows, retained 37 in ${Math.round(performance.now() - started)} ms`,
        )
        const huge = await query(profile, "SELECT REPEAT('x',9000000)", 'large', 100)
        expect(huge.sets[0].rows).toHaveLength(0)
        expect(huge.sets[0].truncated).toBe(true)
      })
      it('cancels the actual server query and isolates other tabs', async () => {
        const requestId = crypto.randomUUID()
        const running = service.execute({
          connectionId: profile.id,
          sessionId: 'cancel',
          requestId,
          sql: profile.engine === 'postgres' ? 'SELECT pg_sleep(10)' : 'SELECT SLEEP(10)',
          maxRows: 10,
          privateSession: true,
        })
        await new Promise((resolve) => setTimeout(resolve, 150))
        const cancellation = await service.cancel({
          connectionId: profile.id,
          sessionId: 'cancel',
          requestId,
        })
        expect(cancellation.requested).toBe(true)
        const result = await running
        expect(result.cancelled).toBe(true)
        expect((await query(profile, 'SELECT 1', 'unrelated')).sets[0].rows).toHaveLength(1)
        expect(
          (await service.cancel({ connectionId: profile.id, sessionId: 'cancel', requestId })).requested,
        ).toBe(false)
      })
      it('enforces read-only profiles and production confirmation', async () => {
        const readonly = { ...profile, id: profile.id + '-readonly', readOnly: true }
        expect((await service.connect(readonly, secret)).state).toBe('connected')
        expect((await query(readonly, 'SELECT 1')).sets[0].rows).toHaveLength(1)
        await expect(query(readonly, "UPDATE harbor_sql_checks SET label='bad' WHERE id=1")).rejects.toThrow(
          'read-only',
        )
        await expect(query(readonly, 'COMMIT; DELETE FROM harbor_sql_checks')).rejects.toThrow('read-only')
        if (profile.engine === 'postgres') {
          // Identifier quoting bypasses lexical function-name matching, so this exercises server enforcement.
          await expect(
            query(readonly, `SELECT "set_config"('transaction_read_only','off',false)`),
          ).rejects.toThrow()
        }
        const production = { ...profile, id: profile.id + '-prod', environment: 'production' }
        expect((await service.connect(production, secret)).state).toBe('connected')
        await expect(
          service.execute({
            connectionId: production.id,
            sessionId: 'prod',
            requestId: crypto.randomUUID(),
            sql: "UPDATE harbor_sql_checks SET label='bad' WHERE id=1",
            maxRows: 10,
            privateSession: true,
          }),
        ).rejects.toThrow('confirm')
        await service.disconnect(readonly.id)
        await service.disconnect(production.id)
      })
      it('reports genuine server permission errors and preserves failed transaction state', async () => {
        if (profile.engine === 'postgres') {
          const role = `harbor_read_test_${Date.now()}`
          await service.transaction({ connectionId: profile.id, sessionId: 'permission', action: 'begin' })
          await query(
            profile,
            `CREATE ROLE ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON harbor_sql_checks TO ${role}; SET LOCAL ROLE ${role}`,
            'permission',
          )
          await expect(
            query(profile, "UPDATE harbor_sql_checks SET label='bad' WHERE id=1", 'permission'),
          ).rejects.toThrow(/permission denied/)
          await expect(
            service.transaction({ connectionId: profile.id, sessionId: 'permission', action: 'commit' }),
          ).rejects.toThrow('failed')
          expect(
            (
              await service.transaction({
                connectionId: profile.id,
                sessionId: 'permission',
                action: 'rollback',
              })
            ).state,
          ).toBe('idle')
        } else
          await expect(query(profile, 'SELECT * FROM mysql.user', 'permission')).rejects.toThrow(/denied/i)
      })
      it('enforces configured server timeouts and recovers the same session', async () => {
        const timed = { ...profile, id: profile.id + '-timeout', queryTimeout: 1000 }
        expect((await service.connect(timed, secret)).state).toBe('connected')
        const started = performance.now()
        await expect(
          query(timed, profile.engine === 'postgres' ? 'SELECT pg_sleep(5)' : 'SELECT SLEEP(5)', 'timeout'),
        ).rejects.toThrow(/timeout|time|interrupted/i)
        expect(performance.now() - started).toBeLessThan(4500)
        expect((await query(timed, 'SELECT 1', 'timeout')).sets[0].rows).toHaveLength(1)
        await service.disconnect(timed.id)
      })
      it('rolls back an entire edit batch when a later row conflicts', async () => {
        const original = rowObject(
          await service.table({
            connectionId: profile.id,
            sessionId: 'atomic',
            schema,
            table: 'harbor_sql_checks',
            offset: 0,
            limit: 200,
            direction: 'asc',
            filter: { column: 'id', operator: 'equals', value: '1' },
          }),
        )
        await expect(
          service.applyEdits({
            connectionId: profile.id,
            sessionId: 'atomic',
            schema,
            table: 'harbor_sql_checks',
            changes: [
              { kind: 'insert', values: { id: 3, label: 'must roll back' } },
              { kind: 'delete', original: { ...original, label: 'stale' }, values: {} },
            ],
          }),
        ).rejects.toThrow('Conflict')
        expect(
          (await query(profile, 'SELECT * FROM harbor_sql_checks WHERE id=3')).sets[0].rows,
        ).toHaveLength(0)
      })
      it('reports real authentication failure without erasing a connected profile', async () => {
        const failed = await service.connect(
          { ...profile, id: profile.id + '-bad' },
          { password: 'wrong_private_password' },
        )
        expect(failed.state).toBe('failed')
        expect(failed.error).not.toContain('wrong_private_password')
        expect(service.status(profile.id).state).toBe('connected')
      })
      it('reports dropped sessions without silently retrying', async () => {
        const sql = profile.engine === 'postgres' ? 'SELECT pg_backend_pid()' : 'SELECT CONNECTION_ID()'
        const pid = Number((await query(profile, sql, 'dropped')).sets[0].rows[0][0])
        if (profile.engine === 'postgres') {
          const control = new pg.Client({
            host: profile.host,
            port: profile.port,
            user: 'harbor',
            password: 'harbor_test',
            database: 'harbor',
          })
          await control.connect()
          await control.query('SELECT pg_terminate_backend($1)', [pid])
          await control.end()
        } else {
          const control = await mariadb.createConnection({
            host: profile.host,
            port: profile.port,
            user: 'harbor',
            password: 'harbor_test',
            database: 'harbor',
          })
          await control.query(`KILL CONNECTION ${pid}`)
          await control.end()
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
        await expect(query(profile, 'SELECT 1', 'dropped')).rejects.toThrow(/ended|closed|lost|socket/i)
      })
    })
})
