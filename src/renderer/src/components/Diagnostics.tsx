import { useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import type { DiagnosticKind, DiagnosticResult } from '@shared/inspection'
import { Activity } from 'lucide-react'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { DataGrid } from './DataGrid'
import { ErrorPanel } from './common'
import { SqlAdministration } from './SqlAdministration'
import { NativeBackup } from './NativeBackup'

export function Diagnostics({ profile, database }: { profile: ConnectionProfile; database?: string }) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<DiagnosticKind>('activity'),
    [result, setResult] = useState<DiagnosticResult>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [includeQueryText, setIncludeQueryText] = useState(false),
    [index, setIndex] = useState(0)
  if (!['postgres', 'mariadb', 'mysql'].includes(profile.engine)) return null
  const tab: WorkspaceTab = {
    id: `diagnostics-${profile.id}`,
    connectionId: profile.id,
    title: 'Diagnostics',
    kind: 'query',
    sql: '',
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Activity />
        Inspect database activity
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[80vh] max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle>Database diagnostics</DialogTitle>
            <DialogDescription>
              {profile.name} · {database || profile.database || 'maintenance database'} ·{' '}
              {profile.environment}. User-triggered, bounded inspection only. No polling, extension
              installation or privilege changes.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <label>
              Inspect
              <select
                aria-label="Diagnostic view"
                value={kind}
                disabled={busy}
                onChange={(event) => {
                  setKind(event.target.value as DiagnosticKind)
                  setResult(undefined)
                }}
              >
                <option value="activity">Sessions and queries</option>
                <option value="locks">Locks and blockers</option>
                <option value="indexes">Indexes and usage</option>
                <option value="permissions">Grants and access</option>
                {profile.engine === 'postgres' && (
                  <>
                    <option value="extensions">Extensions and optional capabilities</option>
                    <option value="timescale">TimescaleDB hypertables, chunks and policies</option>
                  </>
                )}
              </select>
            </label>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                setResult(undefined)
                setIndex(0)
                try {
                  setResult(
                    await api.diagnostics({ connectionId: profile.id, database, kind, includeQueryText }),
                  )
                } catch (failure) {
                  setError(errorText(failure))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Inspecting…' : 'Load diagnostics'}
            </Button>
          </div>
          {kind === 'activity' && (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={includeQueryText}
                onChange={(event) => setIncludeQueryText(event.target.checked)}
                disabled={busy}
              />
              Include query text (may contain sensitive values; stays on this laptop)
            </label>
          )}
          <p className="text-xs muted">
            Database privileges determine visibility. A Harbor read-only profile is a safety preference, not
            server authorization. Missing privileges or extensions are reported explicitly. At most 200 rows
            per returned diagnostic set.
          </p>
          {error && <ErrorPanel message={error} />}{' '}
          {result?.warnings.map((warning, i) => (
            <p key={i} className="text-xs">
              {warning}
            </p>
          ))}
          {result && !result.available && (
            <p role="status">
              This diagnostic is unavailable with the current server capabilities or privileges.
            </p>
          )}
          {result && result.sets.length > 1 && (
            <select
              aria-label="Diagnostic result set"
              value={index}
              onChange={(event) => setIndex(Number(event.target.value))}
            >
              {result.sets.map((set, i) => (
                <option key={i} value={i}>
                  {set.command || `Result ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            {result?.sets[index] ? (
              <DataGrid set={result.sets[index]} tab={tab} />
            ) : (
              <p className="center-empty">Choose one diagnostic and load it explicitly.</p>
            )}
          </div>
          <div className="flex justify-end">
            <SqlAdministration profile={profile} database={database} />
            <NativeBackup profile={profile} />
            <Button variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
