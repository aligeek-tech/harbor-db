import { describe, expect, it } from 'vitest'
import { savedQuerySchema, type HistoryEntry, type ResultColumn } from '../src/shared/contracts'
import {
  compareGridRows,
  gridClipboard,
  gridColumnLabel,
  inspectCell,
  matchesGridFilter,
} from '../src/shared/result-grid'
import { emptyHistoryFilters, historyMatches, updateQueryMetadata } from '../src/shared/query-library'

const columns: ResultColumn[] = [
  { name: 'id', type: 'bigint' },
  { name: 'id', type: 'decimal' },
  { name: 'label', type: 'text' },
]

describe('loaded grid operations', () => {
  it('preserves duplicate column identity and uses precise lexicographic multi-sort with stable ties', () => {
    expect(gridColumnLabel(columns, 0)).toBe('id (column 1)')
    expect(gridColumnLabel(columns, 1)).toBe('id (column 2)')
    const rows = [
      ['9007199254740993', '9', 'a'],
      ['9007199254740992', '10', 'b'],
      ['9007199254740992', '11', 'c'],
      ['9007199254740992', '11', 'd'],
    ].map((values, index) => ({ values, index }))
    const sorts = [
      { index: 0, column: 'id', direction: 'asc' as const },
      { index: 1, column: 'id', direction: 'desc' as const },
    ]
    expect([...rows].sort((a, b) => compareGridRows(a, b, columns, sorts)).map((row) => row.index)).toEqual([
      2, 3, 1, 0,
    ])
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3])
  })
  it('keeps NULL, empty string, and numeric comparisons distinct', () => {
    expect(matchesGridFilter([null, '1', ''], columns, { index: 0, operator: 'is null', value: '' })).toBe(
      true,
    )
    expect(matchesGridFilter([null, '1', ''], columns, { index: 2, operator: 'is empty', value: '' })).toBe(
      true,
    )
    expect(matchesGridFilter([null, '1', ''], columns, { index: 0, operator: 'equals', value: 'NULL' })).toBe(
      false,
    )
    expect(
      matchesGridFilter(['9007199254740993', '1', ''], columns, {
        index: 0,
        operator: 'greater than',
        value: '9007199254740992',
      }),
    ).toBe(true)
    expect(
      matchesGridFilter(['1', '1', 'Hello'], columns, { index: 2, operator: 'contains', value: 'ELL' }),
    ).toBe(true)
  })
  it('quotes multiline CSV, protects spreadsheet formulas and preserves typed JSON', () => {
    const rows = [
      ['=1+1', null, 'line 1\nline "2"'],
      ['3', '4', ''],
    ]
    expect(gridClipboard('csv', columns, rows)).toBe('id,id,label\n\'=1+1,NULL,"line 1\nline ""2"""\n3,4,')
    expect(JSON.parse(gridClipboard('json', columns, rows))).toEqual({ columns, rows })
  })
  it('provides unchanged multiline, JSON and binary previews without evaluating content', () => {
    expect(inspectCell('line1\nline2', 'raw')).toBe('line1\nline2')
    expect(inspectCell('{"x":1}', 'json')).toBe('{\n  "x": 1\n}')
    expect(
      inspectCell('{"id":9007199254740993,"precise":1.2300000000000000001,"nested":[{}," x "]}', 'json'),
    ).toBe(
      '{\n  "id": 9007199254740993,\n  "precise": 1.2300000000000000001,\n  "nested": [\n    {},\n    " x "\n  ]\n}',
    )
    expect(inspectCell('{oops', 'json')).toContain('not valid JSON')
    expect(inspectCell({ type: 'binary', base64: 'AP8K' }, 'hex')).toBe('00 ff 0a')
    expect(inspectCell(null, 'raw')).not.toBe(inspectCell('', 'raw'))
  })
})

describe('query library metadata and history', () => {
  const entry: HistoryEntry = {
    id: 'h',
    connectionId: 'c',
    sql: 'SELECT 1',
    executedAt: new Date(2026, 8, 18, 12).toISOString(),
    durationMs: 120,
    rowCount: 25,
    success: true,
  }
  it('edits organization without changing SQL, target or parameter definitions', () => {
    const query = savedQuerySchema.parse({
      id: 'q',
      name: 'Before',
      sql: 'SELECT :value;',
      engine: 'postgres',
      connectionId: 'c',
      database: 'db',
      schema: 'public',
      updatedAt: '2026-01-01',
      parameterDefinitions: [{ name: 'value', type: 'text', secret: true }],
    })
    const result = updateQueryMetadata(query, ' After ', 'Reports', ' daily, safe, daily, ')
    expect(result).toMatchObject({
      ...query,
      name: 'After',
      folder: 'Reports',
      tags: ['daily', 'safe'],
      updatedAt: expect.any(String),
    })
    expect(query.name).toBe('Before')
    expect(result.sql).toBe(query.sql)
    expect(result.parameterDefinitions).toEqual(query.parameterDefinitions)
    expect(() => updateQueryMetadata(query, ' ', '', '')).toThrow()
  })
  it('combines explicit connection, inclusive local date, duration, row count and outcome filters', () => {
    const filters = {
      ...emptyHistoryFilters,
      connectionId: 'c',
      after: '2026-09-18',
      before: '2026-09-18',
      outcome: 'success' as const,
      minDuration: '100',
      maxDuration: '120',
      minRows: '25',
      maxRows: '25',
    }
    expect(historyMatches(entry, filters)).toBe(true)
    expect(historyMatches({ ...entry, rowCount: 26 }, filters)).toBe(false)
    expect(historyMatches({ ...entry, connectionId: 'other' }, filters)).toBe(false)
    expect(historyMatches({ ...entry, executedAt: new Date(2026, 8, 19).toISOString() }, filters)).toBe(false)
    expect(
      historyMatches(
        { ...entry, success: false, error: 'Cancelled: requested by user' },
        { ...emptyHistoryFilters, outcome: 'cancelled' },
      ),
    ).toBe(true)
    expect(
      historyMatches(
        { ...entry, success: false, error: 'Not allowed' },
        { ...emptyHistoryFilters, outcome: 'failed' },
      ),
    ).toBe(true)
  })
})
