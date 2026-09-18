import { describe, expect, it } from 'vitest'
import { profileSchema, tableInputSchema } from '../src/shared/contracts'
import { assertDb2Profile, assertDb2Query, db2ConnectionValue, db2Safety } from '../src/shared/db2'
import { currentStatement, sqlDialect, sqlSafety } from '../src/shared/sql'
import { db2TablePlan } from '../src/main/engines/db2'
import { db2Columns, db2Row, type Db2ColumnMetadata } from '../src/main/engines/db2-values'

const metadata = (code: number, type: string, length = 10, index = 1): Db2ColumnMetadata => ({
  index,
  SQL_DESC_NAME: 'duplicate',
  SQL_DESC_TYPE_NAME: type,
  SQL_DESC_CONSIZE_TYPE: code,
  SQL_DESC_LENGTH: length,
  SQL_DESC_DISPLAY_SIZE: length,
})
describe('Db2 policy and lossless conversion boundaries (no native fixture)', () => {
  it('uses a distinct standard-quote lexer and denies data-change expressions, sessions and multiple statements', () => {
    expect(sqlDialect('db2')).toBe('db2')
    expect(
      sqlSafety("/* nested /* x */ comment */ SELECT 'COMMIT; UPDATE' FROM SYSIBM.SYSDUMMY1;", 'db2')
        .readOnly,
    ).toBe(true)
    expect(currentStatement('VALUES 1; VALUES 2;', 12, 'db2')?.text).toContain('2')
    for (const sql of [
      'SELECT * FROM FINAL TABLE(INSERT INTO T VALUES 1)',
      'VALUES NEXT VALUE FOR S',
      'SET SCHEMA X',
      'VALUES 1; CALL X()',
      'SELECT X INTO Y FROM T',
      'WITH X AS(DELETE FROM T) SELECT * FROM X',
      'SELECT 1 FOR UPDATE',
      'VALUES 1\0;',
    ])
      expect(() => assertDb2Query(sql)).toThrow()
    expect(db2Safety('VALUES 1').readOnly).toBe(true)
    expect(() => assertDb2Query("SELECT 'unterminated")).toThrow()
  })
  it('rejects accidental base-engine use, weak TLS, target omission, replay and connection-string injection', () => {
    const profile = profileSchema.parse({
      id: 'db2',
      name: 'Db2',
      engine: 'db2',
      host: 'localhost',
      port: 50000,
      database: 'SAMPLE',
      schema: 'HARBOR',
      username: 'reader',
    })
    expect(() => assertDb2Profile(profile)).not.toThrow()
    for (const change of [
      { engine: 'postgres' as const },
      { database: '' },
      { schema: '' },
      { autoReconnect: true },
      { readOnly: false },
      { tls: { ...profile.tls, enabled: true, rejectUnauthorized: false } },
    ])
      expect(() => assertDb2Profile({ ...profile, ...change })).toThrow()
    for (const value of ['secret;Security=none', '{secret}', 'x\ny', 'x\0z', ''])
      expect(() => db2ConnectionValue(value)).toThrow()
  })
  it('rejects lossy types and oversized data before any native fetch; preserves ordinal names', () => {
    for (const column of [
      metadata(3, 'DECIMAL'),
      metadata(-360, 'DECFLOAT'),
      metadata(93, 'TIMESTAMP'),
      metadata(12, 'VARCHAR'),
      metadata(-98, 'BLOB'),
      metadata(-3, 'VARBINARY', 512),
    ])
      expect(() => db2Columns([column])).toThrow()
    const columns = [metadata(-5, 'BIGINT', 19), metadata(-3, 'VARBINARY', 511, 2)]
    expect(db2Columns(columns).map((column) => column.name)).toEqual(['duplicate', 'duplicate'])
    expect(db2Row(['9223372036854775807', Buffer.from([0, 255])], columns)).toEqual([
      '9223372036854775807',
      { type: 'binary', base64: 'AP8=' },
    ])
    expect(() => db2Row([9223372036854776000, Buffer.alloc(0)], columns)).toThrow()
  })
  it('decodes trusted HEX projections without decimal, timestamp, Unicode, NUL or NULL round trips', () => {
    const values = [
      '9007199254740993.123456789012345678',
      '2026-09-18-12.13.14.123456789012',
      'سلام\0🙂',
      null,
    ]
    const columns = values.map((_, i) => metadata(12, 'VARCHAR', 1022, i + 1))
    const encodings = values.map(() => ({ type: 'trusted', format: 'hex-text' as const }))
    expect(db2Columns(columns, encodings)).toHaveLength(4)
    expect(
      db2Row(
        values.map((value) => (value === null ? null : Buffer.from(value).toString('hex'))),
        columns,
        encodings,
      ),
    ).toEqual(values)
    expect(() => db2Row(['ff'], [columns[0]], [encodings[0]])).toThrow()
    expect(() => db2Row(['00'.repeat(512)], [columns[0]], [encodings[0]])).toThrow()
  })
  it('builds quoted, bound, byte-bounded table projections and deterministic primary-key ordering', () => {
    const structure = {
      columns: [
        { name: 'Id', type: 'BIGINT', nullable: false, defaultValue: null, primaryKey: true },
        { name: 'a"b', type: 'DECIMAL(31,8)', nullable: true, defaultValue: null, primaryKey: false },
        { name: 'Text', type: 'VARCHAR(511)', nullable: true, defaultValue: null, primaryKey: false },
      ],
      indexes: [],
      constraints: [],
      ddl: '',
    }
    const input = tableInputSchema.parse({
      connectionId: 'x',
      sessionId: 'tab',
      schema: 'Mixed',
      table: 'T"ab',
      offset: 10,
      limit: 5,
      filters: { match: 'all', conditions: [{ column: 'Text', operator: 'equals', value: "secret'OR1=1" }] },
    })
    const plan = db2TablePlan(input, structure)
    expect(plan.sql).toContain('HEX(CAST("a""b" AS VARCHAR(128))) AS "a""b"')
    expect(plan.sql).toContain(
      '"Mixed"."T""ab" WHERE ("Text" = ?) ORDER BY "Id" ASC OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    )
    expect(plan.sql).not.toContain('secret')
    expect(plan.parameters).toEqual(["secret'OR1=1"])
    expect(() =>
      db2TablePlan(input, { ...structure, columns: [{ ...structure.columns[2], type: 'VARCHAR(512)' }] }),
    ).toThrow(/511/)
  })
})
