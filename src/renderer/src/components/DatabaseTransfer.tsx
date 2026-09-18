import { useEffect, useRef, useState } from 'react'
import type { Cell, ConnectionProfile, ObjectInfo } from '@shared/contracts'
import {
  DATABASE_TRANSFER_ENGINES,
  type DatabaseTransferJob,
  type DatabaseTransferPreview,
  type StartDatabaseTransferInput,
} from '@shared/database-transfer'
import { parameterDefinitionSchema, parameterValue, type QueryParameter } from '@shared/parameters'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

type Mapping = StartDatabaseTransferInput['mapping'][number]
const display = (cell: Cell) =>
  cell === null
    ? 'NULL'
    : typeof cell === 'object'
      ? `binary: ${cell.base64}`
      : cell === ''
        ? '(empty)'
        : String(cell)

/** Only explicit preview/start actions read data or write; opening this dialog is inert. */
export function DatabaseTransfer({
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
  const profiles = useApp((state) => state.profiles),
    statuses = useApp((state) => state.statuses)
  const [open, setOpen] = useState(false),
    [statement, setStatement] = useState<ReturnType<typeof getStatement>>()
  const [targetId, setTargetId] = useState(''),
    [targetDatabase, setTargetDatabase] = useState(''),
    [schema, setSchema] = useState(''),
    [table, setTable] = useState('')
  const [objects, setObjects] = useState<ObjectInfo[]>([]),
    [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<DatabaseTransferPreview>(),
    [mapping, setMapping] = useState<Mapping[]>([])
  const [batchSize, setBatchSize] = useState(100),
    [maxRows, setMaxRows] = useState(10000),
    [confirm, setConfirm] = useState('')
  const [consentRerun, setConsentRerun] = useState(false),
    [consentBatch, setConsentBatch] = useState(false)
  const [job, setJob] = useState<DatabaseTransferJob>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const generation = useRef(0)
  const target = profiles.find((value) => value.id === targetId),
    running = job?.state === 'running'
  const targetIdentity = JSON.stringify(target),
    sourceIdentity = JSON.stringify([profile, database])
  const reset = () => {
    setPreview(undefined)
    setMapping([])
    setConfirm('')
    setConsentBatch(false)
    setConsentRerun(false)
    setError('')
  }
  useEffect(() => {
    generation.current++
    setPreview(undefined)
    setMapping([])
    setConfirm('')
    setStatement(undefined)
    setBusy(false)
  }, [sourceIdentity])
  useEffect(() => {
    generation.current++
    setPreview(undefined)
    setMapping([])
    setConfirm('')
    setBusy(false)
  }, [targetIdentity])
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  useEffect(() => {
    if (!job || job.state !== 'running') return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.getDatabaseTransferJob(job.id)
        if (live) setJob(next)
      } catch (failure) {
        if (live) setError(errorText(failure))
      } finally {
        if (live) timer = setTimeout(poll, 500)
      }
    }
    timer = setTimeout(poll, 500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [job?.id, job?.state])
  if (!DATABASE_TRANSFER_ENGINES.includes(profile.engine)) return null
  const eligible = (value: ConnectionProfile) =>
    value.id !== profile.id &&
    DATABASE_TRANSFER_ENGINES.includes(value.engine) &&
    !value.readOnly &&
    statuses[value.id]?.state === 'connected'
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    const epoch = generation.current
    setBusy(true)
    setError('')
    try {
      await action(() => epoch === generation.current)
    } catch (failure) {
      if (epoch === generation.current) setError(errorText(failure))
    } finally {
      if (epoch === generation.current) setBusy(false)
    }
  }
  const capture = () => {
    const value = getStatement()
    value.parameters.forEach(parameterValue)
    setStatement(value)
    return value
  }
  const changeTarget = () => {
    generation.current++
    reset()
    setObjects([])
    setLoaded(false)
    setTable('')
  }
  const validMapping =
    mapping.length > 0 && new Set(mapping.map((value) => value.target)).size === mapping.length
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled && !job}
        onClick={() => {
          if (!running) {
            reset()
            setJob(undefined)
            try {
              capture()
            } catch (failure) {
              setError(errorText(failure))
            }
          }
          setOpen(true)
        }}
      >
        {running ? `Transfer: ${job.committedRows.toLocaleString()} committed` : 'Transfer to database'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Transfer a query result to a database</DialogTitle>
            <DialogDescription>
              Source: {profile.name} · {profile.engine} ·{' '}
              {['sqlite', 'duckdb'].includes(profile.engine)
                ? 'Local database'
                : `${profile.host}:${profile.port}`}{' '}
              · {database || profile.database || 'main'} · {profile.environment}.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-2">
            <p className="text-xs">
              Supported source/destination matrix: PostgreSQL, SQLite and DuckDB, in each direction between
              separate connections. Destination must be an existing base table. Source tab transactions are
              not reused. No writes occur during preview.
            </p>
            <fieldset disabled={busy || running} className="space-y-3">
              <label>
                Destination connection
                <select
                  aria-label="Transfer destination connection"
                  value={targetId}
                  onChange={(event) => {
                    changeTarget()
                    const next = profiles.find((value) => value.id === event.target.value)
                    setTargetId(event.target.value)
                    setTargetDatabase(next?.database || 'main')
                    setSchema(next?.engine === 'postgres' ? 'public' : 'main')
                  }}
                >
                  <option value="">Choose a connected writable destination</option>
                  {profiles.map((value) => (
                    <option key={value.id} value={value.id} disabled={!eligible(value)}>
                      {value.name} · {value.engine} · {value.environment}
                      {!eligible(value)
                        ? ' · unavailable (same source, unsupported, disconnected or read-only)'
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              {!profiles.some(eligible) && (
                <p role="status" className="text-xs">
                  Connect a separate writable PostgreSQL, SQLite or DuckDB profile first.
                </p>
              )}
              {target && (
                <>
                  <p className="text-xs">
                    Destination: {target.name} ·{' '}
                    {['sqlite', 'duckdb'].includes(target.engine)
                      ? 'Local database'
                      : `${target.host}:${target.port}`}{' '}
                    · {target.environment}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <label>
                      Destination database
                      <Input
                        aria-label="Transfer destination database"
                        value={targetDatabase}
                        onChange={(event) => {
                          changeTarget()
                          setTargetDatabase(event.target.value)
                        }}
                      />
                    </label>
                    <label>
                      Destination schema
                      <Input
                        aria-label="Transfer destination schema"
                        value={schema}
                        onChange={(event) => {
                          changeTarget()
                          setSchema(event.target.value)
                        }}
                      />
                    </label>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!eligible(target) || !targetDatabase || !schema}
                    onClick={() =>
                      void run(async (current) => {
                        reset()
                        setTable('')
                        setLoaded(false)
                        const next = await api.listObjects({
                          connectionId: target.id,
                          database: targetDatabase,
                          schema,
                        })
                        if (current()) {
                          setObjects(
                            next.filter((value) => value.kind === 'table' && value.schema === schema),
                          )
                          setLoaded(true)
                        }
                      })
                    }
                  >
                    Load destination tables
                  </Button>
                  {loaded && (
                    <label>
                      Destination table
                      <select
                        aria-label="Transfer destination table"
                        value={table}
                        onChange={(event) => {
                          reset()
                          setTable(event.target.value)
                        }}
                      >
                        <option value="">Choose a base table</option>
                        {objects.map((value) => (
                          <option key={value.name} value={value.name}>
                            {value.schema}.{value.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {loaded && !objects.length && (
                    <p role="status" className="text-xs">
                      No visible base tables in this namespace. Check the database, schema and permissions.
                    </p>
                  )}
                </>
              )}
              {statement && (
                <pre
                  aria-label="Transfer source SQL"
                  className="max-h-32 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs"
                >
                  {statement.sql}
                </pre>
              )}
              {!!statement?.parameters.length && (
                <p className="text-xs">
                  {statement.parameters.length} native parameters; values stay hidden and are not recorded in
                  job progress.
                </p>
              )}
              <Button
                disabled={!target || !eligible(target) || !table || disabled}
                onClick={() =>
                  void run(async (current) => {
                    reset()
                    setJob(undefined)
                    const value = capture()
                    const next = await api.previewDatabaseTransfer({
                      source: { connectionId: profile.id, database, ...value },
                      target: { connectionId: targetId, database: targetDatabase, schema, table },
                    })
                    if (current()) {
                      setPreview(next)
                      setMapping([])
                    }
                  })
                }
              >
                Preview source and destination
              </Button>
            </fieldset>
            {error && <ErrorPanel message={error} />}
            {preview && (
              <section aria-label="Database transfer review" className="space-y-3 rounded border p-3">
                <p className="font-medium">
                  {preview.sourceName} → {preview.targetName}
                </p>
                <p className="text-xs">
                  {preview.sourceConsistency} Review expires{' '}
                  {new Date(preview.expiresAt).toLocaleTimeString()}.
                </p>
                {preview.warnings.map((warning) => (
                  <p className="text-xs" key={warning}>
                    {warning}
                  </p>
                ))}
                <details>
                  <summary>Source sample: {preview.rows.length} rows (clipped display)</summary>
                  <div className="max-h-48 overflow-auto">
                    <table className="text-xs">
                      <thead>
                        <tr>
                          {preview.sourceColumns.map((column, index) => (
                            <th key={index} className="p-2">
                              {index + 1}: {column.name} ({column.type})
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, index) => (
                          <tr key={index}>
                            {row.map((cell, i) => (
                              <td key={i} className="max-w-60 break-all border p-2">
                                {display(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                <fieldset disabled={busy || running || !!job} className="space-y-3">
                  <p className="text-sm">
                    Map destination columns explicitly. Omitted columns use defaults. Source column numbers
                    distinguish duplicate labels.
                  </p>
                  {preview.targetColumns.map((column) => {
                    const item = mapping.find((value) => value.target === column.name),
                      generated = column.generated || column.identity === 'always',
                      temporal = /^(?:date|time|timestamp|timestamptz|timetz|interval)\b/i.test(column.type)
                    return (
                      <div key={column.name} className="grid grid-cols-[1fr_1fr_8rem] items-center gap-2">
                        <div className="min-w-0 break-all text-xs">
                          {column.name} · {column.type}
                          {column.primaryKey && ' · primary key'}
                          {column.generated && ' · generated'}
                          {column.identity && ` · identity ${column.identity}`}
                          {!column.nullable && ' · required'}
                          {column.defaultValue !== null && ` · default ${column.defaultValue}`}
                        </div>
                        <select
                          aria-label={`Source for ${column.name}`}
                          disabled={generated || temporal}
                          value={item?.source ?? ''}
                          onChange={(event) => {
                            setConfirm('')
                            setMapping((old) => [
                              ...old.filter((value) => value.target !== column.name),
                              ...(event.target.value === ''
                                ? []
                                : [
                                    {
                                      source: Number(event.target.value),
                                      target: column.name,
                                      type: item?.type ?? ('text' as const),
                                    },
                                  ]),
                            ])
                          }}
                        >
                          <option value="">
                            {generated
                              ? 'Server generated; omit'
                              : temporal
                                ? 'Unsupported conversion; use TEXT'
                                : 'Omit / destination default'}
                          </option>
                          {preview.sourceColumns.map((value, index) => (
                            <option key={index} value={index}>
                              {index + 1}: {value.name} ({value.type})
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`Conversion for ${column.name}`}
                          disabled={!item || generated || temporal}
                          value={item?.type ?? 'text'}
                          onChange={(event) => {
                            setConfirm('')
                            setMapping((old) =>
                              old.map((value) =>
                                value.target === column.name
                                  ? { ...value, type: event.target.value as Mapping['type'] }
                                  : value,
                              ),
                            )
                          }}
                        >
                          {parameterDefinitionSchema.shape.type.options
                            .filter((value) => value !== 'null')
                            .map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                        </select>
                      </div>
                    )
                  })}
                  <div className="grid grid-cols-2 gap-3">
                    <label>
                      Rows per committed batch
                      <Input
                        type="number"
                        aria-label="Transfer batch size"
                        min={1}
                        max={500}
                        value={batchSize}
                        onChange={(event) => {
                          setConfirm('')
                          setBatchSize(Number(event.target.value))
                        }}
                      />
                    </label>
                    <label>
                      Maximum source rows
                      <Input
                        type="number"
                        aria-label="Transfer row limit"
                        min={1}
                        max={1000000}
                        value={maxRows}
                        onChange={(event) => {
                          setConfirm('')
                          setMaxRows(Number(event.target.value))
                        }}
                      />
                    </label>
                  </div>
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={consentRerun}
                      onChange={(event) => setConsentRerun(event.target.checked)}
                    />
                    Rerun the source in a fresh read-only snapshot; it can differ from this preview.
                  </label>
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={consentBatch}
                      onChange={(event) => setConsentBatch(event.target.checked)}
                    />
                    Commit each destination batch independently; cancellation and failure retain earlier
                    commits.
                  </label>
                  <p className="break-all text-xs">
                    Type exactly: <strong>{preview.confirmation}</strong>
                  </p>
                  <Input
                    aria-label="Transfer destination confirmation"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                  <Button
                    disabled={
                      !validMapping ||
                      !consentBatch ||
                      !consentRerun ||
                      confirm !== preview.confirmation ||
                      !target ||
                      !eligible(target) ||
                      disabled ||
                      !Number.isInteger(batchSize) ||
                      batchSize < 1 ||
                      batchSize > 500 ||
                      !Number.isInteger(maxRows) ||
                      maxRows < 1 ||
                      maxRows > 1000000
                    }
                    onClick={() =>
                      void run(async (current) => {
                        try {
                          const started = await api.startDatabaseTransfer({
                            token: preview.token,
                            confirm,
                            mapping,
                            batchSize,
                            maxRows,
                            consentBatchCommits: true,
                            consentRerun: true,
                          })
                          if (current()) setJob(started)
                        } finally {
                          if (current()) {
                            setPreview(undefined)
                            setConfirm('')
                          }
                        }
                      })
                    }
                  >
                    Start reviewed database transfer
                  </Button>
                </fieldset>
              </section>
            )}
            {job && (
              <section
                role="status"
                aria-label="Database transfer progress"
                className="space-y-2 rounded border p-3 text-sm"
              >
                <p>
                  {job.sourceName} → {job.targetName}
                </p>
                <p>
                  Transfer {job.state} · {(job.durationMs / 1000).toFixed(1)} seconds
                </p>
                <p>
                  {job.rowsRead.toLocaleString()} read · {job.committedRows.toLocaleString()} committed in{' '}
                  {job.committedBatches} batches · {job.rolledBackRows} confirmed rolled back ·{' '}
                  {job.uncertainRows} uncertain
                </p>
                <p>
                  {job.bufferedRows} buffered rows · {job.unwrittenRows} read but not submitted · maximum{' '}
                  {job.maxRows.toLocaleString()} rows
                </p>
                {job.limitReached && (
                  <p>Intentional row limit reached. Remaining source rows were not transferred.</p>
                )}
                {job.error && <p>{job.error}</p>}
                {job.warnings.map((warning) => (
                  <p className="text-xs" key={warning}>
                    {warning}
                  </p>
                ))}
                {running && (
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void run(async (current) => {
                        const next = await api.cancelDatabaseTransferJob(job.id)
                        if (current()) setJob(next)
                      })
                    }
                  >
                    Cancel database transfer
                  </Button>
                )}
              </section>
            )}
          </div>
          <p className="text-xs muted">
            Closing keeps an explicitly started job running while the app is open. Disconnecting either
            connection or quitting cancels it. No automatic retry or resume.
          </p>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
