import { useState } from 'react'
import { BarChart3, FileChartColumn, Plus, Trash2 } from 'lucide-react'
import type { ConnectionProfile, ResultSet, WorkspaceTab } from '@shared/contracts'
import {
  REPORT_FILTER_LIMIT,
  reportDefinitionSchema,
  type ReportDefinition,
  type ReportFilter,
  type ReportView,
} from '@shared/reports'
import { gridColumnLabel } from '@shared/result-grid'
import { uid } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ReportChart } from './ReportChart'

const operators: ReportFilter['operator'][] = [
  'contains',
  'equals',
  'not equals',
  'is null',
  'is not null',
  'is empty',
]
const needsValue = (operator: ReportFilter['operator']) =>
  !['is null', 'is not null', 'is empty'].includes(operator)

function freshReport(profile: ConnectionProfile, tab: WorkspaceTab): ReportDefinition {
  const now = new Date().toISOString()
  return reportDefinitionSchema.parse({
    id: uid(),
    name: `${tab.title} report`,
    engine: 'duckdb',
    connectionId: profile.id,
    database: tab.database || profile.database || undefined,
    sql: tab.sql,
    parameterDefinitions: tab.parameterDefinitions || [],
    view: { kind: 'table', maxPoints: 200, sampling: 'even' },
    filters: [],
    createdAt: now,
    updatedAt: now,
  })
}

export function AnalyticsReports({
  profile,
  tab,
  set,
  reports,
  activeReportId,
  onSave,
  onDelete,
  onOpen,
}: {
  profile: ConnectionProfile
  tab: WorkspaceTab
  set?: ResultSet
  reports: ReportDefinition[]
  activeReportId?: string
  onSave: (report: ReportDefinition) => Promise<ReportDefinition>
  onDelete: (id: string) => Promise<void>
  onOpen: (report: ReportDefinition) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ReportDefinition>()
  const [disclosed, setDisclosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  if (profile.engine !== 'duckdb') return null

  const update = (changes: Partial<ReportDefinition>) =>
    setDraft((current) => (current ? { ...current, ...changes } : current))
  const updateView = (changes: Partial<ReportView>) =>
    setDraft((current) =>
      current ? ({ ...current, view: { ...current.view, ...changes } } as ReportDefinition) : current,
    )
  const openNew = () => {
    setError('')
    setMessage('')
    setDisclosed(false)
    try {
      setDraft(freshReport(profile, tab))
      setOpen(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This query cannot be saved as a report.')
      setOpen(true)
    }
  }
  const show = () => {
    const saved = reports.find((report) => report.id === activeReportId)
    if (!saved) return openNew()
    setDraft(saved)
    setError('')
    setMessage('Saved chart, filters, and sampling restored. Run the query explicitly to load data.')
    setDisclosed(false)
    setOpen(true)
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={show} disabled={!tab.sql.trim()}>
        <BarChart3 />
        Reports
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="flex max-h-[92vh] max-w-6xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Local analytics reports</DialogTitle>
            <DialogDescription>
              Target: {profile.name} · DuckDB · {tab.database || profile.database || 'main'} ·{' '}
              {profile.environment}. Reports use the current loaded result for preview and never execute,
              mutate, read another file, or send data remotely when opened.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 grid-cols-[minmax(15rem,0.34fr)_minmax(0,1fr)] gap-4 overflow-hidden">
            <section className="min-h-0 overflow-auto rounded border border-[var(--line)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3>Saved definitions</h3>
                <Button variant="outline" size="sm" onClick={openNew}>
                  <Plus /> New
                </Button>
              </div>
              <p className="mb-3 text-xs muted">
                Opening creates an inert query draft. A compatible DuckDB target must be chosen when a saved
                binding is missing; execution always remains explicit.
              </p>
              {reports.length ? (
                <div className="grid gap-2">
                  {reports.map((report) => (
                    <div key={report.id} className="rounded border border-[var(--line)] p-2">
                      <strong>{report.name}</strong>
                      <p className="text-xs muted">
                        {report.view.kind} · {report.filters.length} filters ·{' '}
                        {report.connectionId ? 'bound target' : 'target required'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Button variant="outline" size="sm" onClick={() => onOpen(report)}>
                          Open inert draft
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={report.connectionId !== profile.id}
                          onClick={() => {
                            setDraft(report)
                            setDisclosed(false)
                            setMessage('')
                            setError('')
                          }}
                        >
                          Edit with current result
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true)
                            setError('')
                            try {
                              await onDelete(report.id)
                              if (draft?.id === report.id) setDraft(undefined)
                            } catch (failure) {
                              setError(
                                failure instanceof Error
                                  ? failure.message
                                  : 'The report could not be deleted.',
                              )
                            } finally {
                              setBusy(false)
                            }
                          }}
                        >
                          <Trash2 /> Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="center-empty">No saved report definitions.</p>
              )}
            </section>
            <section className="min-h-0 overflow-auto pr-1">
              {draft ? (
                <div className="grid gap-3">
                  <label>
                    Report name
                    <Input
                      aria-label="Report name"
                      value={draft.name}
                      maxLength={255}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label>
                      View
                      <select
                        aria-label="Report view"
                        value={draft.view.kind}
                        onChange={(event) => {
                          const kind = event.target.value as ReportView['kind']
                          update({
                            view:
                              kind === 'table'
                                ? { kind, maxPoints: draft.view.maxPoints, sampling: 'even' }
                                : {
                                    kind,
                                    categoryColumn: 0,
                                    valueColumn: Math.min(1, Math.max(0, (set?.columns.length || 1) - 1)),
                                    maxPoints: draft.view.maxPoints,
                                    sampling: 'even',
                                  },
                          })
                        }}
                      >
                        <option value="table">Table</option>
                        <option value="bar">Bar chart</option>
                        <option value="line">Line chart</option>
                      </select>
                    </label>
                    <label>
                      Point / row limit
                      <Input
                        aria-label="Report point limit"
                        type="number"
                        min={1}
                        max={500}
                        value={draft.view.maxPoints}
                        onChange={(event) => updateView({ maxPoints: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      Sampling
                      <select aria-label="Report sampling" value="even" disabled>
                        <option value="even">Even after filters</option>
                      </select>
                    </label>
                  </div>
                  {draft.view.kind !== 'table' && set && (
                    <div className="grid grid-cols-2 gap-2">
                      <label>
                        Category column
                        <select
                          aria-label="Report category column"
                          value={draft.view.categoryColumn}
                          onChange={(event) => updateView({ categoryColumn: Number(event.target.value) })}
                        >
                          {set.columns.map((column, index) => (
                            <option key={index} value={index}>
                              {gridColumnLabel(set.columns, index)} · {column.type}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Numeric value column
                        <select
                          aria-label="Report value column"
                          value={draft.view.valueColumn}
                          onChange={(event) => updateView({ valueColumn: Number(event.target.value) })}
                        >
                          {set.columns.map((column, index) => (
                            <option key={index} value={index}>
                              {gridColumnLabel(set.columns, index)} · {column.type}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3>Loaded-result filters</h3>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!set?.columns.length || draft.filters.length >= REPORT_FILTER_LIMIT}
                        onClick={() =>
                          update({
                            filters: [...draft.filters, { column: 0, operator: 'equals', value: '' }],
                          })
                        }
                      >
                        <Plus /> Add filter
                      </Button>
                    </div>
                    {draft.filters.map((filter, index) => (
                      <div key={index} className="mb-2 grid grid-cols-[1fr_10rem_1fr_auto] gap-2">
                        <select
                          aria-label={`Report filter ${index + 1} column`}
                          value={filter.column}
                          onChange={(event) => {
                            const filters = [...draft.filters]
                            filters[index] = { ...filter, column: Number(event.target.value) }
                            update({ filters })
                          }}
                        >
                          {(set?.columns || []).map((column, columnIndex) => (
                            <option key={columnIndex} value={columnIndex}>
                              {gridColumnLabel(set!.columns, columnIndex)} · {column.type}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`Report filter ${index + 1} operator`}
                          value={filter.operator}
                          onChange={(event) => {
                            const filters = [...draft.filters]
                            filters[index] = {
                              ...filter,
                              operator: event.target.value as ReportFilter['operator'],
                            }
                            update({ filters })
                          }}
                        >
                          {operators.map((operator) => (
                            <option key={operator} value={operator}>
                              {operator}
                            </option>
                          ))}
                        </select>
                        <Input
                          aria-label={`Report filter ${index + 1} value`}
                          value={filter.value}
                          disabled={!needsValue(filter.operator)}
                          onChange={(event) => {
                            const filters = [...draft.filters]
                            filters[index] = { ...filter, value: event.target.value }
                            update({ filters })
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove report filter ${index + 1}`}
                          onClick={() =>
                            update({ filters: draft.filters.filter((_, item) => item !== index) })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                    <p className="text-xs muted">
                      Up to {REPORT_FILTER_LIMIT} filters are applied only to the loaded page, before even
                      sampling. Filter text is part of the saved definition and may be sensitive.
                    </p>
                  </div>
                  {set ? (
                    <ReportChart set={set} view={draft.view} filters={draft.filters} />
                  ) : (
                    <p className="center-empty">
                      Run the report query explicitly to load a result before previewing its table or chart.
                    </p>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={disclosed}
                      onChange={(event) => setDisclosed(event.target.checked)}
                    />
                    Save this read-only SQL, parameter names/types, chart settings, and filter text locally.
                    Parameter values, loaded rows, file grants, credentials, and remote locations are never
                    included.
                  </label>
                  {error && (
                    <p role="alert" className="text-sm text-[var(--danger)]">
                      {error}
                    </p>
                  )}
                  {message && <p role="status">{message}</p>}
                  <div className="dialog-actions">
                    <Button
                      disabled={busy || !disclosed || !draft.name.trim()}
                      onClick={async () => {
                        setBusy(true)
                        setError('')
                        setMessage('')
                        try {
                          const validated = reportDefinitionSchema.parse({
                            ...draft,
                            name: draft.name.trim(),
                            updatedAt: new Date().toISOString(),
                          })
                          const saved = await onSave(validated)
                          setDraft(saved)
                          setMessage('Report definition saved locally. It was not executed.')
                          setDisclosed(false)
                        } catch (failure) {
                          setError(
                            failure instanceof Error
                              ? failure.message
                              : 'The report definition could not be saved.',
                          )
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      <FileChartColumn /> Save definition
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="center-empty">Choose a saved definition or create a new report.</p>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
