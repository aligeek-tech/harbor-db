import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { ImportWorkspaceHandoff, WorkspaceHandoffPreview } from '@shared/portable-workspace'
import { api, isDesktop } from '../lib/api'
import { engineNames, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

export function WorkspaceHandoff({ disabled = false }: { disabled?: boolean }) {
  const workspace = useApp((state) => state.workspace)
  const demo = useApp((state) => state.demo)
  const profiles = useApp((state) => state.profiles)
  const queries = useApp((state) => state.savedQueries)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [includeQueries, setQueries] = useState(false)
  const [includeDrafts, setDrafts] = useState(false)
  const [reviewedText, setReviewedText] = useState(false)
  const [reviewedTargets, setReviewedTargets] = useState(false)
  const [preview, setPreview] = useState<WorkspaceHandoffPreview | null>(null)
  const [choices, setChoices] = useState<ImportWorkspaceHandoff['profiles']>([])
  const [queryMode, setQueryMode] = useState<ImportWorkspaceHandoff['queryMode']>('copy')
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [importSettings, setImportSettings] = useState(false)
  const [inspectIndex, setInspectIndex] = useState(0)
  const privateMode = workspace.settings.privateSession
  const bindings = choices.filter((choice) => choice.action === 'bind')
  const sqlPreview = preview
    ? [
        ...preview.archive.queries.map((query) => ({ name: `Saved query: ${query.name}`, sql: query.sql })),
        ...preview.archive.workspaces.flatMap((snapshot) =>
          [...snapshot.tabs, ...snapshot.recentlyClosed].map((tab) => ({
            name: `${snapshot.name} / ${tab.title}`,
            sql: tab.sql,
          })),
        ),
      ]
    : []
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" disabled={disabled || !isDesktop || demo} onClick={() => setOpen(true)}>
        <Download />
        Workspace handoff
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Portable workspace handoff</DialogTitle>
            <DialogDescription>
              Move connection metadata, saved queries and draft workspaces between laptops. No credentials,
              profile notes, local database files, TLS files, SSH private-key paths, result rows, history, or
              transaction state are included. This is not a database backup.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="error-panel" role="alert">
              {error}
            </p>
          )}
          <section className="grid gap-2 rounded border border-[var(--line)] p-3">
            <h3 className="font-medium">Export from this laptop</h3>
            <p className="text-xs muted">
              {profiles.filter((profile) => !profile.id.startsWith('demo-')).length} profiles and preferences.
              New copies require credential and local file-path setup. SQL may contain sensitive literal
              values or embedded paths; it is not automatically redacted.
            </p>
            <label>
              <input
                type="checkbox"
                checked={includeQueries}
                disabled={busy}
                onChange={(event) => {
                  setQueries(event.target.checked)
                  setReviewedText(false)
                }}
              />{' '}
              Include saved query text ({queries.length})
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeDrafts}
                disabled={busy || privateMode}
                onChange={(event) => {
                  setDrafts(event.target.checked)
                  setReviewedText(false)
                }}
              />{' '}
              Include current and archived draft workspaces ({workspace.archivedWorkspaces.length + 1})
            </label>
            {(includeQueries || includeDrafts) && (
              <label>
                <input
                  type="checkbox"
                  checked={reviewedText}
                  disabled={busy}
                  onChange={(event) => setReviewedText(event.target.checked)}
                />{' '}
                I reviewed the included SQL and accept that sensitive literals may be exported.
              </label>
            )}
            {privateMode && (
              <p className="text-xs">
                End the private session before exporting drafts or importing a handoff.
              </p>
            )}
            <div>
              <Button
                disabled={
                  busy ||
                  ((includeQueries || includeDrafts) && !reviewedText) ||
                  (privateMode && includeDrafts)
                }
                onClick={() =>
                  void perform(async () => {
                    await useApp.getState().flush()
                    const result = await api.exportWorkspaceHandoff({ includeQueries, includeDrafts })
                    if (!result.cancelled)
                      toast.success('Workspace handoff exported. Review the file before sharing it.')
                  })
                }
              >
                <Download />
                Export handoff file
              </Button>
            </div>
          </section>
          <section className="grid gap-3 rounded border border-[var(--line)] p-3">
            <div className="flex items-center gap-3">
              <h3 className="flex-1 font-medium">Preview import</h3>
              <Button
                variant="outline"
                disabled={busy || privateMode}
                onClick={() =>
                  void perform(async () => {
                    setPreview(null)
                    const next = await api.previewWorkspaceHandoff()
                    if (!next) return
                    setPreview(next)
                    setReviewedTargets(false)
                    setInspectIndex(0)
                    setChoices(
                      next.archive.profiles.map((profile) => ({ sourceId: profile.id, action: 'copy' })),
                    )
                    setWorkspaceIds(
                      next.archive.workspaces
                        .slice(0, Math.max(0, 19 - workspace.archivedWorkspaces.length))
                        .map((snapshot) => snapshot.id),
                    )
                  })
                }
              >
                <Upload />
                Choose handoff file
              </Button>
            </div>
            {preview && (
              <>
                <p className="text-xs">
                  Format v{preview.archive.version} · exported{' '}
                  {new Date(preview.archive.createdAt).toLocaleString()} · preview expires after 5 minutes.
                  Nothing has been imported yet.
                </p>
                <ul className="list-disc pl-5 text-xs">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
                <h4 className="font-medium">Connection choices</h4>
                {preview.archive.profiles.map((profile, index) => {
                  const choice = choices.find((item) => item.sourceId === profile.id)
                  return (
                    <div key={profile.id} className="grid gap-1 border-b border-[var(--line)] pb-2">
                      <span>
                        {profile.name} · {engineNames[profile.engine]} ·{' '}
                        {['sqlite', 'duckdb'].includes(profile.engine)
                          ? 'Local file path must be chosen again'
                          : `${profile.host}:${profile.port} / ${profile.database || 'No default database'}`}{' '}
                        / {profile.schema} · {profile.environment}
                      </span>
                      <select
                        aria-label={`Connection ${index + 1} import action`}
                        disabled={busy}
                        value={
                          choice?.action === 'bind' ? `bind:${choice.existingId}` : choice?.action || 'copy'
                        }
                        onChange={(event) => {
                          const value = event.target.value
                          const next: ImportWorkspaceHandoff['profiles'][number] = value.startsWith('bind:')
                            ? { sourceId: profile.id, action: 'bind', existingId: value.slice(5) }
                            : { sourceId: profile.id, action: value as 'copy' | 'skip' }
                          setChoices((previous) =>
                            previous.map((item) => (item.sourceId === profile.id ? next : item)),
                          )
                          setReviewedTargets(false)
                        }}
                      >
                        <option value="copy">
                          Create a new read-only profile
                          {preview.conflicts.profileIds.includes(profile.id)
                            ? ' (name conflict; import suffix added)'
                            : ''}
                        </option>
                        <option value="skip">
                          Skip profile (queries become unbound; its tabs are omitted)
                        </option>
                        {profiles
                          .filter(
                            (target) => target.engine === profile.engine && !target.id.startsWith('demo-'),
                          )
                          .map((target) => (
                            <option key={target.id} value={`bind:${target.id}`}>
                              Link to {target.name} · {target.host}:{target.port} /{' '}
                              {target.database || target.schema} · {target.environment} ·{' '}
                              {target.readOnly ? 'read-only' : 'writes enabled'}
                            </option>
                          ))}
                      </select>
                    </div>
                  )
                })}
                {!!bindings.length && (
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewedTargets}
                      disabled={busy}
                      onChange={(event) => setReviewedTargets(event.target.checked)}
                    />{' '}
                    I reviewed each linked destination. Existing profile permissions and credentials stay
                    unchanged; imported SQL may refer to a different database or schema.
                  </label>
                )}
                <label>
                  Saved query conflicts ({preview.archive.queries.length} queries,{' '}
                  {preview.conflicts.queryIds.length} existing-name conflicts)
                  <select
                    aria-label="Saved query import policy"
                    disabled={busy}
                    value={queryMode}
                    onChange={(event) =>
                      setQueryMode(event.target.value as ImportWorkspaceHandoff['queryMode'])
                    }
                  >
                    <option value="copy">Copy with new IDs and rename conflicting names</option>
                    <option value="skip-conflicts">Skip existing names; copy others</option>
                    <option value="skip">Skip all saved queries</option>
                  </select>
                </label>
                <h4 className="font-medium">Import as inactive saved workspaces</h4>
                <p className="text-xs muted">
                  {19 - workspace.archivedWorkspaces.length} archive slots available. Current tabs stay open.
                  Conflicting workspace names receive an import suffix.
                </p>
                {preview.archive.workspaces.map((snapshot) => (
                  <label key={snapshot.id}>
                    <input
                      type="checkbox"
                      checked={workspaceIds.includes(snapshot.id)}
                      disabled={busy}
                      onChange={(event) =>
                        setWorkspaceIds((previous) =>
                          event.target.checked
                            ? [...previous, snapshot.id]
                            : previous.filter((id) => id !== snapshot.id),
                        )
                      }
                    />{' '}
                    {snapshot.name} · {snapshot.tabs.length} tabs, {snapshot.recentlyClosed.length} recently
                    closed
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={importSettings}
                    onChange={(event) => setImportSettings(event.target.checked)}
                  />{' '}
                  Import appearance, layout, and history preferences
                </label>
                {importSettings && (
                  <p className="text-xs warning">
                    History retention changes from {workspace.settings.historyRetentionDays} to{' '}
                    {preview.archive.settings.historyRetentionDays} days and may remove older local history.
                    Credentials and private-session state stay unchanged.
                  </p>
                )}
                {!!sqlPreview.length && (
                  <details>
                    <summary>Inspect included SQL text</summary>
                    <select
                      aria-label="Handoff text to inspect"
                      value={inspectIndex}
                      onChange={(event) => setInspectIndex(Number(event.target.value))}
                    >
                      {sqlPreview.map((item, index) => (
                        <option key={index} value={index}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                      {sqlPreview[inspectIndex]?.sql.slice(0, 10000)}
                    </pre>
                    <p className="text-xs muted">
                      Preview shows up to 10,000 characters per draft. Review the file externally for complete
                      long text. Imported SQL remains unexecuted.
                    </p>
                  </details>
                )}
                <div>
                  <Button
                    disabled={
                      busy ||
                      privateMode ||
                      (!!bindings.length && !reviewedTargets) ||
                      workspace.archivedWorkspaces.length + workspaceIds.length > 19
                    }
                    onClick={() =>
                      void perform(async () => {
                        await useApp.getState().flush()
                        const result = await api.importWorkspaceHandoff({
                          token: preview.token,
                          profiles: choices,
                          queryMode,
                          workspaceIds,
                          settings: importSettings ? 'import' : 'keep',
                        })
                        const fresh = await api.bootstrap()
                        useApp.setState({
                          profiles: fresh.profiles,
                          savedQueries: fresh.savedQueries,
                          history: fresh.history,
                          workspace: fresh.workspace,
                        })
                        await api.setZoom(fresh.workspace.settings.zoom)
                        setPreview(null)
                        toast.success(
                          `Imported ${result.profiles} profiles, ${result.queries} queries, and ${result.workspaces} inactive workspaces.${result.skippedTabs ? ` ${result.skippedTabs} tabs omitted because their connections were skipped.` : ''} No connections were opened.`,
                        )
                      })
                    }
                  >
                    Import reviewed handoff
                  </Button>
                </div>
              </>
            )}
          </section>
          <div className="dialog-actions">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
