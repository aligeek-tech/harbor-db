import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/contracts'
import type { MongoFileJob, MongoFilePreview } from '@shared/mongo-files'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'
export function MongoFileTools({
  profile,
  database,
  collection,
  query,
  mode,
  disabled,
  onBusy,
  onChanged,
}: {
  profile: ConnectionProfile
  database: string
  collection: string
  query: string
  mode: 'find' | 'aggregate'
  disabled: boolean
  onBusy: (busy: boolean) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<'import' | 'export'>('export')
  const [preview, setPreview] = useState<MongoFilePreview>(),
    [job, setJob] = useState<MongoFileJob>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false)
  const [confirm, setConfirm] = useState(''),
    [maximum, setMaximum] = useState(10000)
  const active = useRef<string | undefined>(undefined),
    mounted = useRef(true),
    running = job?.state === 'running'
  useEffect(() => {
    onBusy(busy || running)
    return () => onBusy(false)
  }, [busy, running, onBusy])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (active.current) void api.cancelMongoFileJob(active.current).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (!running || !job) return
    let pending = false
    const timer = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.mongoFileJob(job.id)
        if (mounted.current) setJob(next)
      } catch (error) {
        if (mounted.current) setError(errorText(error))
      } finally {
        pending = false
      }
    }, 300)
    return () => clearInterval(timer)
  }, [job?.id, running])
  const invoke = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const close = () => {
    if (busy || running) return
    setOpen(false)
    if (job?.kind === 'import' && job.acknowledgedDocuments) onChanged()
  }
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled || !database || !collection}
        onClick={() => {
          setOpen(true)
          setPreview(undefined)
          setJob(undefined)
          setConsent(false)
          setConfirm('')
          setError('')
        }}
      >
        Document files…
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value) close()
          }}
        >
          <DialogContent className="dialog-wide">
            <DialogHeader>
              <DialogTitle>MongoDB document files</DialogTitle>
              <DialogDescription>
                {profile.name} · {database}.{collection} · {profile.environment}. Canonical BSON Extended
                JSON, one document per UTF-8 line.
              </DialogDescription>
            </DialogHeader>
            <ErrorPanel message={error} />
            <label>
              Operation
              <select
                aria-label="Document file operation"
                value={kind}
                disabled={busy || running || !!job}
                onChange={(event) => {
                  setKind(event.target.value as 'import' | 'export')
                  setPreview(undefined)
                  setConsent(false)
                  setConfirm('')
                }}
              >
                <option value="export">Export read query</option>
                <option value="import" disabled={profile.readOnly}>
                  Import documents
                </option>
              </select>
            </label>
            <label>
              Maximum documents
              <Input
                aria-label="Maximum documents"
                type="number"
                min={1}
                max={1000000}
                value={maximum}
                disabled={busy || running || !!job}
                onChange={(event) => setMaximum(Number(event.target.value))}
              />
            </label>
            {kind === 'export' ? (
              <>
                <pre style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {mode}: {query}
                </pre>
                <p className="field-note">
                  A fresh cursor reruns this read query. Concurrent changes may appear; this is not a snapshot
                  or backup. The document cap is reported. Failed/cancelled output remains clearly marked as a
                  partial file; existing destinations are never replaced.
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={busy || running}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  I consent to rerunning this read query for export.
                </label>
                <Button
                  disabled={!consent || busy || !!job || maximum < 1 || maximum > 1000000}
                  onClick={() =>
                    void invoke(async () => {
                      const next = await api.startMongoExport({
                        connectionId: profile.id,
                        database,
                        collection,
                        query: query || (mode === 'find' ? '{}' : '[]'),
                        mode,
                        maxDocuments: maximum,
                        consentRerun: true,
                      })
                      if (next) {
                        active.current = next.id
                        setJob(next)
                      }
                    })
                  }
                >
                  Choose destination and start export…
                </Button>
              </>
            ) : (
              <>
                <p className="field-note">
                  Insert only into this existing collection. Existing IDs are preserved; duplicates stop the
                  job. Missing IDs receive new ObjectIds. Each acknowledgment is committed independently. No
                  rollback, automatic retry or resume is available.
                </p>
                <Button
                  disabled={busy || running || !!job || profile.readOnly}
                  onClick={() =>
                    void invoke(async () => {
                      const next = await api.chooseMongoImport({
                        connectionId: profile.id,
                        database,
                        collection,
                      })
                      setPreview(next ?? undefined)
                      setConfirm('')
                      setConsent(false)
                    })
                  }
                >
                  Choose and preview Extended JSON file…
                </Button>
                {preview && (
                  <>
                    <p>
                      {preview.name} · {preview.bytes} bytes · {preview.documents.length} preview documents
                      {preview.previewTruncated ? ' · sample clipped to20documents/32KiB' : ''}
                    </p>
                    <pre
                      aria-label="Extended JSON preview"
                      style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}
                    >
                      {preview.documents.join('\n')}
                    </pre>
                    <p className="field-note">
                      Only the displayed sample was validated. Later invalid lines or server failures can
                      leave partial writes. Collection changes are rechecked every50documents; a concurrent
                      administrator can still race a check.
                    </p>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={busy || running}
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      I accept individual document commits and possible partial completion.
                    </label>
                    <label>
                      Type {preview.confirmation}
                      <Input
                        aria-label="Confirm document import target"
                        value={confirm}
                        disabled={busy || running}
                        onChange={(event) => setConfirm(event.target.value)}
                      />
                    </label>
                    <Button
                      disabled={
                        !consent ||
                        confirm !== preview.confirmation ||
                        busy ||
                        !!job ||
                        maximum < 1 ||
                        maximum > 1000000
                      }
                      onClick={() =>
                        void invoke(async () => {
                          const next = await api.startMongoImport({
                            token: preview.token,
                            confirm,
                            consentIndividualWrites: true,
                            maxDocuments: maximum,
                          })
                          active.current = next.id
                          setJob(next)
                        })
                      }
                    >
                      Start reviewed document import
                    </Button>
                  </>
                )}
              </>
            )}
            {job && (
              <>
                <p role="status">
                  {job.kind} {job.state} · {job.documentsRead} documents read · {job.acknowledgedDocuments}{' '}
                  acknowledged inserts · {job.uncertainDocuments} uncertain · {job.bytes} bytes
                  {job.kind === 'import' ? ` · last source line ${job.lastLine}` : ''}
                  {job.limited ? ' · stopped at document limit' : ''}
                </p>
                <ul>
                  {job.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
                {job.error && <ErrorPanel message={job.error} />}{' '}
                {job.outputPath && <p>Saved: {job.outputPath}</p>}{' '}
                {job.partialPath && <p>Partial file: {job.partialPath}</p>}
                <Button
                  disabled={!running || busy}
                  onClick={() =>
                    void invoke(async () => {
                      setJob(await api.cancelMongoFileJob(job.id))
                    })
                  }
                >
                  Cancel document job
                </Button>
              </>
            )}
            <Button variant="outline" disabled={busy || running} onClick={close}>
              Close document files
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
