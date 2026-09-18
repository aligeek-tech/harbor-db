import { describe, expect, it } from 'vitest'
import { reportDefinitionSchema, prepareReport, REPORT_LOADED_ROW_LIMIT } from '../src/shared/reports'
import type { ResultSet } from '../src/shared/contracts'

const result = (rows: ResultSet['rows'], truncated = false): ResultSet => ({
  columns: [
    { name: 'label', type: 'text' },
    { name: 'amount', type: 'decimal' },
    { name: 'amount', type: 'bigint' },
  ],
  rows,
  affectedRows: 0,
  command: 'SELECT',
  truncated,
})

describe('persisted analytics report definitions', () => {
  const base = {
    id: 'report-1',
    name: 'Exact revenue',
    engine: 'duckdb' as const,
    connectionId: 'local-analytics',
    sql: 'SELECT label, amount FROM imported_data WHERE day >= :from_day',
    parameterDefinitions: [{ name: 'from_day', type: 'timestamp' as const, secret: false }],
    view: {
      kind: 'line' as const,
      categoryColumn: 0,
      valueColumn: 1,
      maxPoints: 100,
      sampling: 'even' as const,
    },
    filters: [{ column: 0, operator: 'contains' as const, value: 'north' }],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  }

  it('persists definitions without parameter values, remote locations, or result data', () => {
    expect(reportDefinitionSchema.parse(base)).toEqual(base)
    expect(() => reportDefinitionSchema.parse({ ...base, parameterValues: ['secret'] })).toThrow()
    expect(() => reportDefinitionSchema.parse({ ...base, remoteUrl: 's3://bucket/key' })).toThrow()
    expect(() => reportDefinitionSchema.parse({ ...base, rows: [['private']] })).toThrow()
  })

  it('rejects mutating or ambiguous report SQL and invalid chart axes', () => {
    expect(() => reportDefinitionSchema.parse({ ...base, sql: 'DELETE FROM imported_data' })).toThrow(
      /read-only/,
    )
    expect(() => reportDefinitionSchema.parse({ ...base, sql: 'SELECT 1; SELECT 2' })).toThrow(/exactly one/)
    expect(() => reportDefinitionSchema.parse({ ...base, view: { ...base.view, valueColumn: 0 } })).toThrow(
      /different/,
    )
  })
})

describe('bounded loaded-result chart preparation', () => {
  it('filters by ordinal, samples evenly, and preserves exact labels and values', () => {
    const prepared = prepareReport(
      result([
        ['north 1', '1.1000000000000000001', '9007199254740993'],
        ['south', '2', '9007199254740994'],
        ['north 2', '3.3000000000000000003', '9007199254740995'],
        ['north 3', '4.4000000000000000004', '9007199254740996'],
      ]),
      { kind: 'line', categoryColumn: 0, valueColumn: 2, maxPoints: 2, sampling: 'even' },
      [{ column: 0, operator: 'contains', value: 'north' }],
    )
    expect(prepared).toMatchObject({
      loadedRows: 4,
      filteredRows: 3,
      displayedRows: 2,
      sampled: true,
      precisionApproximate: true,
    })
    expect(prepared.points.map(({ category, value, sourceRow }) => [category, value, sourceRow])).toEqual([
      ['north 1', '9007199254740993', 0],
      ['north 3', '9007199254740996', 3],
    ])
  })

  it('skips nonnumeric chart values but table mode retains every exact cell', () => {
    const set = result(
      [
        ['valid', '1.25', '2'],
        ['null', null, '3'],
        ['binary', { type: 'binary', base64: 'AA==' }, '4'],
      ],
      true,
    )
    const chart = prepareReport(
      set,
      { kind: 'bar', categoryColumn: 0, valueColumn: 1, maxPoints: 10, sampling: 'even' },
      [],
    )
    expect(chart).toMatchObject({ displayedRows: 1, skippedNonNumeric: 2, sourceTruncated: true })
    const table = prepareReport(set, { kind: 'table', maxPoints: 10, sampling: 'even' }, [])
    expect(table.rows).toEqual(set.rows)
    expect(table.precisionApproximate).toBe(false)
  })

  it('never filters more than the explicit loaded-row work bound', () => {
    const rows = Array.from({ length: REPORT_LOADED_ROW_LIMIT + 5 }, (_, index) => [
      `row ${index}`,
      String(index),
      String(index),
    ])
    const prepared = prepareReport(result(rows), { kind: 'table', maxPoints: 5, sampling: 'even' }, [])
    expect(prepared).toMatchObject({
      loadedRows: REPORT_LOADED_ROW_LIMIT + 5,
      inspectedRows: REPORT_LOADED_ROW_LIMIT,
      filteredRows: REPORT_LOADED_ROW_LIMIT,
      displayedRows: 5,
      loadedRowsClipped: true,
      sampled: true,
    })
  })
})
