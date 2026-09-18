import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  clickhouseCell,
  clickhouseRows,
  validateClickhouseImport,
} from '../src/main/engines/clickhouse-values'
import { clickhouseReadQuery, clickhouseQuote, clickhouseParameters } from '../src/shared/clickhouse'

describe('ClickHouse native boundaries', () => {
  it('preserves raw bytes, escaped NULL and exact numeric representations', () => {
    expect(clickhouseCell(Buffer.from('\\N'), 'Nullable(String)')).toBeNull()
    expect(clickhouseCell(Buffer.from('\\\\N'), 'String')).toBe('\\N')
    expect(clickhouseCell(Buffer.from([0xff, 0x80]), 'String')).toEqual({ type: 'binary', base64: '/4A=' })
    expect(clickhouseCell(Buffer.from('9007199254740993'), 'UInt64')).toBe('9007199254740993')
    expect(clickhouseCell(Buffer.from('a\\tb\\n\\x00'), 'String')).toBe('a\tb\n\0')
  })
  it('preserves duplicate names and UTF8 split across network chunks', async () => {
    const bytes = Buffer.from('same\tsame\nString\tUInt64\n😀\t9007199254740993\n'),
      chunks = [...bytes].map((byte) => Buffer.from([byte]))
    const rows = []
    for await (const item of clickhouseRows(Readable.from(chunks))) rows.push(item)
    expect(rows).toEqual([
      {
        columns: [
          { name: 'same', type: 'String' },
          { name: 'same', type: 'UInt64' },
        ],
      },
      { row: ['😀', '9007199254740993'] },
    ])
  })
  it('rejects incomplete and ambiguous exception-framed output', async () => {
    for (const bytes of [
      'name\nString\nunfinished',
      'name\nString\n\r\n__exception__\r\nprivate details',
      'name\nString\nwrong\twidth\n',
    ]) {
      const collect = async () => {
        for await (const item of clickhouseRows(Readable.from([Buffer.from(bytes)]))) void item
      }
      await expect(collect()).rejects.toThrow()
    }
  })
  it('uses native escaping and removes only a real final delimiter', () => {
    expect(clickhouseQuote('x`\\y')).toBe('`x\\`\\\\y`')
    expect(clickhouseReadQuery("SELECT '😀; FORMAT',1; /* ; */")).toBe("SELECT '😀; FORMAT',1 /* ; */")
    expect(clickhouseReadQuery('SELECT 1--FORMAT ignored\n')).toBe('SELECT 1--FORMAT ignored')
    for (const sql of [
      'SELECT 1;SELECT 2',
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
      "SELECT 1 INTO OUTFILE 'x'",
      'SELECT 1 SETTINGS readonly=0',
      'SELECT 1 /* unfinished',
    ])
      expect(() => clickhouseReadQuery(sql)).toThrow()
  })
  it('rejects duplicate parameter names and binary transport guessing', () => {
    const p = { name: 'x', type: 'text' as const, secret: false, value: 'value' }
    expect(() => clickhouseParameters([p, p])).toThrow('distinct')
    expect(() => clickhouseParameters([{ ...p, type: 'binary', value: 'AA==' }])).toThrow('base64')
  })
  it('rejects known numeric truncation before writes', () => {
    for (const [value, type] of [
      ['256', 'UInt8'],
      ['-1', 'UInt64'],
      ['1.001', 'Decimal(5,2)'],
      ['9007199254740993', 'Float64'],
      ['0.1', 'Float32'],
    ])
      expect(() => validateClickhouseImport(value, type)).toThrow()
    for (const [value, type] of [
      ['18446744073709551615', 'UInt64'],
      ['12345678901234567890.123456789', 'Decimal(38,9)'],
      ['0.5', 'Float32'],
    ])
      expect(() => validateClickhouseImport(value, type)).not.toThrow()
  })
})
