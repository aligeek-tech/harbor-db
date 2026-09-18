import { describe, expect, it } from 'vitest'
import oracledb from 'oracledb'
import { oracleConfirmation, oracleQuote, oracleSafety, oracleSql, oracleVisible } from '../src/shared/oracle'
import {
  oracleBindings,
  oracleExactProjection,
  oracleFetchType,
  oracleImportExpression,
  oracleRow,
} from '../src/main/engines/oracle-values'
import { quoteIdentifier, splitStatements, sqlDialect } from '../src/shared/sql'

describe('Oracle native lexical and value boundaries', () => {
  it('preserves UTF-16 offsets and hides Oracle alternate quotes, comments and quoted names', () => {
    const sql = `SELECT q'[😀 :secret ; DROP TABLE x]' a,nq'{a''b;}' b,':hidden' c,"semi;colon" FROM DUAL -- ;\n;`
    const visible = oracleVisible(sql)
    expect(visible.length).toBe(sql.length)
    expect(visible).not.toContain('DROP')
    expect(visible.match(/;/g)).toHaveLength(1)
    expect(oracleSafety(sql).readOnly).toBe(true)
    expect(oracleVisible(oracleSql(sql))).not.toContain(';')
    expect(() => oracleSql('SELECT 1 FROM DUAL; SELECT 2 FROM DUAL')).toThrow('one Oracle')
    expect(() => oracleSql("SELECT q'[bad' FROM DUAL")).toThrow('Unterminated')
    expect(() => oracleVisible('/* outer /* nested */')).toThrow('nested')
  })
  it('sends a complete PL/SQL unit without confusing internal semicolons with script statements', () => {
    const sql = "BEGIN NULL; DBMS_OUTPUT.PUT_LINE(q'[;]'); END;\n/"
    expect(oracleSql(sql)).toBe("BEGIN NULL; DBMS_OUTPUT.PUT_LINE(q'[;]'); END;")
    expect(oracleSafety(sql)).toMatchObject({
      readOnly: false,
      destructive: true,
      controlsTransaction: false,
      statementCount: 1,
    })
    expect(oracleConfirmation(sql, { name: 'Fixture', environment: 'local' })).toBe('Fixture')
    expect(() => splitStatements(sql, 'oracle')).toThrow()
    expect(sqlDialect('oracle')).toBe('oracle')
    expect(quoteIdentifier('odd"name', 'oracle')).toBe('"odd""name"')
    expect(() => oracleQuote('x'.repeat(129))).toThrow('128')
  })
  it('binds exact numerics, timestamp nanoseconds and binary without interpolation or quoted-placeholder replacement', () => {
    const result = oracleBindings("SELECT :amount,:when,:blob,q'[:hidden]' FROM DUAL", [
      { name: 'amount', type: 'decimal', secret: true, value: '12345678901234567890.123456789' },
      { name: 'when', type: 'timestamp', secret: false, value: '2026-09-18T12:34:56.123456789Z' },
      { name: 'blob', type: 'binary', secret: false, value: 'AP+A' },
    ])
    expect(result.sql).toContain('TO_NUMBER(:AMOUNT)')
    expect(result.sql).toContain("q'[:hidden]'")
    expect(result.sql).not.toContain('12345678901234567890')
    expect(result.binds).toMatchObject({
      AMOUNT: { val: '12345678901234567890.123456789' },
      WHEN: { val: '2026-09-18T12:34:56.123456789+00:00' },
      BLOB: { val: Buffer.from([0, 255, 128]) },
    })
    expect(() =>
      oracleBindings('SELECT :n FROM DUAL', [
        { name: 'n', type: 'integer', secret: false, value: '1'.repeat(39) },
      ]),
    ).toThrow('precision')
    expect(() => oracleBindings('SELECT :n FROM DUAL', [])).toThrow('no supplied')
  })
  it('requires exact NUMBER/DATE import precision and rejects unsupported native types', () => {
    const column = { name: 'N', type: 'NUMBER(12,3)', nullable: true, defaultValue: null, primaryKey: false }
    expect(oracleImportExpression('123.456', column, 'v').bind).toMatchObject({ val: '123.456' })
    expect(() => oracleImportExpression('123.4567', column, 'v')).toThrow('rounding')
    expect(() => oracleImportExpression('2026-09-18T12:34:56.1Z', { ...column, type: 'DATE' }, 'v')).toThrow(
      'truncation',
    )
    expect(() =>
      oracleImportExpression('2026-09-18T12:34:56+03:30', { ...column, type: 'TIMESTAMP(9)' }, 'v'),
    ).toThrow('UTC')
    expect(() => oracleFetchType({ dbType: oracledb.DB_TYPE_JSON })).toThrow('JSON_SERIALIZE')
    expect(oracleFetchType({ dbType: oracledb.DB_TYPE_NUMBER })).toEqual({ type: oracledb.STRING })
  })
  it('rejects lossy Thin date fetching and builds null-safe native projections', () => {
    for (const dbType of [
      oracledb.DB_TYPE_DATE,
      oracledb.DB_TYPE_TIMESTAMP,
      oracledb.DB_TYPE_TIMESTAMP_TZ,
      oracledb.DB_TYPE_TIMESTAMP_LTZ,
    ])
      expect(() => oracleFetchType({ dbType })).toThrow('cannot fetch raw DATE/TIMESTAMP')
    expect(oracleExactProjection('"WHEN"', 'TIMESTAMP(9) WITH TIME ZONE')).toContain(
      'CASE WHEN "WHEN" IS NULL THEN NULL',
    )
    expect(oracleExactProjection('"WHEN"', 'TIMESTAMP(9) WITH LOCAL TIME ZONE')).toContain('FF9')
    expect(oracleExactProjection('"WHEN"', 'DATE')).toContain('SYYYY')
  })
  it('preserves binary and null scalars and enforces bounded row contents', async () => {
    expect(await oracleRow(['9007199254740993', null, Buffer.from([0, 255, 128]), true])).toEqual([
      '9007199254740993',
      null,
      { type: 'binary', base64: 'AP+A' },
      true,
    ])
    await expect(oracleRow([9007199254740992])).rejects.toThrow('exact text')
    await expect(oracleRow(['x'.repeat(8 * 1024 * 1024)])).rejects.toThrow('8 MiB')
  })
})
