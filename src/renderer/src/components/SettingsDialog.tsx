import { WorkspaceHandoff } from './WorkspaceHandoff'
import { AutomationSettings } from './AutomationSettings'
import { clearWorkspaceDrafts } from '@shared/workspaces'
import { useState } from 'react'
import {
  Download,
  FileJson2,
  History,
  LockKeyhole,
  Monitor,
  Moon,
  RotateCcw,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Settings } from '@shared/contracts'
import type { DiagnosticBundle } from '@shared/diagnostic-bundle'
import { useApp } from '../store'
import { api, isDesktop } from '../lib/api'
import { errorText } from '../lib/utils'
import { useConfirm } from './common'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from './ui/field'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useApp((state) => state.workspace.settings)
  const profiles = useApp((state) => state.profiles)
  const secure = useApp((state) => state.secureStorage)
  const setSettings = useApp((state) => state.setSettings)
  const confirm = useConfirm()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [diagnosticPreview, setDiagnosticPreview] = useState<DiagnosticBundle>()
  const [numberDrafts, setNumberDrafts] = useState({
    editorFontSize: String(settings.editorFontSize),
    pageSize: String(settings.pageSize),
    historyRetentionDays: String(settings.historyRetentionDays),
  })
  const remembered = profiles.filter(
    (profile) => profile.hasPassword || profile.hasSshPassword || profile.hasPassphrase,
  )
  const selectedCredential = remembered.some((profile) => profile.id === credentialId)
    ? credentialId
    : remembered[0]?.id || ''

  async function perform(name: string, action: () => Promise<void>) {
    setBusy(name)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  function numberSetting(
    key: 'editorFontSize' | 'historyRetentionDays' | 'pageSize',
    value: string,
    min: number,
    max: number,
  ) {
    setNumberDrafts((previous) => ({ ...previous, [key]: value }))
    const parsed = Number(value)
    if (value !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max)
      setSettings({ [key]: parsed })
  }

  async function togglePrivacy(enabled: boolean) {
    if (!enabled) {
      const accepted = await confirm({
        title: 'End this private session?',
        description:
          'Private drafts, tab changes and parameter values will be discarded. Staged changes are discarded and open transactions rolled back. Previously saved tabs return without executing queries. Cancel running operations first.',
        label: 'Discard private edits and resume',
        danger: true,
      })
      if (!accepted) return
      await perform('privacy', async () => {
        await useApp.getState().endPrivateSession()
        toast.success('Draft saving resumed')
      })
    } else {
      await perform('privacy', async () => {
        await useApp.getState().flush()
        setSettings({ privateSession: true })
        await useApp.getState().flush()
        toast.success('Private session started')
      })
    }
  }

  async function clearDrafts() {
    if (
      !(await confirm({
        title: 'Clear all query drafts?',
        description:
          'This clears editor text from open tabs, recently closed tabs, and every named workspace. Named saved queries and database data remain available.',
        label: 'Clear drafts',
        danger: true,
      }))
    )
      return
    await perform('drafts', async () => {
      // Update live state as well as persisted state; later debounced writes cannot restore it.
      await api.clearDrafts()
      useApp.setState((state) => ({
        workspace: clearWorkspaceDrafts(state.workspace),
      }))
      await useApp.getState().flush()
      toast.success('Query drafts cleared')
    })
  }

  async function clearHistory() {
    if (
      !(await confirm({
        title: 'Clear query history?',
        description:
          'Remove retained SQL and Redis command history from this application. Saved queries and database data are unaffected.',
        label: 'Clear history',
        danger: true,
      }))
    )
      return
    await perform('history', async () => {
      await api.clearHistory()
      await useApp.getState().refreshMetadata()
      toast.success('Query history cleared')
    })
  }

  async function forgetCredential() {
    const profile = remembered.find((item) => item.id === selectedCredential)
    if (
      !profile ||
      !(await confirm({
        title: `Forget passwords for ${profile.name}?`,
        description:
          'Remove this connection’s remembered database password, SSH password and private-key passphrase. Active database sessions remain connected; future connections may request authentication.',
        label: 'Forget passwords',
        danger: true,
      }))
    )
      return
    await perform('credentials', async () => {
      await api.forgetPassword(profile.id)
      await useApp.getState().refreshMetadata()
      toast.success('Remembered passwords removed')
    })
  }

  async function reviewDiagnostics() {
    await perform('diagnostics-preview', async () => {
      setDiagnosticPreview(await api.previewDiagnosticBundle())
    })
  }

  async function exportDiagnostics() {
    if (!diagnosticPreview) return
    await perform('diagnostics-export', async () => {
      const result = await api.exportDiagnosticBundle(diagnosticPreview)
      if (!result.cancelled) toast.success('Reviewed diagnostic bundle exported')
    })
  }

  async function close() {
    await perform('close', async () => {
      await useApp.getState().flush()
      onClose()
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void close()
      }}
    >
      <DialogContent
        className="settings-dialog"
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Make yourself at home</DialogTitle>
          <DialogDescription>
            Appearance, workspace memory, and privacy. Changes are saved as you go.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Setting could not be saved</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <FieldSet className="setting-section">
          <FieldLegend>Appearance</FieldLegend>
          <FieldGroup>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel id="theme-label">Theme</FieldLabel>
              <ToggleGroup
                aria-labelledby="theme-label"
                type="single"
                value={settings.theme}
                variant="outline"
                onValueChange={(value) => {
                  if (value) setSettings({ theme: value as Settings['theme'] })
                }}
              >
                <ToggleGroupItem value="system" aria-label="System theme">
                  <Monitor data-icon="inline-start" />
                  System
                </ToggleGroupItem>
                <ToggleGroupItem value="light" aria-label="Light theme">
                  <Sun data-icon="inline-start" />
                  Light
                </ToggleGroupItem>
                <ToggleGroupItem value="dark" aria-label="Dark theme">
                  <Moon data-icon="inline-start" />
                  Dark
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel id="density-label">Density</FieldLabel>
              <ToggleGroup
                aria-labelledby="density-label"
                type="single"
                value={settings.density}
                variant="outline"
                onValueChange={(value) => {
                  if (value) setSettings({ density: value as Settings['density'] })
                }}
              >
                <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
                <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="editor-font-size">
                Editor font size <small>Independent of the application zoom.</small>
              </FieldLabel>
              <Input
                id="editor-font-size"
                type="number"
                min={11}
                max={24}
                value={numberDrafts.editorFontSize}
                onChange={(event) => numberSetting('editorFontSize', event.target.value, 11, 24)}
                onBlur={() =>
                  setNumberDrafts((previous) => ({
                    ...previous,
                    editorFontSize: String(settings.editorFontSize),
                  }))
                }
              />
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="application-zoom">Application zoom</FieldLabel>
              <select
                id="application-zoom"
                value={settings.zoom}
                disabled={!!busy}
                onChange={(event) => {
                  const zoom = Number(event.target.value)
                  void perform('zoom', async () => {
                    await api.setZoom(zoom)
                    setSettings({ zoom })
                  })
                }}
              >
                {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((zoom) => (
                  <option key={zoom} value={zoom}>
                    {Math.round(zoom * 100)}%
                  </option>
                ))}
              </select>
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="page-size">
                Default table page <small>Bounded fetching keeps large tables responsive.</small>
              </FieldLabel>
              <Input
                id="page-size"
                type="number"
                min={25}
                max={1000}
                step={25}
                value={numberDrafts.pageSize}
                onChange={(event) => numberSetting('pageSize', event.target.value, 25, 1000)}
                onBlur={() =>
                  setNumberDrafts((previous) => ({ ...previous, pageSize: String(settings.pageSize) }))
                }
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet className="setting-section">
          <FieldLegend>Workspace memory and privacy</FieldLegend>
          <FieldDescription>
            SQL and Redis commands can contain sensitive values. Results stay in memory; command history and
            ordinary editor drafts are stored locally.
          </FieldDescription>
          <FieldGroup>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="private-session">
                Private session{' '}
                <small>
                  Pause draft saving and command history. Earlier saved drafts remain until you clear them.
                </small>
              </FieldLabel>
              <input
                id="private-session"
                type="checkbox"
                checked={settings.privateSession}
                disabled={!!busy || !isDesktop}
                onChange={(event) => {
                  void togglePrivacy(event.target.checked)
                }}
              />
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="history-enabled">
                Remember query history{' '}
                <small>Connection-specific history preferences are in Edit connection.</small>
              </FieldLabel>
              <input
                id="history-enabled"
                type="checkbox"
                checked={settings.historyEnabled}
                disabled={settings.privateSession}
                onChange={(event) => {
                  setSettings({ historyEnabled: event.target.checked })
                  void perform('history-preference', async () => {
                    await useApp.getState().flush()
                  })
                }}
              />
            </Field>
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="history-retention">
                History retention <small>Automatically remove entries older than this many days.</small>
              </FieldLabel>
              <Input
                id="history-retention"
                type="number"
                min={1}
                max={365}
                value={numberDrafts.historyRetentionDays}
                onChange={(event) => numberSetting('historyRetentionDays', event.target.value, 1, 365)}
                onBlur={() =>
                  setNumberDrafts((previous) => ({
                    ...previous,
                    historyRetentionDays: String(settings.historyRetentionDays),
                  }))
                }
              />
            </Field>
          </FieldGroup>
          <div className="settings-actions">
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop}
              onClick={() => {
                void clearHistory()
              }}
            >
              <History data-icon="inline-start" />
              Clear history
            </Button>
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop}
              onClick={() => {
                void clearDrafts()
              }}
            >
              <Trash2 data-icon="inline-start" />
              Clear saved drafts
            </Button>
          </div>
        </FieldSet>
        <FieldSet className="setting-section">
          <FieldLegend>Credentials and backups</FieldLegend>
          <Alert>
            {secure.available ? <ShieldCheck /> : <LockKeyhole />}
            <AlertTitle>
              {secure.available
                ? 'Operating-system credential protection is available'
                : 'Passwords can be used for this session'}
            </AlertTitle>
            <AlertDescription>
              {secure.available
                ? `Remembered passwords use ${secure.backend}. Stored passwords never return to the editor or connection form.`
                : secure.reason ||
                  'A protected credential store is unavailable. Existing encrypted passwords are preserved.'}
            </AlertDescription>
          </Alert>
          {remembered.length ? (
            <Field className="setting-row" orientation="horizontal">
              <FieldLabel htmlFor="saved-credential">Saved passwords</FieldLabel>
              <select
                id="saved-credential"
                value={selectedCredential}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                {remembered.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => {
                  void forgetCredential()
                }}
              >
                Forget
              </Button>
            </Field>
          ) : null}
          <FieldDescription>
            A connection export contains metadata only. An application-data backup preserves workspace memory;
            neither backs up the databases you manage.
          </FieldDescription>
          <div className="settings-actions">
            <WorkspaceHandoff disabled={!!busy} />
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop}
              onClick={() => {
                void perform('export', async () => {
                  const result = await api.exportProfiles()
                  if (!result.cancelled) toast.success('Connection metadata exported without passwords')
                })
              }}
            >
              <Download data-icon="inline-start" />
              Export connections
            </Button>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => {
                setSettings({ sidebarWidth: 248, editorHeight: 290, inspectorOpen: true })
                toast.success('Workspace layout reset')
              }}
            >
              <RotateCcw data-icon="inline-start" />
              Reset layout
            </Button>
          </div>
        </FieldSet>
        <FieldSet className="setting-section">
          <FieldLegend>Reusable local tasks</FieldLegend>
          <AutomationSettings />
        </FieldSet>
        <FieldSet className="setting-section">
          <FieldLegend>Diagnostics and updates</FieldLegend>
          <Alert>
            <FileJson2 />
            <AlertTitle>Review a privacy-safe diagnostic bundle before saving</AlertTitle>
            <AlertDescription>
              The bundle contains runtime versions, aggregate counts, structured health codes and shipped
              capability identifiers. It excludes credentials, connection names and endpoints, SQL, drafts,
              history text, results, file paths, environment variables, process arguments and machine/user
              identifiers.
            </AlertDescription>
          </Alert>
          <FieldDescription>
            Updates are manual downloads. Harbor DB has no automatic updater and will not install an update
            during a query, transaction or other active write. Signature and notarization status remain unknown
            unless the downloaded artifact is verified separately.
          </FieldDescription>
          <div className="settings-actions">
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop}
              onClick={() => {
                void reviewDiagnostics()
              }}
            >
              <FileJson2 data-icon="inline-start" />
              {diagnosticPreview ? 'Refresh diagnostic preview' : 'Review diagnostic bundle'}
            </Button>
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop || !diagnosticPreview}
              onClick={() => {
                void exportDiagnostics()
              }}
            >
              <Download data-icon="inline-start" />
              Export reviewed bundle
            </Button>
          </div>
          {diagnosticPreview ? (
            <textarea
              aria-label="Diagnostic bundle preview"
              readOnly
              rows={14}
              value={JSON.stringify(diagnosticPreview, null, 2)}
            />
          ) : null}
        </FieldSet>
        <DialogFooter>
          <Button
            disabled={!!busy}
            onClick={() => {
              void close()
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
