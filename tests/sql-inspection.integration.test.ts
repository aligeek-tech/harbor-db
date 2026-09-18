import pg from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'
import type { ExplainInput } from '../src/shared/inspection'

const engines = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
]
describe.skipIf(!engines.length)('real SQL inspection and plans', () => {
  for (const engine of engines)
    describe(engine, () => {
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
      const table = `inspect_${suffix}`,
        view = `inspect_view_${suffix}`,
        routine = `inspect_fn_${suffix}`,
        trigger = `inspect_tr_${suffix}`,
        triggerRoutine = `inspect_trfn_${suffix}`,
        mutationRoutine = `inspect_mutate_${suffix}`
      const schema = engine === 'postgres' ? 'public' : 'harbor'
      const port = engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307
      const tls =
        engine === 'mysql'
          ? {
              enabled: true,
              rejectUnauthorized: !!process.env.HARBOR_MYSQL_TLS_CA,
              ca: process.env.HARBOR_MYSQL_TLS_CA
                ? readFileSync(process.env.HARBOR_MYSQL_TLS_CA, 'utf8')
                : '',
            }
          : undefined
      const profile = profileSchema.parse({
        id: `inspection-${engine}`,
        name: 'Disposable SQL inspection',
        engine,
        host: '127.0.0.1',
        port,
        username: 'harbor',
        database: 'harbor',
        readOnly: false,
        tls,
      })
      const service = new SqlService()
      let admin: pg.Client | Connection | undefined
      async function control(sql: string) {
        if (admin instanceof pg.Client) return admin.query(sql)
        return admin!.query(sql)
      }
      function plan(
        sql: string,
        mode: 'estimate' | 'analyze' = 'estimate',
        overrides: Partial<ExplainInput> = {},
      ) {
        return service.explainQuery({
          connectionId: profile.id,
          sessionId: `plan-${crypto.randomUUID()}`,
          requestId: crypto.randomUUID(),
          sql,
          mode,
          ...overrides,
        })
      }
      beforeAll(async () => {
        if (engine === 'postgres') {
          const client = new pg.Client({
            host: '127.0.0.1',
            port,
            user: 'harbor',
            password: 'harbor_test',
            database: 'harbor',
          })
          await client.connect()
          admin = client
        } else
          admin = await mariadb.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            password: 'harbor_root',
            database: 'harbor',
            ssl: tls ? { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.ca || undefined } : undefined,
          })
        await control(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY,label VARCHAR(64))`)
        await control(`CREATE INDEX idx_${suffix} ON ${table}(label)`)
        await control(`INSERT INTO ${table} VALUES(1,'first'),(2,'second')`)
        await control(`CREATE VIEW ${view} AS SELECT id,label FROM ${table}`)
        if (engine === 'postgres') {
          await control(
            `CREATE FUNCTION ${routine}(x INTEGER) RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS 'SELECT x+1'`,
          )
          await control(
            `CREATE FUNCTION ${routine}(x TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS 'SELECT x'`,
          )
          await control(
            `CREATE FUNCTION ${triggerRoutine}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.label=coalesce(NEW.label,'default'); RETURN NEW; END $$`,
          )
          await control(
            `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${triggerRoutine}()`,
          )
        } else {
          await control(
            `CREATE FUNCTION ${routine}(x INTEGER) RETURNS INTEGER DETERMINISTIC NO SQL RETURN x+1`,
          )
          await control(
            `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.label=COALESCE(NEW.label,'default')`,
          )
        }
        await control(
          engine === 'postgres'
            ? `CREATE FUNCTION ${mutationRoutine}() RETURNS INTEGER LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO ${table} VALUES(99,'analysis-write'); RETURN 99; END $$`
            : `CREATE FUNCTION ${mutationRoutine}() RETURNS INTEGER DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO ${table} VALUES(99,'analysis-write'); RETURN 99; END`,
        )
        const status = await service.connect(profile, { password: 'harbor_test' })
        expect(status.state, status.error).toBe('connected')
      })
      afterAll(async () => {
        await service.closeAll()
        if (admin) {
          await control(`DROP VIEW IF EXISTS ${view}`)
          await control(`DROP TABLE IF EXISTS ${table}`)
          if (engine === 'postgres') {
            await control(
              `DROP FUNCTION IF EXISTS ${routine}(INTEGER),${routine}(TEXT),${triggerRoutine}(),${mutationRoutine}()`,
            )
          } else {
            await control(`DROP FUNCTION IF EXISTS ${routine}`)
            await control(`DROP FUNCTION IF EXISTS ${mutationRoutine}`)
          }
          await admin.end()
        }
      })

      it('inspects actual table/view structure and labels source versus summary definitions', async () => {
        const target = { connectionId: profile.id, schema, name: table, kind: 'table' as const }
        const inspected = await service.inspectObject(target)
        expect(inspected.structure?.columns.map((column) => column.name)).toEqual(['id', 'label'])
        expect(inspected.definition?.source).toBe(engine === 'postgres' ? 'summary' : 'server')
        expect(inspected.warnings.join(' ')).toContain('exact table count')
        const inspectedView = await service.inspectObject({ ...target, name: view, kind: 'view' })
        expect(inspectedView.definition?.source).toBe('server')
        expect(inspectedView.definition?.text.toLowerCase()).toContain(table)
      })

      it('requires exact PostgreSQL overload identity and returns native routine/trigger definitions', async () => {
        const target = { connectionId: profile.id, schema, name: routine, kind: 'function' as const }
        const group = await service.inspectObject(target)
        if (engine === 'postgres') {
          expect(group.definition).toBeUndefined()
          expect(group.choices).toHaveLength(2)
          const chosen = await service.inspectObject({ ...target, identity: group.choices![0].identity })
          expect(chosen.definition?.text).toContain(routine)
          await expect(service.inspectObject({ ...target, identity: '1' })).rejects.toThrow(
            'no longer matches',
          )
        } else if (engine === 'mysql' && !group.definition) {
          expect(group.warnings.join(' ')).toContain('did not expose')
          const privileged = { ...profile, id: profile.id + '-routine-owner', username: 'root' }
          expect((await service.connect(privileged, { password: 'harbor_root' })).state).toBe('connected')
          const owned = await service.inspectObject({ ...target, connectionId: privileged.id })
          expect(owned.definition?.text).toContain(routine)
          await service.disconnect(privileged.id)
        } else expect(group.definition?.text).toContain(routine)
        const inspectedTrigger = await service.inspectObject({ ...target, name: trigger, kind: 'trigger' })
        expect(inspectedTrigger.definition?.text).toContain(trigger)
        expect(inspectedTrigger.definition?.source).toBe('server')
      })

      it('separates estimates from explicit execution analysis and binds values natively', async () => {
        const text = `SELECT * FROM ${table} WHERE id=${engine === 'postgres' ? '$1' : '?'}`
        const parameters = [{ name: 'id', type: 'integer' as const, value: '1', secret: false }]
        const estimate = await plan(text, 'estimate', { parameters })
        expect(estimate.format).toBe('json')
        expect(JSON.parse(estimate.raw)).toBeTruthy()
        expect(estimate.raw).not.toMatch(/Actual Rows|r_rows|actual time=/)
        await expect(plan(text, 'analyze', { parameters })).rejects.toThrow('Confirm analysis')
        const analyzed = await plan(text, 'analyze', { parameters, consentAnalyze: true })
        expect(analyzed.format).toBe(engine === 'mysql' ? 'text' : 'json')
        expect(analyzed.raw).toMatch(
          engine === 'postgres' ? /Actual Rows/ : engine === 'mariadb' ? /r_rows/ : /actual time=/,
        )
        await expect(plan(`DELETE FROM ${table}`, 'analyze', { consentAnalyze: true })).rejects.toThrow(
          'read-only',
        )
        await expect(plan('SELECT 1; SELECT 2')).rejects.toThrow('one read-only')
      })

      it('uses server read-only transactions to reject writes hidden in a SELECT function', async () => {
        const text = `SELECT ${mutationRoutine}()`
        if (engine === 'postgres') await plan(text)
        else {
          // Native optimizers may evaluate functions even while estimating; the physical transaction still rejects writes.
          try {
            await plan(text)
          } catch (error) {
            expect(String(error)).toMatch(/read.only|read only/i)
          }
        }
        await expect(plan(text, 'analyze', { consentAnalyze: true })).rejects.toThrow(/read.only|read only/i)
        const result = await service.execute({
          connectionId: profile.id,
          sessionId: 'verify-no-plan-write',
          requestId: crypto.randomUUID(),
          sql: `SELECT id FROM ${table} WHERE id=99`,
          maxRows: 10,
          privateSession: true,
        })
        expect(result.sets[0].rows).toEqual([])
      })

      it('never reuses an existing tab transaction for analysis', async () => {
        await service.transaction({ connectionId: profile.id, sessionId: 'user-tx', action: 'begin' })
        try {
          await expect(plan('SELECT 1', 'estimate', { sessionId: 'user-tx' })).rejects.toThrow(
            'existing tab transactions',
          )
          await plan('SELECT 1')
          expect(service.getSessionState({ connectionId: profile.id, sessionId: 'user-tx' }).state).toBe(
            'open',
          )
        } finally {
          await service.transaction({ connectionId: profile.id, sessionId: 'user-tx', action: 'rollback' })
        }
      })

      it('cancels native running analysis on its dedicated session', async () => {
        const sessionId = 'plan-cancel',
          requestId = crypto.randomUUID()
        const text = `SELECT ${engine === 'postgres' ? 'pg_sleep' : 'SLEEP'}(10),id FROM ${table}`
        const running = plan(text, 'analyze', { sessionId, requestId, consentAnalyze: true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect((await service.cancel({ connectionId: profile.id, sessionId, requestId })).requested).toBe(
          true,
        )
        expect((await running).cancelled).toBe(true)
      })

      it('keeps private parameter details out of planning errors', async () => {
        const text =
          engine === 'postgres'
            ? 'SELECT no_inspection_function($1::text)'
            : 'SELECT no_inspection_function(?)'
        await expect(
          plan(text, 'estimate', {
            parameters: [{ name: 'private', type: 'text', value: 'never-in-plan-error', secret: true }],
          }),
        ).rejects.toThrow('private parameter')
      })

      it('returns bounded activity/index/grant snapshots with privilege and effective-access caveats', async () => {
        for (const kind of ['activity', 'indexes', 'permissions'] as const) {
          const snapshot = await service.diagnostics({ connectionId: profile.id, kind, schema, table })
          expect(snapshot.available, snapshot.warnings.join(' ')).toBe(true)
          expect(snapshot.sets.every((set) => set.rows.length <= 200)).toBe(true)
          if (kind === 'activity')
            expect(snapshot.sets[0].columns.some((column) => column.name === 'query_preview')).toBe(false)
          if (kind === 'indexes') expect(JSON.stringify(snapshot.sets)).toContain(`idx_${suffix}`)
          if (kind === 'permissions')
            expect(snapshot.warnings.join(' ')).toContain('not a complete effective-access')
        }
        const locks = await service.diagnostics({ connectionId: profile.id, kind: 'locks' })
        if (engine === 'postgres') expect(locks.available).toBe(true)
        else {
          expect(locks.available).toBe(false)
          expect(locks.warnings.join(' ')).toMatch(/denied|PROCESS|privilege/i)
        }
        const extensions = await service.diagnostics({ connectionId: profile.id, kind: 'extensions' })
        expect(extensions.available).toBe(engine === 'postgres')
        const timescale = await service.diagnostics({ connectionId: profile.id, kind: 'timescale' })
        expect(timescale.available).toBe(false)
        expect(timescale.warnings.join(' ')).toMatch(/not installed|requires a PostgreSQL/i)
      })
    })
})

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('real Timescale metadata diagnostics', () => {
  it('reads extension-owned hypertable/chunk/policy views without installing or changing the extension', async () => {
    const service = new SqlService()
    const profile = profileSchema.parse({
      id: 'inspect-timescale',
      name: 'Disposable Timescale inspection',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15433,
      username: 'harbor',
      database: 'harbor',
      readOnly: false,
    })
    const table = `inspect_ts_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    const client = new pg.Client({
      host: '127.0.0.1',
      port: 15433,
      user: 'harbor',
      password: 'harbor_test',
      database: 'harbor',
    })
    await client.connect()
    try {
      expect(
        (await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'")).rowCount,
      ).toBe(1)
      await client.query(`CREATE TABLE ${table}(time TIMESTAMPTZ NOT NULL,value INTEGER)`)
      await client.query("SELECT create_hypertable($1,'time')", [table])
      await client.query(`INSERT INTO ${table} VALUES(now(),1)`)
      expect((await service.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
      const snapshot = await service.diagnostics({
        connectionId: profile.id,
        kind: 'timescale',
        schema: 'public',
        table,
      })
      expect(snapshot.available, snapshot.warnings.join(' ')).toBe(true)
      expect(snapshot.sets.map((set) => set.command)).toContain('hypertables')
      expect(snapshot.sets.map((set) => set.command)).toContain('chunks')
      expect(JSON.stringify(snapshot.sets)).toContain(table)
      expect(snapshot.warnings.join(' ')).toContain('no policies, chunks, jobs or extensions were changed')
    } finally {
      await service.closeAll()
      await client.query(`DROP TABLE IF EXISTS ${table}`)
      await client.end()
    }
  })
})
