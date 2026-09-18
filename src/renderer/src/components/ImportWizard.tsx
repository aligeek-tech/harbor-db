import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, TableStructure, WorkspaceTab } from '@shared/contracts'
import {
  importOptionsSchema,
  importTargetConfirmation,
  type ImportOptions,
  type ImportPreview,
  type ImportJobSnapshot,
  type StartImportInput,
} from '@shared/imports'
import { parameterDefinitionSchema } from '@shared/parameters'
import { api } from '../lib/api'
import { displayCell, errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

export function ImportWizard({
  profile,
  tab,
  structure,
  onClose,
  onBusyChange,
  onImported,
}: {
  profile: ConnectionProfile
  tab: WorkspaceTab
  structure: TableStructure
  onClose(): void
  onBusyChange(busy: boolean): void
  onImported(): void
}) {
  const [options, setOptions] = useState<ImportOptions>(() => importOptionsSchema.parse({ format: 'csv' }))
  const [preview, setPreview] = useState<ImportPreview>(),
    [mapping, setMapping] = useState<StartImportInput['mapping']>([])
  const [batchSize, setBatchSize] = useState(100),
    [policy, setPolicy] = useState<'stop' | 'skip-invalid'>('stop')
  const [consent, setConsent] = useState(false),
    [confirmation, setConfirmation] = useState('')
  const [job, setJob] = useState<ImportJobSnapshot>(),
    [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false),
    [error, setError] = useState('')
  const lock = useRef(false),
    activeJob = useRef<string | undefined>(undefined),
    live = useRef(true)
  const callbacks = useRef({ onBusyChange, onImported })
  callbacks.current = { onBusyChange, onImported }
  const target = {
    connectionId: profile.id,
    database: tab.database,
    schema: tab.schema || profile.schema,
    table: tab.table!,
  }
  const expected = importTargetConfirmation(target)
  const append = profile.engine === 'clickhouse'
  const [appendConsent, setAppendConsent] = useState(false)
  const running = job?.state === 'running'
  const mappingValid =
    mapping.some((item) => item.target) &&
    new Set(mapping.filter((item) => item.target).map((item) => item.target)).size ===
      mapping.filter((item) => item.target).length
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (activeJob.current) void api.cancelImportJob(activeJob.current).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (!job || job.state !== 'running') return
    let stopped = false,
      timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.importJob(job.id)
        if (stopped || !live.current) return
        setJob(next)
        if (next.state !== 'running') {
          activeJob.current = undefined
          lock.current = false
          callbacks.current.onBusyChange(false)
          return
        }
      } catch (failure) {
        if (!stopped)
          setError(
            `Progress is unavailable: ${errorText(failure)} The database outcome is not yet confirmed.`,
          )
      }
      if (!stopped) timer = setTimeout(() => void poll(), 350)
    }
    timer = setTimeout(() => void poll(), 200)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [job?.id, job?.state])
  function changeOptions(patch: Partial<ImportOptions>) {
    setOptions({ ...options, ...patch })
    setPreview(undefined)
    setMapping([])
    setConfirmation('')
    setConsent(false)
    setAppendConsent(false)
  }
  async function choose() {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setPreview(undefined)
    setJob(undefined)
    setConsent(false)
    setAppendConsent(false)
    setConfirmation('')
    try {
      const selected = await api.chooseImportFile({ target, options })
      if (!selected || !live.current) return
      setPreview(selected)
      setMapping(
        selected.columns.map((name, source) => ({
          source,
          target: structure.columns.find((column) => column.name === name)?.name || '',
          type: 'text',
        })),
      )
    } catch (failure) {
      if (live.current) setError(errorText(failure))
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  async function start() {
    if (
      !preview ||
      lock.current ||
      !mappingValid ||
      !consent ||
      (append && !appendConsent) ||
      confirmation !== expected
    )
      return
    lock.current = true
    setBusy(true)
    setError('')
    setCancelling(false)
    onBusyChange(true)
    try {
      const next = await api.startImportJob({
        ...target,
        sourceId: preview.sourceId,
        mapping: mapping.filter((item) => item.target),
        batchSize,
        errorPolicy: policy,
        consentBatchCommits: true,
        ...(append ? { consentNonTransactionalAppend: true as const } : {}),
        confirm: confirmation,
      })
      setJob(next)
      setPreview(undefined)
      if (next.state === 'running') activeJob.current = next.id
      else {
        lock.current = false
        onBusyChange(false)
      }
    } catch (failure) {
      setError(errorText(failure))
      setPreview(undefined)
      lock.current = false
      onBusyChange(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !running) onClose()
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import file into table</DialogTitle>
          <DialogDescription>
            {profile.name} · {profile.environment} · {tab.database || profile.database} · {target.schema}.
            {target.table}. Inserts use a separate session. Existing rows are never silently replaced.
          </DialogDescription>
        </DialogHeader>
        {!job && (
          <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
            <label>
              Format
              <select
                aria-label="Import format"
                value={options.format}
                onChange={(event) => changeOptions({ format: event.target.value as ImportOptions['format'] })}
              >
                <option value="csv">CSV</option>
                <option value="jsonl">JSONL objects</option>
              </select>
            </label>
            <label>
              Encoding
              <select
                aria-label="Import encoding"
                value={options.encoding}
                onChange={(event) =>
                  changeOptions({ encoding: event.target.value as ImportOptions['encoding'] })
                }
              >
                <option value="utf8">UTF-8</option>
                <option value="utf16le">UTF-16 little endian</option>
              </select>
            </label>
            {options.format === 'csv' && (
              <>
                <label>
                  Delimiter
                  <select
                    aria-label="Import delimiter"
                    value={options.delimiter}
                    onChange={(event) =>
                      changeOptions({ delimiter: event.target.value as ImportOptions['delimiter'] })
                    }
                  >
                    <option value=",">Comma</option>
                    <option value=";">Semicolon</option>
                    <option value={'\t'}>Tab</option>
                    <option value="|">Pipe</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={options.header}
                    onChange={(event) => changeOptions({ header: event.target.checked })}
                  />
                  First row contains names
                </label>
                <label>
                  NULL token
                  <Input
                    aria-label="Import NULL token"
                    value={options.nullToken}
                    maxLength={32}
                    onChange={(event) => changeOptions({ nullToken: event.target.value })}
                  />
                </label>
              </>
            )}
            <Button variant="outline" onClick={() => void choose()}>
              Choose and preview file…
            </Button>
          </fieldset>
        )}
        <p className="text-xs muted">
          CSV NULL tokens apply only to unquoted fields; quoted tokens and empty strings remain text. JSONL
          preserves exact numeric tokens and nested JSON; absent fields become NULL. Choose the conversion
          type explicitly. A preview cannot prove later rows will satisfy database constraints.
        </p>
        {preview && (
          <>
            <p>
              {preview.name} · {preview.bytes.toLocaleString()} bytes · preview up to 20 rows. Full values
              stay in the main process.
            </p>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th>Source line</th>
                    {preview.columns.map((name, index) => (
                      <th key={index}>{name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={index}>
                      <td>{preview.lineNumbers[index]}</td>
                      {row.map((cell, position) => (
                        <td className="max-w-64 truncate" key={position}>
                          {cell === null ? 'NULL' : displayCell(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <fieldset disabled={busy} className="space-y-2">
              <legend>Map source fields to destination columns</legend>
              {mapping.map((item, index) => (
                <div key={index} className="grid grid-cols-3 items-center gap-2">
                  <span>
                    {preview.columns[item.source]} (#{item.source + 1})
                  </span>
                  <select
                    aria-label={`Destination for source ${index + 1}`}
                    value={item.target}
                    onChange={(event) =>
                      setMapping(
                        mapping.map((entry, position) =>
                          position === index ? { ...entry, target: event.target.value } : entry,
                        ),
                      )
                    }
                  >
                    <option value="">Skip this field</option>
                    {structure.columns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name} · {column.type}
                        {column.nullable ? ' · nullable' : ''}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Conversion for source ${index + 1}`}
                    value={item.type}
                    disabled={!item.target}
                    onChange={(event) =>
                      setMapping(
                        mapping.map((entry, position) =>
                          position === index
                            ? { ...entry, type: event.target.value as typeof entry.type }
                            : entry,
                        ),
                      )
                    }
                  >
                    {parameterDefinitionSchema.shape.type.options
                      .filter((type) => type !== 'null')
                      .map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                  </select>
                </div>
              ))}
              {!mappingValid && (
                <p role="status">
                  Map at least one field; destination columns must be unique. Unmapped destination columns use
                  their database defaults.
                </p>
              )}
              <div className="flex gap-4">
                <label>
                  Rows per batch
                  <Input
                    aria-label="Rows per import batch"
                    type="number"
                    min={1}
                    max={500}
                    value={batchSize}
                    onChange={(event) => setBatchSize(Number(event.target.value))}
                  />
                </label>
                <label>
                  Error policy
                  <select
                    aria-label="Import error policy"
                    value={policy}
                    onChange={(event) => setPolicy(event.target.value as typeof policy)}
                  >
                    <option value="stop">Stop on invalid row</option>
                    <option value="skip-invalid">Skip invalid source or type values</option>
                  </select>
                </label>
              </div>
              <p className="text-xs muted">
                Database, decoding, syntax and file-change errors always stop the job.{' '}
                {append
                  ? 'ClickHouse appends have no rollback. A lost acknowledgment leaves the active batch uncertain; rows may already exist.'
                  : 'Database errors roll back the current batch where confirmed; earlier batches remain committed.'}{' '}
                Automatic retry or resume is disabled because it can duplicate rows.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {append
                  ? 'I understand each append batch is separate, and cancellation does not undo accepted rows.'
                  : 'I understand each batch commits separately, and cancellation does not undo earlier commits.'}
              </label>
              {append && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={appendConsent}
                    onChange={(event) => setAppendConsent(event.target.checked)}
                  />
                  I authorize nontransactional append with no rollback. I will inspect uncertain outcomes
                  before any retry.
                </label>
              )}
              <label className="block">
                Type <code>{expected}</code> to confirm the exact target
                <Input
                  aria-label="Confirm import target"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <Button
                disabled={
                  !mappingValid ||
                  !consent ||
                  (append && !appendConsent) ||
                  confirmation !== expected ||
                  !Number.isInteger(batchSize) ||
                  batchSize < 1 ||
                  batchSize > 500
                }
                onClick={() => void start()}
              >
                Start reviewed import
              </Button>
            </fieldset>
          </>
        )}
        {busy && <p role="status">Preparing import…</p>}
        {job && (
          <section aria-label="Import progress" className="space-y-2">
            <p role="status">
              Import {job.state} · read {job.rowsRead.toLocaleString()} rows ·{' '}
              {job.bytesRead.toLocaleString()} / {job.fileBytes.toLocaleString()} bytes · source line{' '}
              {job.lastLine}
            </p>
            <dl className="grid grid-cols-2 gap-2">
              <dt>
                {job.commitModel === 'append' ? 'Acknowledged appended rows' : 'Confirmed committed rows'}
              </dt>
              <dd>{job.committedRows.toLocaleString()}</dd>
              <dt>Confirmed rolled-back rows</dt>
              <dd>{job.rolledBackRows.toLocaleString()}</dd>
              <dt>Rows with uncertain outcome</dt>
              <dd>{job.uncertainRows.toLocaleString()}</dd>
              <dt>Skipped invalid rows</dt>
              <dd>{job.skippedRows.toLocaleString()}</dd>
              <dt>
                {job.commitModel === 'append' ? 'Acknowledged append batches' : 'Confirmed committed batches'}
              </dt>
              <dd>{job.committedBatches.toLocaleString()}</dd>
            </dl>
            {job.uncertainRows > 0 && (
              <p role="alert">
                The server outcome could not be confirmed. Inspect the destination before retrying; these rows
                may already exist.
              </p>
            )}
            {job.error && <ErrorPanel message={job.error} />}
            {job.issues.length > 0 && (
              <ul>
                {job.issues.map((issue, index) => (
                  <li key={index}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {job.warnings.map((warning) => (
              <p className="text-xs muted" key={warning}>
                {warning}
              </p>
            ))}
            {running && (
              <Button
                variant="outline"
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true)
                  try {
                    setJob(await api.cancelImportJob(job.id))
                  } catch (failure) {
                    setCancelling(false)
                    setError(errorText(failure))
                  }
                }}
              >
                {cancelling ? 'Cancellation requested; awaiting database outcome…' : 'Cancel import'}
              </Button>
            )}
          </section>
        )}
        {error && <ErrorPanel message={error} />}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy || running} onClick={onClose}>
            Close
          </Button>
          {job && !running && (
            <Button
              onClick={() => {
                onClose()
                onImported()
              }}
            >
              Close and reload table
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
