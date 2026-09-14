import { describe, expect, it } from 'vitest'
import { parseCsv, prepareCsvInserts } from '../src/shared/csv'
import type { ColumnInfo } from '../src/shared/contracts'

const columns: ColumnInfo[] = [
  { name: 'id', type: 'bigint', nullable: false, defaultValue: null, primaryKey: true },
  { name: 'amount', type: 'numeric(30,10)', nullable: true, defaultValue: null, primaryKey: false },
  { name: 'name', type: 'text', nullable: true, defaultValue: null, primaryKey: false },
]

describe('CSV import fidelity', () => {
  it('parses quotes, embedded delimiters, multiline fields, CRLF, and Unicode', () => {
    const csv = parseCsv('\uFEFFid,name\r\n1,"A, ""quoted""\r\nسلام"\r\n')
    expect(csv.headers).toEqual(['id', 'name'])
    expect(csv.rows).toEqual([['1', 'A, "quoted"\r\nسلام']])
  })
  it('distinguishes empty strings, NULL tokens, and literal quoted NULL tokens', () => {
    expect(parseCsv('a,b,c\n,\\N,"\\N"').rows).toEqual([['', null, '\\N']])
  })
  it('supports a chosen delimiter and files without a header', () => {
    const csv = parseCsv('1;two\n2;three', { delimiter: ';', header: false })
    expect(csv.headers).toEqual(['Column 1', 'Column 2'])
    expect(csv.rows).toEqual([
      ['1', 'two'],
      ['2', 'three'],
    ])
  })
  it('keeps large integers and decimals as exact source text', () => {
    const changes = prepareCsvInserts(
      parseCsv('id,amount\n9223372036854775807,12345678901234567890.1234567890'),
      ['id', 'amount'],
      columns,
    )
    expect(changes[0]?.values).toEqual({
      id: '9223372036854775807',
      amount: '12345678901234567890.1234567890',
    })
  })
  it('ignores completely blank lines but preserves explicitly empty records', () => {
    expect(parseCsv('value\n\n""\n\n').rows).toEqual([['']])
  })
  it('reports malformed quoting and unequal row lengths with source lines', () => {
    expect(() => parseCsv('a,b\n1,2,3')).toThrow('Line 2: found 3 fields')
    expect(() => parseCsv('a\n"unclosed')).toThrow('Line 2')
    expect(() => parseCsv('a\n"value"junk')).toThrow('unexpected text')
    expect(() => parseCsv('a\nva"lue')).toThrow('unquoted field')
  })
  it('rejects row and byte limits before an import can execute', () => {
    expect(() => parseCsv(`a\n${Array(201).fill('row').join('\n')}`)).toThrow('200 data rows')
    expect(() => parseCsv('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB')
  })
})

describe('CSV destination validation', () => {
  it('rejects duplicate targets, missing mappings, and invalid typed values', () => {
    const csv = parseCsv('one,two\ntext,\\N')
    expect(() => prepareCsvInserts(csv, ['id', 'id'], columns)).toThrow('only be mapped once')
    expect(() => prepareCsvInserts(csv, ['', ''], columns)).toThrow('at least one')
    expect(() => prepareCsvInserts(csv, ['id', 'amount'], columns)).toThrow(
      'Line 2, id: requires a whole number',
    )
    expect(() => prepareCsvInserts(csv, ['name', 'id'], columns)).toThrow('does not allow NULL')
  })
  it('supports skipped columns and safely maps special object property names', () => {
    const csv = parseCsv('name,ignored\nhello,world')
    expect(prepareCsvInserts(csv, ['name', ''], columns)[0]?.values).toEqual({ name: 'hello' })
    const special = { ...columns[2]!, name: '__proto__' }
    const values = prepareCsvInserts(parseCsv('__proto__\nhello'), ['__proto__'], [special])[0]!.values
    expect(Object.hasOwn(values, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
  })
})
