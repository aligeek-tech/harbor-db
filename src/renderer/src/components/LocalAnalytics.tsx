import { useState } from 'react'
import type { ConnectionProfile, QueryResult, WorkspaceTab } from '@shared/contracts'
import type { AnalyticsFileGrant } from '@shared/analytics'
import { FileInput } from 'lucide-react'
import { api } from '../lib/api'
import { errorText, uid } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { DataGrid } from './DataGrid'
import { ErrorPanel, useConfirm } from './common'

export function LocalAnalytics({
  profile,
  tab,
  disabled,
}: {
  profile: ConnectionProfile
  tab: WorkspaceTab
  disabled: boolean
}) {
  const [open, setOpen] = useState(false),
    [format, setFormat] = useState<'csv' | 'json' | 'parquet'>('csv')
  const [file, setFile] = useState<AnalyticsFileGrant>(),
    [result, setResult] = useState<QueryResult>()
  const [target, setTarget] = useState('imported_data'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('')
  const [requestId, setRequestId] = useState(''),
    [outcome, setOutcome] = useState('')
  const confirm = useConfirm()
  const sessionId = `file-${tab.id}`
  if (profile.engine !== 'duckdb') return null
  async function preview() {
    if (!file) return
    const id = uid()
    useApp.getState().setRuntime(tab.id, { running: true, requestId: id })
    setRequestId(id)
    setBusy('preview')
    setError('')
    setResult(undefined)
    try {
      setResult(
        await api.previewAnalyticsFile({
          connectionId: profile.id,
          sessionId,
          requestId: id,
          token: file.token,
        }),
      )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      if (useApp.getState().runtime[tab.id]?.requestId === id)
        useApp.getState().setRuntime(tab.id, { running: false })
      setBusy('')
      setRequestId('')
      await api.closeSession({ connectionId: profile.id, sessionId }).catch(() => {})
    }
  }
  return (
    <>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <FileInput />
        Explore local file
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle>Explore a local data file</DialogTitle>
            <DialogDescription>
              DuckDB target: {profile.name} · main · {profile.environment}. One selected CSV, JSON, or Parquet
              file is allowed for 15 minutes. No network access or extension download is enabled.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <select
              aria-label="Local file format"
              value={format}
              disabled={!!busy}
              onChange={(event) => {
                setFormat(event.target.value as typeof format)
                setFile(undefined)
                setResult(undefined)
                setOutcome('')
              }}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON / JSONL</option>
              <option value="parquet">Parquet</option>
            </select>
            <Button
              disabled={!!busy}
              variant="outline"
              onClick={async () => {
                setError('')
                setResult(undefined)
                setOutcome('')
                try {
                  const selected = await api.chooseAnalyticsFile({ connectionId: profile.id, format })
                  if (selected) setFile(selected)
                } catch (failure) {
                  setError(errorText(failure))
                }
              }}
            >
              Choose data file…
            </Button>
            {file && (
              <span>
                {file.name} · {file.bytes.toLocaleString()} bytes
              </span>
            )}
            <Button disabled={!file || !!busy} onClick={() => void preview()}>
              Preview first 200 rows
            </Button>
          </div>
          <p className="text-xs muted">
            Schema inference and preview sample the file. Later rows can still fail validation. Import creates
            a new table in one transaction; it never overwrites a table or modifies the source file.
          </p>
          {error && <ErrorPanel message={error} />}
          {outcome && <p role="status">{outcome}</p>}
          {busy && (
            <div role="status">
              {busy === 'preview' ? 'Reading bounded preview…' : 'Importing in a transaction…'}{' '}
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const state = await api.cancel({ connectionId: profile.id, sessionId, requestId })
                    setOutcome(state.message)
                  } catch (failure) {
                    setError(errorText(failure))
                  }
                }}
              >
                Cancel file operation
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            {result?.sets[0] ? (
              <DataGrid
                set={result.sets[0]}
                tab={{ ...tab, id: `file-preview-${tab.id}`, columnWidths: {}, hiddenColumns: [] }}
              />
            ) : (
              <p className="center-empty">Choose and preview one file. Nothing is imported automatically.</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={`import-table-${tab.id}`}>New table in main</label>
            <Input
              id={`import-table-${tab.id}`}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={!!busy}
            />
            <Button
              disabled={!file || !result || !!busy || profile.readOnly || !target.trim()}
              onClick={async () => {
                if (!file) return
                const table = target.trim()
                const accepted = await confirm({
                  title: 'Import this local file?',
                  description: `${file.name} → ${profile.name} · main.${table}. This creates a new table and imports the complete file. Temporary-memory targets are lost on disconnect.`,
                  typed: `main.${table}`,
                  label: 'Create table and import',
                })
                if (accepted === false) return
                const id = uid()
                useApp.getState().setRuntime(tab.id, { running: true, requestId: id })
                setRequestId(id)
                setBusy('import')
                setError('')
                setOutcome('')
                try {
                  const imported = await api.importAnalyticsFile({
                    connectionId: profile.id,
                    sessionId,
                    requestId: id,
                    token: file.token,
                    schema: 'main',
                    table,
                    confirm: `main.${table}`,
                  })
                  setOutcome(`Committed ${imported.affectedRows.toLocaleString()} rows to main.${table}.`)
                  await useApp.getState().refreshMetadata()
                } catch (failure) {
                  setError(errorText(failure))
                } finally {
                  if (useApp.getState().runtime[tab.id]?.requestId === id)
                    useApp.getState().setRuntime(tab.id, { running: false })
                  setBusy('')
                  setRequestId('')
                  await api.closeSession({ connectionId: profile.id, sessionId }).catch(() => {})
                }
              }}
            >
              Review full import
            </Button>
            <Button variant="outline" disabled={!!busy} onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
          {profile.readOnly && (
            <p className="text-xs muted">
              Import requires a writable local target. Preview does not modify either file.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
