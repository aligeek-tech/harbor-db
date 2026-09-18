import { useEffect, useState } from 'react'
import type { ConnectionProfile } from '@shared/contracts'
import type {
  NativeBackupArchive,
  NativeBackupJob,
  NativeBackupPreview,
  NativeBackupTool,
} from '@shared/native-backup'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

export function NativeBackup({ profile }: { profile: ConnectionProfile }) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<'backup' | 'restore'>('backup'),
    [tool, setTool] = useState<NativeBackupTool>(),
    [archive, setArchive] = useState<NativeBackupArchive>()
  const [database, setDatabase] = useState(''),
    [trusted, setTrusted] = useState(false),
    [maxMiB, setMaxMiB] = useState(1024),
    [maxMinutes, setMaxMinutes] = useState(30)
  const [preview, setPreview] = useState<NativeBackupPreview>(),
    [confirm, setConfirm] = useState(''),
    [job, setJob] = useState<NativeBackupJob>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const running = job?.state === 'running'
  // This polls only a main-process job snapshot after an explicit Start action, never the database.
  useEffect(() => {
    if (!job || job.state !== 'running') return
    let stopped = false,
      pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void api
        .getNativeBackupJob(job.id)
        .then(
          (value) => {
            if (!stopped) setJob(value)
          },
          (failure) => {
            if (!stopped) setError(errorText(failure))
          },
        )
        .finally(() => {
          pending = false
        })
    }, 500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [job?.id, job?.state])
  if (profile.engine !== 'postgres') return null
  const reset = () => {
    setPreview(undefined)
    setConfirm('')
    setError('')
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Native backup / restore
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>PostgreSQL native backup and restore</DialogTitle>
            <DialogDescription>
              {profile.name} · {profile.host}:{profile.port} · {profile.database} · {profile.environment}.
              Custom logical archives using your selected native PostgreSQL tools.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
            <p className="text-xs">
              This backs up one database. Query exports, physical backups, cluster roles, PITR and disaster
              recovery are separate workflows. Archives may contain sensitive data and executable SQL.
            </p>
            <fieldset disabled={busy || running} className="space-y-3">
              <label>
                Workflow
                <select
                  aria-label="Native backup workflow"
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value as typeof mode)
                    setTool(undefined)
                    setJob(undefined)
                    reset()
                  }}
                >
                  <option value="backup">Back up this database</option>
                  <option value="restore">Restore into a NEW database</option>
                </select>
              </label>
              <div>
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      const selected = await api.chooseBackupTool(
                        mode === 'backup' ? 'pg_dump' : 'pg_restore',
                      )
                      if (selected) {
                        setTool(selected)
                        reset()
                      }
                    })
                  }
                >
                  Choose {mode === 'backup' ? 'pg_dump' : 'pg_restore'} executable
                </Button>
                {tool && (
                  <div className="mt-2 break-all text-xs">
                    <p>{tool.version}</p>
                    <p>{tool.path}</p>
                    <p>SHA-256 {tool.sha256}</p>
                  </div>
                )}
              </div>
              <p className="text-xs">
                Choose an installed trusted native binary, not a script. Harbor validates its executable
                identity and version and never installs tools or changes global settings.
              </p>
              {mode === 'backup' ? (
                <label>
                  Maximum archive size (MiB)
                  <Input
                    type="number"
                    aria-label="Maximum archive MiB"
                    min={1}
                    max={102400}
                    value={maxMiB}
                    onChange={(event) => {
                      setMaxMiB(Number(event.target.value))
                      reset()
                    }}
                  />
                </label>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void run(async () => {
                        const selected = await api.chooseBackupArchive()
                        if (selected) {
                          setArchive(selected)
                          setTrusted(false)
                          reset()
                        }
                      })
                    }
                  >
                    Choose custom backup archive
                  </Button>
                  {archive && (
                    <div className="break-all text-xs">
                      <p>
                        {archive.path} · {archive.bytes.toLocaleString()} bytes
                      </p>
                      <p>SHA-256 {archive.sha256}</p>
                    </div>
                  )}
                  <label>
                    New database name
                    <Input
                      aria-label="New restore database name"
                      value={database}
                      placeholder="harbor_restore_example"
                      onChange={(event) => {
                        setDatabase(event.target.value)
                        reset()
                      }}
                    />
                  </label>
                  <p className="text-xs">
                    Use lowercase letters, digits and underscores, starting with a letter (up to 63
                    characters). The name must not exist. Harbor will explicitly create this new database and
                    never reuse, clean or drop an existing database.
                  </p>
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={trusted}
                      onChange={(event) => {
                        setTrusted(event.target.checked)
                        reset()
                      }}
                    />
                    I trust the archive source and understand that restore executes its SQL on this server. A
                    fresh database is not a security sandbox.
                  </label>
                  {profile.readOnly && (
                    <p className="text-xs">
                      This read-only profile cannot create a restore database. Use an explicitly writable
                      non-production profile.
                    </p>
                  )}
                </>
              )}
              <label>
                Maximum duration (minutes)
                <Input
                  type="number"
                  aria-label="Native backup deadline minutes"
                  min={1}
                  max={120}
                  value={maxMinutes}
                  onChange={(event) => {
                    setMaxMinutes(Number(event.target.value))
                    reset()
                  }}
                />
              </label>
              <Button
                disabled={
                  !tool || (mode === 'restore' && (!archive || !trusted || !database || profile.readOnly))
                }
                onClick={() =>
                  void run(async () => {
                    reset()
                    setJob(undefined)
                    if (!tool) return
                    setPreview(
                      await api.previewNativeBackup(
                        mode === 'backup'
                          ? {
                              mode,
                              connectionId: profile.id,
                              toolId: tool.id,
                              maxBytes: maxMiB * 1024 * 1024,
                              maxDurationSeconds: maxMinutes * 60,
                            }
                          : {
                              mode,
                              connectionId: profile.id,
                              toolId: tool.id,
                              archiveId: archive!.id,
                              newDatabase: database,
                              trustArchive: true,
                              maxDurationSeconds: maxMinutes * 60,
                            },
                      ),
                    )
                  })
                }
              >
                Preview native {mode}
              </Button>
            </fieldset>
            {error && <ErrorPanel message={error} />}
            {preview && (
              <section aria-label="Native backup review" className="space-y-2 rounded border p-3">
                <p className="font-medium">
                  {preview.mode === 'backup' ? 'Source' : 'New destination'}: {preview.target.host}:
                  {preview.target.port}/{preview.target.database} as {preview.target.user}
                </p>
                <p className="text-xs">
                  Server {preview.target.serverVersion}; tool {preview.tool.version}. Review expires{' '}
                  {new Date(preview.expiresAt).toLocaleTimeString()}.
                </p>
                {preview.commands.map((command, i) => (
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs" key={i}>
                    {command}
                  </pre>
                ))}
                {preview.archiveSummary && (
                  <details>
                    <summary>Archive catalog: {preview.archiveSummary.entries} entries</summary>
                    <p className="text-xs">
                      Source {preview.archiveSummary.sourceVersion}; writer{' '}
                      {preview.archiveSummary.writerVersion}.
                    </p>
                    <pre className="max-h-40 overflow-auto text-xs">
                      {preview.archiveSummary.preview.join('\n')}
                    </pre>
                    {preview.archiveSummary.truncated && (
                      <p className="text-xs">Preview shows the first 100 entries only.</p>
                    )}
                  </details>
                )}
                {preview.warnings.map((warning, i) => (
                  <p key={i} className="text-xs">
                    {warning}
                  </p>
                ))}
                {preview.blockedReasons.map((reason, i) => (
                  <ErrorPanel key={i} message={reason} />
                ))}
                {!job && !preview.blockedReasons.length && (
                  <>
                    <p className="text-xs">
                      Type exactly: <strong>{preview.confirmation}</strong>
                    </p>
                    <Input
                      aria-label="Native backup target confirmation"
                      disabled={busy}
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                    />
                    <Button
                      disabled={busy || confirm !== preview.confirmation}
                      onClick={() =>
                        void run(async () => {
                          const started = await api.startNativeBackup({ token: preview.token, confirm })
                          if (started) {
                            setJob(started)
                            setConfirm('')
                          }
                        })
                      }
                    >
                      Start reviewed native {mode}
                    </Button>
                  </>
                )}
              </section>
            )}
            {job && (
              <section
                role="status"
                aria-label="Native backup progress"
                className="space-y-2 rounded border p-3"
              >
                <p className="font-medium">
                  {job.mode}: {job.state} · {job.phase}
                </p>
                <p>{job.message}</p>
                <p className="text-xs">
                  {job.bytes.toLocaleString()}{' '}
                  {job.mode === 'backup' ? 'archive bytes written' : 'archive input bytes read'} ·{' '}
                  {(job.durationMs / 1000).toFixed(1)} seconds. This is not a row count or completion
                  percentage.
                </p>
                {job.database && <p className="text-xs">Restore database: {job.database}</p>}
                {job.outputPath && <p className="break-all text-xs">Output: {job.outputPath}</p>}
                {job.partialPath && (
                  <p className="break-all text-xs">Unfinalized private partial file: {job.partialPath}</p>
                )}
                {job.sha256 && <p className="break-all text-xs">SHA-256 {job.sha256}</p>}
                {job.verification && (
                  <p className="text-xs">
                    Native catalog check: {job.verification.tables} tables, {job.verification.views} views,{' '}
                    {job.verification.indexes} indexes, {job.verification.constraints} constraints,{' '}
                    {job.verification.routines} routines. Representative data still needs verification.
                  </p>
                )}
                {job.warnings.map((warning, i) => (
                  <p className="text-xs" key={i}>
                    {warning}
                  </p>
                ))}
                {job.details.length > 0 && (
                  <details>
                    <summary>Bounded native progress</summary>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                      {job.details.join('\n')}
                    </pre>
                  </details>
                )}
                {running && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(async () => setJob(await api.cancelNativeBackupJob(job.id)))}
                  >
                    Cancel native operation
                  </Button>
                )}
              </section>
            )}
          </div>
          <p className="text-xs muted">
            Closing this dialog leaves an explicitly started job running while the app remains open.
            Disconnecting or quitting cancels active native jobs; a restore target is retained for review.
          </p>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
