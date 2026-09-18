import { useEffect, useMemo, useState } from 'react'
import { Clock3, FolderOpen, Play, RotateCw, Trash2 } from 'lucide-react'
import type { AutomationDefinition, AutomationRun } from '@shared/automation'
import type { ImportPreview } from '@shared/imports'
import { api, isDesktop } from '../lib/api'
import { errorText, uid } from '../lib/utils'
import { useApp } from '../store'
import { ErrorPanel } from './common'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Snapshot = { definitions: AutomationDefinition[]; runs: AutomationRun[]; runningTaskId?: string }

export function AutomationSettings() {
  const profiles = useApp((state) => state.profiles)
  const reports = useApp((state) => state.reports)
  const [snapshot, setSnapshot] = useState<Snapshot>({ definitions: [], runs: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [kind, setKind] = useState<'report' | 'export' | 'import'>('report')
  const [name, setName] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [reportId, setReportId] = useState('')
  const [sql, setSql] = useState('SELECT 1;')
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv')
  const [directory, setDirectory] = useState('')
  const [schema, setSchema] = useState('public')
  const [table, setTable] = useState('')
  const [mapping, setMapping] = useState('0:id:integer')
  const [daily, setDaily] = useState(false)
  const [hour, setHour] = useState('3')
  const [minute, setMinute] = useState('0')
  const [enabled, setEnabled] = useState(false)
  const [importPreview, setImportPreview] = useState<{ taskId: string; value: ImportPreview }>()
  const [importBatchConsent, setImportBatchConsent] = useState(false)
  const [importAppendConsent, setImportAppendConsent] = useState(false)
  const selected = profiles.find((profile) => profile.id === connectionId)
  const matchingReports = reports.filter((report) => !connectionId || report.connectionId === connectionId)
  const recentRuns = useMemo(() => snapshot.runs.slice(0, 20), [snapshot.runs])

  async function refresh() {
    if (!isDesktop) return
    setError('')
    try {
      setSnapshot(await api.listAutomations())
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (!snapshot.runningTaskId) return
    const timer = window.setInterval(() => { void refresh() }, 250)
    return () => window.clearInterval(timer)
  }, [snapshot.runningTaskId])
  useEffect(() => {
    if (!connectionId && profiles[0]) setConnectionId(profiles[0].id)
  }, [connectionId, profiles])
  useEffect(() => {
    if (kind === 'report' && !matchingReports.some((report) => report.id === reportId))
      setReportId(matchingReports[0]?.id || '')
  }, [kind, matchingReports, reportId])

  async function perform(id: string, operation: () => Promise<void>) {
    setBusy(id)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function save() {
    const now = new Date().toISOString()
    const schedule: AutomationDefinition['schedule'] = daily
      ? { kind: 'daily', hour: Number(hour), minute: Number(minute), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local' }
      : { kind: 'manual' }
    let target: AutomationDefinition['target']
    if (kind === 'report') target = { kind, connectionId, reportId }
    else if (kind === 'export')
      target = { kind, connectionId, sql, format, spreadsheetSafe: true, outputDirectory: directory }
    else {
      const parsedMapping = mapping.split(',').map((entry) => {
        const [source, target, type] = entry.trim().split(':')
        return { source: Number(source), target, type: type as 'text' }
      })
      target = {
        kind, connectionId,
        target: { connectionId, schema, table },
        options: { format, encoding: 'utf8', delimiter: ',', header: true, nullToken: '\\N' },
        mapping: parsedMapping,
        batchSize: 100,
        errorPolicy: 'stop',
      }
    }
    await perform('save', async () => {
      await api.saveAutomation({
        id: uid(), name, enabled, schedule, target,
        limits: { maxDurationMs: 300_000, maxRows: 100_000, maxOutputBytes: 268_435_456 },
        createdAt: now, updatedAt: now,
      })
      setName('')
    })
  }

  async function run(task: AutomationDefinition) {
    if (task.target.kind === 'import') {
      await perform(`preview-${task.id}`, async () => {
        const value = await api.previewAutomationImport(task.id)
        if (value) {
          setImportPreview({ taskId: task.id, value })
          setImportBatchConsent(false)
          setImportAppendConsent(false)
        }
      })
      return
    }
    await perform(`run-${task.id}`, async () => { await api.runAutomation({ id: task.id }) })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Reusable jobs run only while this desktop app is open and the visible target is connected. Missed
        schedules are recorded and never backfilled. Jobs are disabled by default; production targets cannot
        be enabled. Only one job runs at a time, with a 5-minute, 100,000-row and 256 MiB default limit.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-sm">Kind
          <select className="mt-1 w-full" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="report">Saved report</option>
            <option value="export">Streaming export</option>
            <option value="import">Freshly reviewed import</option>
          </select>
        </label>
        <label className="text-sm">Name<Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="text-sm">Visible target
          <select className="mt-1 w-full" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.environment}</option>)}
          </select>
        </label>
      </div>
      {kind === 'report' && (
        <label className="text-sm">Saved DuckDB report
          <select className="mt-1 w-full" value={reportId} onChange={(event) => setReportId(event.target.value)}>
            {matchingReports.map((report) => <option value={report.id} key={report.id}>{report.name}</option>)}
          </select>
        </label>
      )}
      {kind === 'export' && (
        <div className="space-y-2">
          <textarea aria-label="Reusable export SQL" rows={4} value={sql} onChange={(event) => setSql(event.target.value)} />
          <div className="flex gap-2">
            <select aria-label="Reusable export format" value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
              <option value="csv">CSV</option><option value="jsonl">JSONL</option>
            </select>
            <Button variant="outline" onClick={() => void perform('directory', async () => setDirectory((await api.chooseAutomationDirectory()) || directory))}>
              <FolderOpen /> Choose destination
            </Button>
            <span className="truncate text-xs" title={directory}>{directory || 'No destination selected'}</span>
          </div>
        </div>
      )}
      {kind === 'import' && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-sm">Schema<Input value={schema} onChange={(event) => setSchema(event.target.value)} /></label>
          <label className="text-sm">Table<Input value={table} onChange={(event) => setTable(event.target.value)} /></label>
          <label className="text-sm">Mappings<Input value={mapping} onChange={(event) => setMapping(event.target.value)} /></label>
          <p className="text-xs sm:col-span-3">Mappings use source-index:target:type, comma-separated. Every run still requires a fresh file selection and bounded preview; no source path or grant persists.</p>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm"><input type="checkbox" checked={daily} onChange={(event) => setDaily(event.target.checked)} /> Daily local schedule</label>
        {daily && <><label className="text-sm">Hour<Input className="w-20" type="number" min="0" max="23" value={hour} onChange={(event) => setHour(event.target.value)} /></label><label className="text-sm">Minute<Input className="w-20" type="number" min="0" max="59" value={minute} onChange={(event) => setMinute(event.target.value)} /></label></>}
        <label className="text-sm"><input type="checkbox" checked={enabled} disabled={selected?.environment.toLowerCase() === 'production'} onChange={(event) => setEnabled(event.target.checked)} /> Explicitly enable</label>
        <Button disabled={!!busy || !name || !connectionId || (kind === 'report' && !reportId) || (kind === 'export' && !directory) || (kind === 'import' && (!table || !mapping))} onClick={() => void save()}>
          <Clock3 /> Save reusable task
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => void refresh()}><RotateCw /> Refresh</Button>
      </div>
      {error && <ErrorPanel message={error} />}
      {importPreview && (
        <div className="rounded border p-3 text-sm">
          <strong>Fresh import review:</strong> {importPreview.value.name} · {importPreview.value.bytes} bytes · columns {importPreview.value.columns.join(', ')} · {importPreview.value.rows.length} preview rows.
          {(() => {
            const task = snapshot.definitions.find((item) => item.id === importPreview.taskId)
            if (!task || task.target.kind !== 'import') return null
            return (
              <div className="mt-2 space-y-1 text-xs">
                <p><strong>Destination:</strong> {task.target.connectionId}/{task.target.target.database ?? '(default)'}/{task.target.target.schema}/{task.target.target.table}</p>
                <p><strong>Mapping:</strong> {task.target.mapping.map((item) => `${item.source} → ${item.target}:${item.type}`).join(', ')}</p>
                <p><strong>Policy:</strong> batches of {task.target.batchSize}; {task.target.errorPolicy}; limits {task.limits.maxRows.toLocaleString()} rows / {task.limits.maxOutputBytes.toLocaleString()} source bytes.</p>
              </div>
            )
          })()}
          {importPreview.value.warnings.map((warning) => <p className="text-xs" key={warning}>{warning}</p>)}
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={importBatchConsent} onChange={(event) => setImportBatchConsent(event.target.checked)} />
            I reviewed that each batch may commit independently and earlier acknowledged batches remain after cancellation or failure.
          </label>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={importAppendConsent} onChange={(event) => setImportAppendConsent(event.target.checked)} />
            I reviewed that a non-transactional driver may append rows with no rollback, retry, or replay.
          </label>
          <div className="mt-2 flex gap-2">
            <Button disabled={!!busy || !importBatchConsent || !importAppendConsent} onClick={() => void perform(`run-${importPreview.taskId}`, async () => { await api.runAutomation({ id: importPreview.taskId, sourceId: importPreview.value.sourceId, consentBatchCommits: true, consentNonTransactionalAppend: true }); setImportPreview(undefined) })}>Run this reviewed import once</Button>
            <Button variant="outline" onClick={() => { setImportPreview(undefined); setImportBatchConsent(false); setImportAppendConsent(false) }}>Discard grant</Button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {snapshot.definitions.map((task) => (
          <div className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm" key={task.id}>
            <strong>{task.name}</strong><span>{task.target.kind} · {profiles.find((profile) => profile.id === task.target.connectionId)?.name || 'missing target'}</span>
            <span>{task.enabled ? `enabled · next ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : 'manual'}` : 'disabled'}</span>
            <Button size="sm" disabled={!!busy || snapshot.runningTaskId === task.id} onClick={() => void run(task)}><Play /> {task.target.kind === 'import' ? 'Review source' : 'Run now'}</Button>
            {snapshot.runningTaskId === task.id && <Button size="sm" variant="destructive" onClick={() => void perform(`cancel-${task.id}`, async () => { await api.cancelAutomation(task.id) })}>Cancel</Button>}
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void perform(`toggle-${task.id}`, async () => { await api.saveAutomation({ ...task, enabled: !task.enabled }) })}>{task.enabled ? 'Disable' : 'Enable'}</Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void perform(`delete-${task.id}`, async () => { await api.deleteAutomation(task.id) })}><Trash2 /> Delete</Button>
          </div>
        ))}
      </div>
      {!!recentRuns.length && <div className="max-h-48 overflow-auto rounded border p-2 text-xs">{recentRuns.map((run) => <p key={run.id}><strong>{run.state}</strong> · {run.code} · {new Date(run.startedAt).toLocaleString()} · {run.message}</p>)}</div>}
    </div>
  )
}
