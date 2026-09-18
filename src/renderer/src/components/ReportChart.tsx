import { useMemo } from 'react'
import type { ResultSet } from '@shared/contracts'
import { prepareReport, type ReportFilter, type ReportView, type PreparedReport } from '@shared/reports'
import { cellText, gridColumnLabel } from '@shared/result-grid'

const TABLE_COLUMN_LIMIT = 50
const EXACT_POINT_LIMIT = 50
const clipped = (value: string, length = 240) =>
  value.length > length ? `${value.slice(0, length)}…` : value

function Summary({ report }: { report: PreparedReport }) {
  return (
    <>
      <p role="status" className="text-xs">
        Showing {report.displayedRows.toLocaleString()} of {report.filteredRows.toLocaleString()} filtered
        rows from {report.loadedRows.toLocaleString()} loaded rows.
      </p>
      <p className="text-xs muted">
        Loaded-result scope only; no query, file read, mutation, or network request is performed. Filters
        inspect at most {report.inspectedRows.toLocaleString()} loaded rows.{' '}
        {report.loadedRowsClipped
          ? 'The loaded result exceeded the 10,000-row report work limit; later loaded rows were not inspected.'
          : 'All loaded rows were inspected.'}{' '}
        {report.sampled ? 'Displayed rows are evenly sampled after filtering.' : 'No sampling was needed.'}{' '}
        {report.sourceTruncated
          ? 'The source result is truncated; unloaded rows are not represented.'
          : 'The source did not report truncation.'}
      </p>
    </>
  )
}

function ReportTable({ set, report }: { set: ResultSet; report: PreparedReport }) {
  const columns = set.columns.slice(0, TABLE_COLUMN_LIMIT)
  return (
    <>
      <div className="max-h-80 overflow-auto rounded border border-[var(--line)]">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} className="p-2">
                  {gridColumnLabel(set.columns, index)} <small>{column.type}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((_, columnIndex) => {
                  const exact = cellText(row[columnIndex])
                  return (
                    <td
                      key={columnIndex}
                      className="max-w-80 p-2 whitespace-pre-wrap break-all"
                      title={exact}
                    >
                      {clipped(exact)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {set.columns.length > TABLE_COLUMN_LIMIT && (
        <p className="text-xs muted">
          The report table displays the first {TABLE_COLUMN_LIMIT} of {set.columns.length} columns. Use the
          source result grid for every column and complete values.
        </p>
      )}
    </>
  )
}

function SvgChart({ report, kind }: { report: PreparedReport; kind: 'bar' | 'line' }) {
  const width = 760,
    height = 280,
    left = 48,
    right = 16,
    top = 16,
    bottom = 36
  const values = report.points.map((point) => point.numericValue)
  const dataMin = Math.min(...values),
    dataMax = Math.max(...values)
  const minimum = kind === 'bar' ? Math.min(0, dataMin) : dataMin
  const maximum = kind === 'bar' ? Math.max(0, dataMax) : dataMax
  const span = maximum === minimum ? 1 : maximum - minimum
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom
  const x = (index: number) =>
    report.points.length <= 1 ? left + plotWidth / 2 : left + (index * plotWidth) / (report.points.length - 1)
  const y = (value: number) => top + ((maximum - value) / span) * plotHeight
  const zero = y(0)
  const line = report.points.map((point, index) => `${x(index)},${y(point.numericValue)}`).join(' ')
  const barWidth = Math.max(1, Math.min(32, (plotWidth / Math.max(1, report.points.length)) * 0.75))
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full rounded border border-[var(--line)] bg-[var(--panel)]"
      role="img"
      aria-label={`${kind} chart with ${report.points.length} displayed points`}
    >
      <title>{`${kind} chart; exact source values are listed below`}</title>
      <line x1={left} x2={width - right} y1={top + plotHeight} y2={top + plotHeight} stroke="var(--line)" />
      <line x1={left} x2={left} y1={top} y2={top + plotHeight} stroke="var(--line)" />
      {kind === 'line' ? (
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={line} />
      ) : (
        report.points.map((point, index) => {
          const pointY = y(point.numericValue)
          return (
            <rect
              key={point.sourceRow}
              x={x(index) - barWidth / 2}
              y={Math.min(pointY, zero)}
              width={barWidth}
              height={Math.max(1, Math.abs(zero - pointY))}
              fill="var(--accent)"
            >
              <title>{`${cellText(point.category)}: ${cellText(point.value)}`}</title>
            </rect>
          )
        })
      )}
      <text x={left - 6} y={top + 5} textAnchor="end" fill="currentColor" fontSize="10">
        {clipped(String(maximum), 18)}
      </text>
      <text x={left - 6} y={top + plotHeight} textAnchor="end" fill="currentColor" fontSize="10">
        {clipped(String(minimum), 18)}
      </text>
      {report.points.length > 0 && (
        <>
          <text x={left} y={height - 10} textAnchor="start" fill="currentColor" fontSize="10">
            {clipped(cellText(report.points[0].category), 32)}
          </text>
          <text x={width - right} y={height - 10} textAnchor="end" fill="currentColor" fontSize="10">
            {clipped(cellText(report.points.at(-1)!.category), 32)}
          </text>
        </>
      )}
    </svg>
  )
}

export function ReportChart({
  set,
  view,
  filters,
}: {
  set: ResultSet
  view: ReportView
  filters: ReportFilter[]
}) {
  const prepared = useMemo(() => {
    try {
      return { report: prepareReport(set, view, filters) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'This report cannot be prepared.' }
    }
  }, [set, view, filters])
  if ('error' in prepared)
    return (
      <p role="alert" className="text-sm text-[var(--danger)]">
        {prepared.error}
      </p>
    )
  const report = prepared.report!
  return (
    <div className="grid gap-2">
      <Summary report={report} />
      {view.kind === 'table' ? (
        <ReportTable set={set} report={report} />
      ) : report.points.length ? (
        <>
          <SvgChart report={report} kind={view.kind} />
          <p className="text-xs muted">
            Chart geometry converts numeric values to JavaScript numbers; exact received labels and values
            remain listed below.{' '}
            {report.precisionApproximate
              ? 'At least one displayed textual or unsafe-integer value required an approximate numeric conversion.'
              : 'Displayed numeric values did not require a detected unsafe-integer conversion.'}{' '}
            {report.skippedNonNumeric
              ? `${report.skippedNonNumeric.toLocaleString()} filtered rows with NULL, binary, boolean, or nonnumeric values were omitted.`
              : 'No filtered rows were omitted as nonnumeric.'}
          </p>
          <div className="max-h-48 overflow-auto rounded border border-[var(--line)]">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="p-2">Source row</th>
                  <th className="p-2">Exact category</th>
                  <th className="p-2">Exact value</th>
                </tr>
              </thead>
              <tbody>
                {report.points.slice(0, EXACT_POINT_LIMIT).map((point) => (
                  <tr key={point.sourceRow}>
                    <td className="p-2">{point.sourceRow + 1}</td>
                    <td className="p-2 break-all">{clipped(cellText(point.category))}</td>
                    <td className="p-2 break-all">{clipped(cellText(point.value))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.points.length > EXACT_POINT_LIMIT && (
            <p className="text-xs muted">
              Exact-value list shows the first {EXACT_POINT_LIMIT} displayed points. The chart still uses all{' '}
              {report.points.length} displayed points.
            </p>
          )}
        </>
      ) : (
        <p className="center-empty">No numeric values remain after applying the loaded-result filters.</p>
      )}
    </div>
  )
}
