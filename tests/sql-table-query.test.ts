import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { SqlService } from '../src/main/engines/sql'
import {
  profileSchema,
  type Cell,
  type ConnectionProfile,
  type QueryResult,
  type TableInput,
  type TableStructure,
} from '../src/shared/contracts'
import { qualifiedName, quoteIdentifier, sqlSafety, type SqlDialect } from '../src/shared/sql'
import { buildTableQuery, tableSqlLiteral } from '../src/shared/table-query'

const structure: TableStructure = {
  columns: [
    { name: 'id', type: 'integer', primaryKey: true, nullable: false, defaultValue: null },
    { name: 'value $1 ?', type: 'text', primaryKey: false, nullable: true, defaultValue: null },
    { name: 'rank', type: 'integer', primaryKey: false, nullable: false, defaultValue: null },
  ],
  indexes: [],
  constraints: [],
  ddl: '',
}
const baseInput: TableInput = {
  connectionId: 'fixture',
  sessionId: 'fixture',
  schema: 'schema_$1_?',
  table: 'table_$1_?',
  offset: 3,
  limit: 25,
  direction: 'desc',
  sort: 'rank',
}
const tricky = "O'Reilly \\ path\n%_!α😀"

describe('structured table query generation', () => {
  for (const dialect of ['postgres', 'mariadb'] as const) {
    it(`${dialect}: retains placeholder-shaped identifiers and parameter values verbatim`, () => {
      const input = {
        ...baseInput,
        filter: { column: 'value $1 ?', operator: 'equals' as const, value: tricky },
      }
      const result = buildTableQuery(input, structure, dialect)
      expect(result.sql).toContain(qualifiedName(input.schema, input.table, dialect))
      expect(result.sql).toContain(quoteIdentifier(input.filter.column, dialect))
      expect(result.parameters).toEqual([tricky, 25, 3])
      expect(result.editorSql).toContain(qualifiedName(input.schema, input.table, dialect))
      expect(result.editorSql).toContain(
        `ORDER BY ${quoteIdentifier('rank', dialect)} DESC, ${quoteIdentifier('id', dialect)} DESC`,
      )
      expect(result.editorSql).toContain('LIMIT 25 OFFSET 3;')
      expect(sqlSafety(result.editorSql, dialect).readOnly).toBe(true)
      expect(result.sql).not.toContain("O'Reilly")
    })
    it(`${dialect}: represents contains wildcards and null predicates using the same query fragments`, () => {
      const input = {
        ...baseInput,
        filter: { column: 'value $1 ?', operator: 'contains' as const, value: '%_!' },
      }
      const contains = buildTableQuery(input, structure, dialect)
      expect(contains.parameters).toEqual(['%!%!_!!%', 25, 3])
      expect(contains.editorSql).toContain("LIKE '%!%!_!!%' ESCAPE '!'")
      const isNull = buildTableQuery(
        { ...input, filter: { ...input.filter, operator: 'is null' } },
        structure,
        dialect,
      )
      expect(isNull.parameters).toEqual([25, 3])
      expect(isNull.editorSql).toContain(' IS NULL')
    })
    it(`${dialect}: keeps ordinary strings readable and never converts string numerals to numbers`, () => {
      expect(tableSqlLiteral('9007199254740993.000000001', dialect)).toBe("'9007199254740993.000000001'")
      expect(tableSqlLiteral("O'Reilly α😀", dialect)).toBe("'O''Reilly α😀'")
      expect(tableSqlLiteral('', dialect)).toBe("''")
      expect(() => tableSqlLiteral(Infinity, dialect)).toThrow('pagination')
      expect(() => buildTableQuery({ ...baseInput, sort: 'missing' }, structure, dialect)).toThrow(
        'Sort column',
      )
    })
  }
  it('uses mode-independent escape strings and UTF-8 hex without dropping NUL bytes', () => {
    expect(tableSqlLiteral('a\\b\n\0', 'postgres')).toBe("E'a\\\\b\\u000a\\u0000'")
    expect(tableSqlLiteral('a\\b\n\0', 'mariadb')).toBe("CONVERT(X'615c620a00' USING utf8mb4)")
  })
})

const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const table = `harbor_sql_${suffix}_$1_?`
const service = new SqlService()
const profiles = (['postgres', 'mariadb'] as const).map((engine) =>
  profileSchema.parse({
    id: `table-query-${engine}-${suffix}`,
    name: `Table query ${engine}`,
    engine,
    host: '127.0.0.1',
    port: engine === 'postgres' ? 15432 : 13306,
    username: 'harbor',
    database: 'harbor',
    schema: engine === 'postgres' ? 'public' : 'harbor',
    readOnly: false,
  }),
)
let postgres: pg.Client | undefined
let maria: Connection | undefined
function execute(profile: ConnectionProfile, sql: string, sessionId: string) {
  return service.execute({
    connectionId: profile.id,
    sessionId,
    requestId: randomUUID(),
    sql,
    maxRows: 100,
    privateSession: true,
  })
}
function rowObjects(result: QueryResult): Record<string, Cell>[] {
  return result.sets[0].rows.map((row) =>
    Object.fromEntries(result.sets[0].columns.map((column, index) => [column.name, row[index]])),
  )
}
async function control(profile: ConnectionProfile, sql: string, values: (string | number | null)[] = []) {
  if (profile.engine === 'postgres') await postgres!.query(sql, values)
  else await maria!.query(sql, values)
}

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')(
  'executable table query equivalence on real SQL servers',
  () => {
    beforeAll(async () => {
      postgres = new pg.Client({
        host: '127.0.0.1',
        port: 15432,
        user: 'harbor',
        password: 'harbor_test',
        database: 'harbor',
      })
      await postgres.connect()
      maria = await mariadb.createConnection({
        host: '127.0.0.1',
        port: 13306,
        user: 'harbor',
        password: 'harbor_test',
        database: 'harbor',
      })
      for (const profile of profiles) {
        const dialect = profile.engine as SqlDialect
        const name = qualifiedName(profile.schema, table, dialect)
        await control(
          profile,
          `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, ${quoteIdentifier('value $1 ?', dialect)} TEXT, ${quoteIdentifier('rank', dialect)} INTEGER NOT NULL)${dialect === 'mariadb' ? ' ENGINE=InnoDB' : ''}`,
        )
        const rows = [
          [1, 'plain α😀', 1],
          [2, tricky, 2],
          [3, tricky, 2],
          [4, tricky, 2],
          [5, 'different', 3],
          [6, null, 3],
          [7, '', 4],
          [8, dialect === 'mariadb' ? 'nul\0value' : 'control\t\r\n', 5],
        ] as const
        for (const row of rows)
          await control(
            profile,
            `INSERT INTO ${name} VALUES (${dialect === 'postgres' ? '$1,$2,$3' : '?,?,?'})`,
            [...row],
          )
        expect((await service.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
      }
    })
    afterAll(async () => {
      await service.closeAll()
      for (const profile of profiles) {
        if (profile.engine === 'postgres' ? postgres : maria)
          await control(
            profile,
            `DROP TABLE IF EXISTS ${qualifiedName(profile.schema, table, profile.engine as SqlDialect)}`,
          )
      }
      await postgres?.end()
      await maria?.end()
    })

    for (const profile of profiles) {
      const dialect = profile.engine as SqlDialect
      const name = qualifiedName(profile.schema, table, dialect)
      const input: TableInput = {
        connectionId: profile.id,
        sessionId: 'table-equivalence',
        schema: profile.schema,
        table,
        offset: 1,
        limit: 1,
        sort: 'rank',
        direction: 'desc',
        filter: { column: 'value $1 ?', operator: 'contains', value: '%_!' },
      }
      it(`${dialect}: executes equivalent filters, stable sorting and pagination in both string-escape modes`, async () => {
        const modes =
          dialect === 'postgres'
            ? ["SET standard_conforming_strings = 'on'", "SET standard_conforming_strings = 'off'"]
            : ["SET sql_mode = ''", "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"]
        for (const [index, mode] of modes.entries()) {
          const sessionId = `mode-${index}`
          await execute(profile, mode, sessionId)
          for (const filter of [
            input.filter!,
            { column: 'value $1 ?', operator: 'equals' as const, value: tricky },
            { column: 'value $1 ?', operator: 'equals' as const, value: '' },
            { column: 'value $1 ?', operator: 'is null' as const, value: '' },
          ]) {
            const request = {
              ...input,
              sessionId,
              filter,
              ...(filter.operator === 'is null' || filter.value === '' ? { offset: 0 } : {}),
            }
            const result = await service.table(request)
            expect(result.tableQuery).toBeDefined()
            const shown = result.tableQuery!
            const authored = await execute(profile, shown.editorSql, sessionId)
            expect(authored.sets[0].rows).toEqual(result.sets[0].rows)
            expect(authored.sets[0].columns.map((column) => column.name)).toEqual(
              result.sets[0].columns.map((column) => column.name),
            )
            expect(authored.tableQuery).toBeUndefined()
            if (filter.value === '%_!') {
              expect(String(result.sets[0].rows[0][0])).toBe('3')
              expect(shown.parameters).toEqual(['%!%!_!!%', 1, 1])
            }
          }
        }
      })
      it(`${dialect}: preserves NUL semantics in generated text literals`, async () => {
        const sessionId = 'nul-filter'
        if (dialect === 'mariadb') {
          await execute(profile, "SET sql_mode='NO_BACKSLASH_ESCAPES'", sessionId)
          const result = await service.table({
            ...input,
            sessionId,
            offset: 0,
            filter: { column: 'value $1 ?', operator: 'equals', value: 'nul\0value' },
          })
          expect(String(result.sets[0].rows[0][0])).toBe('8')
          expect((await execute(profile, result.tableQuery!.editorSql, sessionId)).sets[0].rows).toEqual(
            result.sets[0].rows,
          )
        } else {
          await expect(
            service.table({
              ...input,
              sessionId,
              filter: { column: 'value $1 ?', operator: 'equals', value: '\0' },
            }),
          ).rejects.toThrow()
          await expect(
            execute(profile, `SELECT ${tableSqlLiteral('\0', dialect)}`, sessionId),
          ).rejects.toThrow()
        }
      })
      it(`${dialect}: rolls back earlier selected-row deletions after a concurrent change, then deletes fresh selections atomically`, async () => {
        const request = { ...input, sessionId: 'multi-delete', offset: 0, limit: 100, filter: undefined }
        const before = rowObjects(await service.table(request)).filter((row) =>
          ['2', '3'].includes(String(row.id)),
        )
        expect(before).toHaveLength(2)
        // A separate physical driver connection changes a later selected row after it was loaded.
        await control(
          profile,
          `UPDATE ${name} SET ${quoteIdentifier('value $1 ?', dialect)}=${dialect === 'postgres' ? '$1' : '?'} WHERE id=2`,
          ['concurrent change'],
        )
        await expect(
          service.applyEdits({
            connectionId: profile.id,
            sessionId: request.sessionId,
            schema: profile.schema,
            table,
            changes: before.map((original) => ({ kind: 'delete' as const, original, values: {} })),
          }),
        ).rejects.toThrow('Conflict')
        const after = rowObjects(await service.table(request)).filter((row) =>
          ['2', '3'].includes(String(row.id)),
        )
        expect(after).toHaveLength(2)
        expect(after.find((row) => String(row.id) === '2')?.['value $1 ?']).toBe('concurrent change')
        expect(
          await service.applyEdits({
            connectionId: profile.id,
            sessionId: request.sessionId,
            schema: profile.schema,
            table,
            changes: after.map((original) => ({ kind: 'delete' as const, original, values: {} })),
          }),
        ).toEqual({ affectedRows: 2 })
        expect(
          rowObjects(await service.table(request)).filter((row) => ['2', '3'].includes(String(row.id))),
        ).toEqual([])
      })
    }
  },
)
