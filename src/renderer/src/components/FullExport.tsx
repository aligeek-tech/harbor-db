import { useEffect, useState } from 'react'
import { Download, CircleStop } from 'lucide-react'
import type { ConnectionProfile } from '@shared/contracts'
import type { QueryParameter } from '@shared/parameters'
import type { ExportJobSnapshot } from '@shared/transfers'
import { exportConsistency } from '@shared/transfers'
import { engineSupports } from '@shared/capabilities'
import { parameterValue } from '@shared/parameters'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

/** A fresh reviewed read-only snapshot, independent of capped on-screen results. */
export function FullExport({
  profile,
  database,
  getStatement,
  disabled,
}: {
  profile: ConnectionProfile
  database?: string
  getStatement: () => { sql: string; parameters: QueryParameter[] }
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [review, setReview] = useState<ReturnType<typeof getStatement>>()
  const [format, setFormat] = useState<'csv' | 'jsonl'>('jsonl')
  const [spreadsheetSafe, setSpreadsheetSafe] = useState(true)
  const [job, setJob] = useState<ExportJobSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!job || job.state !== 'running') return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.exportJob(job.id)
        if (live) {
          setJob(next)
          if (next.state === 'running') timer = setTimeout(poll, 500)
        }
      } catch (failure) {
        if (live) setError(errorText(failure))
      }
    }
    timer = setTimeout(poll, 500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [job?.id, job?.state])
  if (!engineSupports(profile.engine, 'streamExport')) return null
  const running = job?.state === 'running'
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled && !job}
        onClick={() => {
          if (!running) {
            try {
              const next = getStatement()
              next.parameters.forEach(parameterValue)
              setReview(next)
              setError('')
            } catch (failure) {
              setError(errorText(failure))
              setReview(undefined)
            }
          }
          setOpen(true)
        }}
      >
        <Download />
        {running ? `Export: ${job.rows.toLocaleString()} rows` : 'Full query export'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export a full query result</DialogTitle>
            <DialogDescription>
              Target: {profile.name} ·{' '}
              {['sqlite', 'duckdb'].includes(profile.engine)
                ? 'Local database'
                : `${profile.host}:${profile.port}`}{' '}
              · {database || profile.database} · {profile.environment}. This reruns one read-only statement in
              a separate session. It excludes this tab’s uncommitted changes.
            </DialogDescription>
          </DialogHeader>
          {profile.engine === 'snowflake' && <p className="text-sm warning">Full export submits the reviewed SQL to warehouse {profile.warehouse.warehouse} and may incur compute charges. Row limits do not cap cost; cancellation cannot reverse completed charges.</p>}
          {profile.engine === 'athena' && <p className="text-sm warning">Full export sends this SQL to AWS catalog {profile.athena.catalog}, workgroup {profile.athena.workgroup}, database {database || profile.database}. Enforced scan cutoff: at most {profile.athena.maximumScannedBytes} bytes. Result storage: {profile.athena.outputLocation}, owner {profile.athena.expectedBucketOwner}. This is not a monetary cap. Cancellation cannot reverse writes, S3 output or charges.</p>}
          {profile.engine === 'bigquery' && <p className="text-sm warning">Submitting this export sends the reviewed SQL to Google Cloud. Billing project: {database || profile.database}; location: {profile.bigQuery.location}; maximum billed bytes: {profile.bigQuery.maximumBytesBilled}. Cancellation cannot reverse completed charges or writes.</p>}
          <p className="text-sm">This exports beyond the loaded grid. {exportConsistency(profile.engine)}</p>
          {review && (
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs"
              aria-label="Full export SQL review"
            >
              {review.sql}
            </pre>
          )}
          {!!review?.parameters.length && (
            <p className="text-sm">
              {review.parameters.length} native parameters will be supplied. Their values are hidden here and
              are not saved with the job.
            </p>
          )}
          <label>
            Full export format
            <select
              aria-label="Full export format"
              value={format}
              disabled={running || busy}
              onChange={(event) => setFormat(event.target.value as typeof format)}
            >
              <option value="jsonl">JSONL · typed columns and ordered row arrays</option>
              <option value="csv">CSV · text interchange</option>
            </select>
          </label>
          {format === 'csv' && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={spreadsheetSafe}
                disabled={running || busy}
                onChange={(event) => setSpreadsheetSafe(event.target.checked)}
              />
              Spreadsheet-safe text (prefixes formula-like values)
            </label>
          )}
          <p className="text-xs muted">
            Choose a new filename. Existing files are never overwritten. Failed or cancelled jobs leave a
            clearly named .partial file for inspection. Cancelling an export does not roll back earlier
            unrelated work.
          </p>
          {error && <ErrorPanel message={error} />}
          {job && (
            <div role="status" aria-live="polite" className="rounded border p-3 text-sm">
              {job.state} · {job.rows.toLocaleString()} rows · {job.bytes.toLocaleString()} bytes ·{' '}
              {(job.durationMs / 1000).toFixed(1)} s{job.error && <p>{job.error}</p>}
              <p>{job.consistency}</p>
              {(job.outputPath || job.partialPath) && (
                <p className="break-all">{job.outputPath || job.partialPath}</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false)
                if (!running) setReview(undefined)
              }}
            >
              Close
            </Button>
            {running ? (
              <Button
                variant="destructive"
                onClick={async () => {
                  try {
                    setJob(await api.cancelExportJob(job.id))
                  } catch (failure) {
                    setError(errorText(failure))
                  }
                }}
              >
                <CircleStop />
                Cancel export
              </Button>
            ) : (
              <Button
                disabled={!review || busy || disabled}
                onClick={async () => {
                  if (!review) return
                  setBusy(true)
                  setError('')
                  try {
                    const started = await api.startFullExport({
                      connectionId: profile.id,
                      database,
                      sql: review.sql,
                      parameters: review.parameters,
                      format,
                      spreadsheetSafe,
                      consentRerun: true,
                    })
                    if (started) {
                      setJob(started)
                      setReview(undefined)
                    }
                  } catch (failure) {
                    setError(errorText(failure))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Review accepted · choose new file and export
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
