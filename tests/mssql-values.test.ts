import { describe, expect, it } from 'vitest'
import {
  losslessBatch,
  mssqlCell,
  mssqlConfirmation,
  mssqlLiteral,
  mssqlParameters,
  mssqlQuote,
  mssqlSafety,
  mssqlVisible,
} from '../src/main/engines/mssql-values'
import type { QueryParameter } from '../src/shared/parameters'
const parameter = (type: QueryParameter['type'], value: string, name = 'p'): QueryParameter => ({
  type,
  value,
  name,
  secret: false,
})
describe('SQL Server exact values and guards', () => {
  it('normalizes decimal exponents without a Number round trip', () => {
    expect(mssqlParameters([parameter('decimal', '-12345678901234567890.123456789')])[0]).toMatchObject({
      value: '-12345678901234567890.123456789',
      declaration: 'decimal(29,9)',
    })
    expect(mssqlParameters([parameter('decimal', '1.23e2')])[0]).toMatchObject({
      value: '123',
      declaration: 'decimal(3,0)',
    })
    expect(mssqlParameters([parameter('decimal', '.001e-2')])[0]).toMatchObject({
      value: '0.00001',
      declaration: 'decimal(5,5)',
    })
    expect(() => mssqlParameters([parameter('decimal', '1e38')])).toThrow('38 digits')
    expect(() => mssqlParameters([parameter('integer', '9223372036854775808')])).toThrow('BIGINT')
    expect(() => mssqlParameters([parameter('timestamp', '2026-09-18T01:02:03.12345678Z')])).toThrow('seven')
  })
  it('binds SQL text and values independently and preserves duplicate column names', () => {
    const result = losslessBatch(
      'SELECT @amount AS value, @amount AS value',
      mssqlParameters([parameter('decimal', '12345678901234567890.123456789', 'amount')]),
      [
        { name: 'value', type: 'decimal(38,9)', nullable: false },
        { name: 'value', type: 'datetimeoffset(7)', nullable: true },
      ],
    )
    expect(result.sql).toContain(
      'WITH RESULT SETS (([__harbor_0] nvarchar(max) NULL,[__harbor_1] nvarchar(max) NULL))',
    )
    expect(result.sql).not.toContain('12345678901234567890')
    expect(result.columns?.map((c) => c.name)).toEqual(['value', 'value'])
    expect(result.parameters[1].value).toBe('@amount decimal(29,9)')
    expect(() => mssqlParameters([parameter('text', 'a', 'X'), parameter('text', 'b', 'x')])).toThrow(
      'unique',
    )
  })
  it('refuses post-decoding numeric/date repair and transports binary values', () => {
    expect(() => mssqlCell(1.1, 'DecimalN')).toThrow('lossless')
    expect(() => mssqlCell(new Date(), 'DateTimeOffset')).toThrow('lossless')
    expect(mssqlCell(Buffer.from([0, 255]), 'VarBinary')).toEqual({ type: 'binary', base64: 'AP8=' })
    expect(mssqlCell(null, 'DecimalN')).toBeNull()
  })
  it('understands nested comments and escaped identifiers without accepting hidden writes', () => {
    expect(mssqlSafety("SELECT N'DELETE; GO', [a]]b] /* outer /* nested */ tail */").readOnly).toBe(true)
    for (const sql of [
      'SELECT 1 INTO copy',
      'SELECT NEXT VALUE FOR counter',
      'EXEC procedure',
      'SELECT * FROM OPENROWSET(x)',
    ])
      expect(mssqlSafety(sql).readOnly).toBe(false)
    expect(() => mssqlSafety('SELECT 1;\nGO\nSELECT 2')).toThrow('batch separator')
    expect(() => mssqlVisible('SELECT /*')).toThrow('Unterminated')
    expect(mssqlQuote('a]b')).toBe('[a]]b]')
    expect(mssqlLiteral("'quoted")).toBe("N'''quoted'")
  })
  it('requires exact destructive targets and production write confirmation', () => {
    expect(
      mssqlConfirmation('DROP DATABASE [db]]name]', { name: 'fixture', environment: 'development' }),
    ).toBe('db]name')
    expect(mssqlConfirmation('UPDATE t SET n=1', { name: 'production', environment: 'production' })).toBe(
      'production',
    )
    expect(() =>
      mssqlConfirmation('DROP DATABASE one,two', { name: 'x', environment: 'development' }),
    ).toThrow('exactly one')
  })
})
