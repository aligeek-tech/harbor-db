import { describe, expect, it } from 'vitest'
import { validateImportNumber } from '../src/main/persistence/import-writer'
import type { ColumnInfo } from '../src/shared/contracts'
const column = (type: string): ColumnInfo => ({
  name: 'value',
  type,
  nullable: true,
  primaryKey: false,
  defaultValue: null,
})
describe('import/transfer destination precision guard', () => {
  it.each(['postgres', 'duckdb'] as const)(
    '%s rejects unsafe large integers in floating-point destinations',
    (engine) => {
      expect(() => validateImportNumber('9007199254740993', column('double precision'), engine)).toThrow(
        /round/,
      )
      expect(() => validateImportNumber('0.123456789012345678901', column('double'), engine)).toThrow(/round/)
      expect(() => validateImportNumber('1.5', column('double'), engine)).not.toThrow()
    },
  )
  it.each(['postgres', 'duckdb'] as const)(
    '%s rejects single-precision narrowing even when JavaScript can represent the input',
    (engine) => {
      expect(() => validateImportNumber('16777217', column('real'), engine)).toThrow(/round/)
      expect(() => validateImportNumber('16777216', column('real'), engine)).not.toThrow()
    },
  )
  it('preserves exact decimal, TEXT and SQLite signed 64-bit destinations', () => {
    expect(() =>
      validateImportNumber('12345678901234567890.123456789012345678', column('decimal(38,18)'), 'postgres'),
    ).not.toThrow()
    expect(() => validateImportNumber('0.001', column('decimal(5,2)'), 'duckdb')).toThrow(/precision/)
    expect(() => validateImportNumber('9007199254740993', column('INTEGER'), 'sqlite')).not.toThrow()
    expect(() => validateImportNumber('9223372036854775808', column('INTEGER'), 'sqlite')).toThrow(/round/)
    expect(() => validateImportNumber('9223372036854775808', column('TEXT'), 'sqlite')).not.toThrow()
  })
})
