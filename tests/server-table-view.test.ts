import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileSchema, tableInputSchema, type TableStructure } from '../src/shared/contracts'
import { buildTableQuery } from '../src/shared/table-query'
import { qualifiedName } from '../src/shared/sql'
import { SqlService } from '../src/main/engines/sql'
import { SqliteService } from '../src/main/engines/sqlite'
import { DuckDBService } from '../src/main/engines/duckdb'

const structure: TableStructure = {
  columns: [
    { name: 'id', type: 'bigint', nullable: false, defaultValue: null, primaryKey: true },
    { name: 'label', type: 'text', nullable: true, defaultValue: null, primaryKey: false },
  ],
  indexes: [],
  constraints: [],
  ddl: '',
}
it('structured filters bind values and validate catalog identifiers, distinct priorities and bounds', () => {
  const input = tableInputSchema.parse({
    connectionId: 'c',
    sessionId: 's',
    schema: 'public',
    table: 'test',
    filters: {
      match: 'any',
      conditions: [
        { column: 'label', operator: 'equals', value: "x' OR TRUE --" },
        { column: 'label', operator: 'is null', value: '' },
      ],
    },
    sorts: [{ column: 'label', direction: 'desc' }],
  })
  const built = buildTableQuery(input, structure, 'postgres')
  expect(built.sql).toContain('WHERE ("label" = $1 OR "label" IS NULL)')
  expect(built.sql).toContain('ORDER BY "label" DESC, "id" ASC')
  expect(built.sql).not.toContain("x' OR TRUE")
  expect(built.parameters[0]).toBe("x' OR TRUE --")
  expect(() =>
    buildTableQuery(
      {
        ...input,
        sorts: [
          { column: 'label', direction: 'asc' },
          { column: 'label', direction: 'desc' },
        ],
      },
      structure,
      'postgres',
    ),
  ).toThrow('distinct')
  expect(() =>
    buildTableQuery(
      {
        ...input,
        filters: { match: 'all', conditions: [{ column: 'absent', operator: 'equals', value: 'x' }] },
      },
      structure,
      'postgres',
    ),
  ).toThrow('not in this table')
  expect(
    tableInputSchema.safeParse({
      ...input,
      sorts: Array.from({ length: 9 }, () => ({ column: 'id', direction: 'asc' })),
    }).success,
  ).toBe(false)
})

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })))
})
for (const engine of ['postgres', 'mariadb', 'mysql', 'sqlite', 'duckdb'] as const) {
  const enabled = engine === 'sqlite' || engine === 'duckdb' || process.env.HARBOR_INTEGRATION === '1'
  describe.skipIf(!enabled)(`${engine} real structured server table view`, () => {
    it('executes AND/OR filters and multi-sort before paging with exact bound values', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-view-'))
      dirs.push(directory)
      const service =
        engine === 'sqlite'
          ? new SqliteService(join(directory, 'metadata.sqlite3'))
          : engine === 'duckdb'
            ? new DuckDBService(join(directory, 'metadata.sqlite3'))
            : new SqlService()
      const table = 'view_' + crypto.randomUUID().replaceAll('-', '')
      const local = engine === 'sqlite' || engine === 'duckdb'
      const schema = engine === 'postgres' ? 'public' : local ? 'main' : 'harbor'
      const profile = profileSchema.parse({
        id: table,
        name: 'Disposable view fixture',
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : engine === 'mysql' ? 13307 : 13306,
        username: 'harbor',
        database: local ? '' : 'harbor',
        schema,
        readOnly: false,
        sqlite: { path: join(directory, 'data.sqlite3'), mode: 'create' },
        duckdb: { path: '', mode: 'memory' },
      })
      const target = qualifiedName(schema, table, engine)
      const execute = (sql: string) =>
        service.execute({
          connectionId: profile.id,
          sessionId: 'setup',
          requestId: crypto.randomUUID(),
          sql,
          maxRows: 100,
          privateSession: true,
          confirm: profile.name,
        })
      try {
        const connected = await service.connect(profile, { password: 'harbor_test' })
        expect(connected.state, connected.error).toBe('connected')
        await execute(
          `CREATE TABLE ${target} (id INTEGER PRIMARY KEY, cohort VARCHAR(40), score INTEGER, note TEXT)`,
        )
        await execute(
          `INSERT INTO ${target} VALUES (1,'a',9,'literal'),(2,'a',8,NULL),(3,'b',7,''),(4,'a',9,'other')`,
        )
        const request = tableInputSchema.parse({
          connectionId: profile.id,
          sessionId: 'view',
          schema,
          table,
          limit: 2,
          sorts: [
            { column: 'cohort', direction: 'asc' },
            { column: 'score', direction: 'desc' },
          ],
          filters: {
            match: 'all',
            conditions: [
              { column: 'score', operator: 'greater than', value: '7' },
              { column: 'cohort', operator: 'equals', value: 'a' },
            ],
          },
        })
        const result = await service.table(request)
        expect(result.sets[0].rows.map((row) => String(row[0]))).toEqual(['1', '4'])
        expect(result.tableQuery?.sql).toMatch(/ORDER BY.*cohort.*ASC.*score.*DESC.*id.*ASC/s)
        const nil = await service.table({
          ...request,
          filters: {
            match: 'any',
            conditions: [
              { column: 'note', operator: 'is null', value: '' },
              { column: 'note', operator: 'equals', value: '' },
            ],
          },
        })
        expect(nil.sets[0].rows.map((row) => String(row[0]))).toEqual(['2', '3'])
        const injection = await service.table({
          ...request,
          filters: {
            match: 'all',
            conditions: [{ column: 'note', operator: 'equals', value: "literal' OR 1=1 --" }],
          },
        })
        expect(injection.sets[0].rows).toEqual([])
      } finally {
        await execute(`DROP TABLE IF EXISTS ${target}`).catch(() => {})
        await service.closeAll()
      }
    }, 30000)
  })
}
