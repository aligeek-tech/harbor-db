import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SqlService } from '../src/main/engines/sql'
import { MssqlService } from '../src/main/engines/mssql'
import { SchemaChangesService, type SchemaAdapter } from '../src/main/persistence/schema-changes'
import { profileSchema } from '../src/shared/contracts'
import { qualifiedName } from '../src/shared/sql'
import type { SchemaEngine, SchemaOperation } from '../src/shared/schema-changes'

const engines: SchemaEngine[] = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
  ...(process.env.HARBOR_MSSQL_TEST_ENV_FILE ? (['mssql'] as const) : []),
]
describe.skipIf(!engines.length)('real server reviewed schema operations', () => {
  for (const engine of engines)
    describe(engine, () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
        table = `schema_${suffix}`,
        child = `schema_child_${suffix}`,
        desired = `schema_desired_${suffix}`
      const schema = engine === 'postgres' ? 'public' : engine === 'mssql' ? 'dbo' : 'harbor'
      const fixtureTls =
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
        id: randomUUID(),
        name: 'Disposable schema fixture',
        engine,
        host: '127.0.0.1',
        port:
          engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : engine === 'mysql' ? 13307 : 25433,
        username: engine === 'mssql' ? 'sa' : 'harbor',
        database: engine === 'mssql' ? 'tempdb' : 'harbor',
        schema,
        readOnly: false,
        queryTimeout: 10000,
        tls: engine === 'mssql' ? { enabled: false, rejectUnauthorized: false } : fixtureTls,
      })
      const native = engine === 'mssql' ? new MssqlService() : new SqlService(),
        adapter: SchemaAdapter = native
      const service = new SchemaChangesService({ profile: () => profile, adapter: () => adapter })
      const target = { connectionId: profile.id, database: profile.database, schema, table }
      const qualified = (name: string) => qualifiedName(schema, name, engine)
      const query = (sql: string) =>
        native.execute({
          connectionId: profile.id,
          database: profile.database,
          sessionId: 'setup',
          requestId: randomUUID(),
          sql,
          maxRows: 100,
          privateSession: true,
          confirm: profile.name,
        })
      async function run(operation: SchemaOperation, name = table) {
        const preview = await service.preview({ target: { ...target, table: name }, operation })
        expect(preview.blockedReasons, preview.blockedReasons.join('\n')).toEqual([])
        const result = await service.execute({ token: preview.token, confirm: preview.confirmation })
        return { preview, result }
      }
      beforeAll(async () => {
        const password =
          engine === 'mssql'
            ? /^HARBOR_MSSQL_TEST_PASSWORD=(.+)$/m.exec(
                readFileSync(process.env.HARBOR_MSSQL_TEST_ENV_FILE!, 'utf8'),
              )?.[1] || ''
            : 'harbor_test'
        const status = await native.connect(profile, { password })
        expect(status, status.error).toMatchObject({ state: 'connected' })
      })
      afterAll(async () => {
        for (const name of [`routine_source_${suffix}`, `routine_target_${suffix}`])
          await query(`DROP ${engine === 'mysql' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${qualified(name)}${engine === 'postgres' ? '()' : ''}`).catch(() => undefined)
        for (const name of [`view_source_${suffix}`, `view_target_${suffix}`])
          await query(`DROP VIEW IF EXISTS ${qualified(name)}`).catch(() => undefined)
        for (const name of [child, desired, table, `${table}_renamed`])
          await query(`DROP TABLE IF EXISTS ${qualified(name)}`).catch(() => undefined)
        await native.closeAll()
      })
      it('creates tables, adds columns, builds/drops indexes and constraints with actual server outcomes', async () => {
        const create = await run({
          kind: 'create-table',
          columns: [
            { name: 'id', type: { kind: 'integer' }, nullable: false },
            { name: 'value', type: { kind: 'integer' }, nullable: true },
          ],
          constraints: [{ kind: 'primary-key', name: `pk_${suffix}`, columns: ['id'] }],
        })
        expect(create.result.state, JSON.stringify(create.result)).toBe('committed')
        expect(create.preview.atomicity).toBe(
          engine === 'mysql' || engine === 'mariadb' ? 'implicit-commit' : 'transaction',
        )
        await query(`INSERT INTO ${qualified(table)} VALUES(1,7),(2,8)`)
        const add = await run({
          kind: 'add-column',
          column: {
            name: 'score',
            type: { kind: 'integer' },
            nullable: false,
            default: { kind: 'number', value: '9' },
          },
        })
        expect(add.result.state, JSON.stringify(add.result)).toBe('committed')
        expect(
          (await query(`SELECT score FROM ${qualified(table)} ORDER BY id`)).sets[0].rows.map((row) =>
            row.map(String),
          ),
        ).toEqual([['9'], ['9']])
        for (const operation of [
          { kind: 'create-index', name: `idx_${suffix}`, columns: ['score'], unique: false },
          { kind: 'drop-index', name: `idx_${suffix}` },
          {
            kind: 'add-constraint',
            constraint: { kind: 'unique', name: `uq_${suffix}`, columns: ['value'] },
          },
          { kind: 'drop-constraint', name: `uq_${suffix}`, constraintKind: 'unique' },
          {
            kind: 'add-constraint',
            constraint: {
              kind: 'check',
              name: `ck_${suffix}`,
              column: 'value',
              operator: '>',
              value: { kind: 'number', value: '0' },
            },
          },
          { kind: 'drop-constraint', name: `ck_${suffix}`, constraintKind: 'check' },
        ] satisfies SchemaOperation[]) {
          const applied = await run(operation)
          expect(applied.result.state, JSON.stringify(applied.result)).toBe('committed')
        }
        {
          const altered = await run({
            kind: 'alter-column',
            name: 'value',
            type: { kind: 'bigint' },
            nullable: true,
          })
          expect(altered.result.state, JSON.stringify(altered.result)).toBe('committed')
        }
      })
      it('validates incoming FKs, blocks a stale catalog, and leaves comparison drafts inert', async () => {
        const created = await run(
          {
            kind: 'create-table',
            columns: [
              { name: 'id', type: { kind: 'integer' }, nullable: false },
              { name: 'parent_id', type: { kind: 'integer' }, nullable: true },
            ],
            constraints: [
              { kind: 'primary-key', name: `child_pk_${suffix}`, columns: ['id'] },
              {
                kind: 'foreign-key',
                name: `fk_${suffix}`,
                columns: ['parent_id'],
                referencedSchema: schema,
                referencedTable: table,
                referencedColumns: ['id'],
              },
            ],
          },
          child,
        )
        expect(created.result.state, JSON.stringify(created.result)).toBe('committed')
        const preview = await service.preview({ target, operation: { kind: 'drop-column', name: 'value' } })
        expect(preview.dependencies.some((item) => item.name.includes(child))).toBe(true)
        await query(`ALTER TABLE ${qualified(table)} ADD another INTEGER`)
        const stale = await service.execute({ token: preview.token, confirm: preview.confirmation })
        expect(stale.state).toBe('failed')
        expect(stale.warnings.join()).toMatch(/changed after preview/)
        await query(
          `CREATE TABLE ${qualified(desired)} (id INTEGER PRIMARY KEY,value VARCHAR(100),extra INTEGER)`,
        )
        const comparison = await service.compare({ source: { ...target, table: desired }, target })
        expect(comparison.differences).toContainEqual(
          expect.objectContaining({ object: 'column value', supported: false }),
        )
        expect(comparison.statements.length).toBeGreaterThan(0)
        expect((await adapter.structure(target)).columns.some((column) => column.name === 'another')).toBe(
          true,
        )
      })
      it('reports rejection/rollback or uncertain implicit-commit outcome accurately', async () => {
        const failed = await run({
          kind: 'create-index',
          name: `duplicate_${suffix}`,
          columns: ['score'],
          unique: true,
        })
        expect(failed.result.state, JSON.stringify(failed.result)).toBe(
          engine === 'mysql' || engine === 'mariadb' ? 'unknown' : 'rolled-back',
        )
        expect(
          (await adapter.structure(target)).indexes.some((item) => item.name === `duplicate_${suffix}`),
        ).toBe(false)
        expect((await query(`SELECT COUNT(*) FROM ${qualified(table)}`)).sets[0].rows).toEqual([['2']])
      })
      it('compares selected native view definitions and tables while keeping unsupported view migration inert', async () => {
        await query(
          `CREATE VIEW ${qualified(`view_source_${suffix}`)} AS SELECT id,value FROM ${qualified(table)}`,
        )
        await query(`CREATE VIEW ${qualified(`view_target_${suffix}`)} AS SELECT id FROM ${qualified(table)}`)
        const result = await service.compare({
          source: { ...target, table: desired },
          target,
          objects: [
            { kind: 'table', sourceName: desired, targetName: table },
            { kind: 'view', sourceName: `view_source_${suffix}`, targetName: `view_target_${suffix}` },
          ],
        })
        expect(result.differences).toContainEqual(
          expect.objectContaining({
            object: expect.stringContaining('view view_source_'),
            change: 'change',
            supported: false,
            detail: expect.stringMatching(/select/i),
          }),
        )
        expect(result.differences.some((item) => item.object.includes('column value'))).toBe(true)
        expect((await adapter.structure(target)).columns.some((column) => column.name === 'another')).toBe(
          true,
        )
        await query(`DROP VIEW ${qualified(`view_source_${suffix}`)}`)
        await query(`DROP VIEW ${qualified(`view_target_${suffix}`)}`)
      })
      it('renames columns and tables with dialect-native commands and preserves existing rows', async () => {
        for (const operation of [
          { kind: 'rename-column', name: 'value', newName: 'renamed_value' },
          { kind: 'drop-column', name: 'another' },
          { kind: 'rename-table', name: `${table}_renamed` },
        ] satisfies SchemaOperation[]) {
          const result = await run(operation)
          expect(result.result.state, JSON.stringify(result.result)).toBe('committed')
        }
        expect(
          (
            await query(`SELECT renamed_value FROM ${qualified(`${table}_renamed`)} ORDER BY id`)
          ).sets[0].rows.map((row) => row.map(String)),
        ).toEqual([['7'], ['8']])
        const renamed = await run({ kind: 'rename-table', name: table }, `${table}_renamed`)
        expect(renamed.result.state, JSON.stringify(renamed.result)).toBe('committed')
      })
      it('compares native stored-routine definitions as unsupported migration drafts without invoking routines', async () => {
        for (const [side, value] of [['source', 1], ['target', 2]] as const) {
          const name = qualified(`routine_${side}_${suffix}`)
          await query(engine === 'postgres' ? `CREATE FUNCTION ${name}() RETURNS INTEGER LANGUAGE SQL AS 'SELECT ${value}'` : engine === 'mssql' ? `CREATE FUNCTION ${name}() RETURNS INTEGER AS BEGIN RETURN ${value}; END` : engine === 'mysql' ? `CREATE PROCEDURE ${name}() SELECT ${value}` : `CREATE FUNCTION ${name}() RETURNS INTEGER DETERMINISTIC RETURN ${value}`)
        }
        const result = await service.compare({ source: target, target, objects: [{ kind: 'function', sourceName: `routine_source_${suffix}`, targetName: `routine_target_${suffix}` }] })
        expect(result.differences).toHaveLength(1)
        expect(result.differences[0]).toMatchObject({ change: 'change', supported: false, detail: expect.stringMatching(/Manual definition/) })
        expect(result.statements).toEqual([])
        expect(result.differences[0].detail).toContain('1')
        expect(result.differences[0].detail).toContain('2')
      })
    })
})
