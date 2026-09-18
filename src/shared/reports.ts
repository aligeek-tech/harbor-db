import { z } from 'zod'
import { parameterDefinitionSchema } from './parameters'
import { matchesGridFilter, type GridFilter } from './result-grid'
import { sqlSafety } from './sql'
import type { Cell, ResultSet } from './contracts'

export const REPORT_LOADED_ROW_LIMIT = 10_000
export const REPORT_POINT_LIMIT = 500
export const REPORT_FILTER_LIMIT = 8

export const reportFilterSchema = z
  .object({
    column: z.number().int().min(0).max(999),
    operator: z.enum(['contains', 'equals', 'not equals', 'is null', 'is not null', 'is empty']),
    value: z.string().max(10_000).default(''),
  })
  .strict()

const reportViewBase = {
  maxPoints: z.number().int().min(1).max(REPORT_POINT_LIMIT).default(200),
  sampling: z.literal('even').default('even'),
}
export const reportViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('table'), ...reportViewBase }).strict(),
  z
    .object({
      kind: z.literal('bar'),
      categoryColumn: z.number().int().min(0).max(999),
      valueColumn: z.number().int().min(0).max(999),
      ...reportViewBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal('line'),
      categoryColumn: z.number().int().min(0).max(999),
      valueColumn: z.number().int().min(0).max(999),
      ...reportViewBase,
    })
    .strict(),
])

export const reportDefinitionSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(255),
    engine: z.literal('duckdb'),
    connectionId: z.string().min(1).max(100).optional(),
    database: z.string().min(1).max(255).optional(),
    sql: z.string().min(1).max(1_000_000),
    parameterDefinitions: z.array(parameterDefinitionSchema).max(100).default([]),
    view: reportViewSchema.default({ kind: 'table', maxPoints: 200, sampling: 'even' }),
    filters: z.array(reportFilterSchema).max(REPORT_FILTER_LIMIT).default([]),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((report, context) => {
    try {
      const safety = sqlSafety(report.sql, 'duckdb')
      if (!safety.readOnly || safety.statementCount !== 1)
        context.addIssue({
          code: 'custom',
          path: ['sql'],
          message: 'Reports can save exactly one read-only DuckDB query only.',
        })
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['sql'],
        message: 'Enter one complete read-only DuckDB query.',
      })
    }
    if (report.view.kind !== 'table' && report.view.categoryColumn === report.view.valueColumn)
      context.addIssue({
        code: 'custom',
        path: ['view', 'valueColumn'],
        message: 'Choose different category and value columns.',
      })
  })

export type ReportFilter = z.infer<typeof reportFilterSchema>
export type ReportView = z.infer<typeof reportViewSchema>
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>

export interface PreparedReportPoint {
  sourceRow: number
  category: Cell
  value: Cell
  numericValue: number
  approximate: boolean
}

export interface PreparedReport {
  kind: ReportView['kind']
  rows: Cell[][]
  points: PreparedReportPoint[]
  loadedRows: number
  inspectedRows: number
  filteredRows: number
  displayedRows: number
  skippedNonNumeric: number
  loadedRowsClipped: boolean
  sampled: boolean
  sourceTruncated: boolean
  precisionApproximate: boolean
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items
  if (limit === 1) return [items[0]]
  const last = items.length - 1
  return Array.from({ length: limit }, (_, index) => items[Math.floor((index * last) / (limit - 1))])
}

function chartNumber(value: Cell): { value: number; approximate: boolean } | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return { value, approximate: Number.isInteger(value) && !Number.isSafeInteger(value) }
  }
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    return undefined
  const converted = Number(value)
  return Number.isFinite(converted) ? { value: converted, approximate: true } : undefined
}

function filterRows(set: ResultSet, filters: ReportFilter[]) {
  const inspected = set.rows.slice(0, REPORT_LOADED_ROW_LIMIT).map((row, sourceRow) => ({ row, sourceRow }))
  const preparedFilters: GridFilter[] = filters.map((filter) => ({
    index: filter.column,
    operator: filter.operator,
    value: filter.value,
  }))
  return {
    inspected,
    matched: inspected.filter(({ row }) =>
      preparedFilters.every((filter) => matchesGridFilter(row, set.columns, filter)),
    ),
  }
}

/**
 * Prepares an already-loaded result only. It never runs SQL, reads a file, or
 * performs network work. Ordinal column indexes preserve duplicate labels.
 */
export function prepareReport(set: ResultSet, view: ReportView, filters: ReportFilter[]): PreparedReport {
  const parsedView = reportViewSchema.parse(view)
  const parsedFilters = z.array(reportFilterSchema).max(REPORT_FILTER_LIMIT).parse(filters)
  const { inspected, matched } = filterRows(set, parsedFilters)
  const common = {
    kind: parsedView.kind,
    loadedRows: set.rows.length,
    inspectedRows: inspected.length,
    filteredRows: matched.length,
    loadedRowsClipped: set.rows.length > REPORT_LOADED_ROW_LIMIT,
    sourceTruncated: set.truncated,
  }
  if (parsedView.kind === 'table') {
    const sampled = evenlySample(matched, parsedView.maxPoints)
    return {
      ...common,
      rows: sampled.map(({ row }) => row),
      points: [],
      displayedRows: sampled.length,
      skippedNonNumeric: 0,
      sampled: sampled.length < matched.length,
      precisionApproximate: false,
    }
  }
  if (!set.columns[parsedView.categoryColumn] || !set.columns[parsedView.valueColumn])
    throw new Error('The saved chart column no longer exists in this result.')
  const points: PreparedReportPoint[] = []
  let skippedNonNumeric = 0
  for (const { row, sourceRow } of matched) {
    const converted = chartNumber(row[parsedView.valueColumn])
    if (!converted) {
      skippedNonNumeric++
      continue
    }
    points.push({
      sourceRow,
      category: row[parsedView.categoryColumn],
      value: row[parsedView.valueColumn],
      numericValue: converted.value,
      approximate: converted.approximate,
    })
  }
  const sampled = evenlySample(points, parsedView.maxPoints)
  return {
    ...common,
    rows: [],
    points: sampled,
    displayedRows: sampled.length,
    skippedNonNumeric,
    sampled: sampled.length < points.length,
    precisionApproximate: sampled.some((point) => point.approximate),
  }
}
