import { useState } from 'react'
import type { ConnectionProfile, TableStructure, WorkspaceTab } from '@shared/contracts'
import type {
  SqlAdminAction,
  SqlAdminInspection,
  SqlAdminKind,
  SqlAdminPreview,
  SqlAdminResult,
} from '@shared/sql-administration'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { CopyButton, ErrorPanel } from './common'
import { DataGrid } from './DataGrid'
import { SchemaChangesDialog } from './SchemaChangesDialog'

const kinds: [SqlAdminKind, string][] = [
  ['sessions', 'Sessions'],
  ['health', 'Server and database counters'],
  ['partitions', 'Partition metadata'],
  ['routines', 'Routines'],
  ['events', 'Server events'],
  ['query-statistics', 'Optional query statistics'],
  ['permissions', 'Privileges and access'],
  ['index-usage', 'Indexes, sizes and usage'],
  ['timescale', 'TimescaleDB policies and jobs'],
]
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER'] as const

/** Every network action is a user click. Review tokens belong to main; this view cannot edit their SQL. */
export function SqlAdministration({ profile, database }: { profile: ConnectionProfile; database?: string }) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<SqlAdminKind>('sessions')
  const [schema, setSchema] = useState(
      profile.schema || (profile.engine === 'postgres' ? 'public' : database || profile.database),
    ),
    [table, setTable] = useState('')
  const [includeText, setIncludeText] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [inspection, setInspection] = useState<SqlAdminInspection>(),
    [preview, setPreview] = useState<SqlAdminPreview>(),
    [result, setResult] = useState<SqlAdminResult>(),
    [confirmation, setConfirmation] = useState(''),
    [index, setIndex] = useState(0)
  const [principal, setPrincipal] = useState(''),
    [host, setHost] = useState(''),
    [mode, setMode] = useState<'grant' | 'revoke'>('grant'),
    [selected, setSelected] = useState<(typeof privileges)[number][]>(['SELECT'])
  const [policy, setPolicy] = useState<'retention' | 'compression'>('retention'),
    [policyMode, setPolicyMode] = useState<'add' | 'remove'>('add'),
    [age, setAge] = useState(720),
    [schedule, setSchedule] = useState(24),
    [firstStart, setFirstStart] = useState(''),
    [jobId, setJobId] = useState(''),
    [scheduled, setScheduled] = useState(false)
  const [structure, setStructure] = useState<TableStructure>()
  if (!['postgres', 'mysql', 'mariadb'].includes(profile.engine)) return null
  const target = {
    connectionId: profile.id,
    database: database || profile.database || undefined,
    schema: schema || undefined,
    table: table || undefined,
  }
  const tab: WorkspaceTab = {
    id: `administration-${profile.id}`,
    connectionId: profile.id,
    title: 'Administration snapshot',
    kind: 'query',
    sql: '',
  }
  const resetReview = () => {
    setPreview(undefined)
    setResult(undefined)
    setConfirmation('')
    setError('')
  }
  const resetScope = () => {
    resetReview()
    setInspection(undefined)
    setIndex(0)
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
  const review = (action: SqlAdminAction) =>
    run(async () => {
      resetReview()
      setPreview(await api.previewSqlAdministration({ target, action }))
    })
  const time = () => {
    if (!firstStart) throw new Error('Choose an explicit future first/next start.')
    return new Date(firstStart).toISOString()
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        SQL administration
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value)
            if (!value) resetReview()
          }
        }}
      >
        <DialogContent className="flex h-[90vh] max-w-6xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>SQL administration</DialogTitle>
            <DialogDescription>
              {profile.name} · {database || profile.database || 'maintenance database'} ·{' '}
              {profile.environment}. Inspect explicitly; review each server change separately.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto space-y-3 pr-2">
            <fieldset disabled={busy} className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                Inspect
                <select
                  aria-label="Administration view"
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as SqlAdminKind)
                    resetScope()
                  }}
                >
                  {kinds
                    .filter(([value]) =>
                      profile.engine === 'postgres' ? value !== 'events' : value !== 'timescale',
                    )
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-xs">
                Schema
                <Input
                  aria-label="Administration schema"
                  className="w-40"
                  value={schema}
                  onChange={(event) => {
                    setSchema(event.target.value)
                    resetScope()
                  }}
                />
              </label>
              <label className="text-xs">
                Table (optional for inspection)
                <Input
                  aria-label="Administration table"
                  className="w-48"
                  value={table}
                  onChange={(event) => {
                    setTable(event.target.value)
                    resetScope()
                  }}
                />
              </label>
              <Button
                onClick={() =>
                  void run(async () => {
                    resetReview()
                    setIndex(0)
                    setInspection(
                      await api.inspectSqlAdministration({ ...target, kind, includeQueryText: includeText }),
                    )
                  })
                }
              >
                {busy ? 'Working…' : 'Load administration snapshot'}
              </Button>
            </fieldset>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                disabled={busy}
                checked={includeText}
                onChange={(event) => {
                  setIncludeText(event.target.checked)
                  resetScope()
                }}
              />
              Include query/routine text (may contain sensitive values; remains in memory)
            </label>
            <p className="text-xs muted">
              Snapshots are capped at 200 rows per set. No polling, extension installation, automatic queries,
              or desktop scheduler. The profile read-only preference is not database authorization.
            </p>
            {profile.readOnly && (
              <p className="text-xs">
                This profile permits inspection only. Administration commands require an explicitly writable
                profile.
              </p>
            )}
            {error && <ErrorPanel message={error} />}
            {inspection && (
              <section className="space-y-2" aria-label="Administration snapshot">
                {inspection.warnings.map((warning, i) => (
                  <p className="text-xs" key={i}>
                    {warning}
                  </p>
                ))}
                {!inspection.available && (
                  <p role="status">
                    This inspection is unavailable with the current privileges or server capabilities.
                  </p>
                )}
                {inspection.sets.length > 1 && (
                  <select
                    aria-label="Administration result set"
                    value={index}
                    onChange={(event) => setIndex(Number(event.target.value))}
                  >
                    {inspection.sets.map((set, i) => (
                      <option value={i} key={i}>
                        {set.command || `Result ${i + 1}`}
                      </option>
                    ))}
                  </select>
                )}
                {inspection.sets[index] && (
                  <div className="flex h-72 min-h-0 flex-col">
                    <DataGrid set={inspection.sets[index]} tab={tab} />
                  </div>
                )}
                {kind === 'sessions' && inspection.sessions && (
                  <div className="space-y-1" aria-label="Reviewed session actions">
                    <p className="text-xs">
                      Each action displays the exact native target and expires after 30 seconds. Cancellation
                      does not guarantee transaction rollback.
                    </p>
                    {inspection.sessions.map((session) => (
                      <div
                        className="flex flex-wrap items-center gap-2 border-b py-1 text-xs"
                        key={session.id}
                      >
                        <span>
                          Session {session.id} · {session.user} · {session.database} · {session.client} ·{' '}
                          {session.state}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            profile.readOnly ||
                            !['active', 'Query', 'Execute'].includes(session.state)
                          }
                          onClick={() =>
                            void review({ kind: 'session', mode: 'cancel', sessionId: session.id })
                          }
                        >
                          Review cancel {session.id}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || profile.readOnly}
                          onClick={() =>
                            void review({ kind: 'session', mode: 'terminate', sessionId: session.id })
                          }
                        >
                          Review terminate {session.id}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            {kind === 'permissions' && (
              <fieldset
                disabled={busy || profile.readOnly}
                className="space-y-2 rounded border p-3"
                aria-label="Table privilege changes"
              >
                <legend>Review table privileges</legend>
                <p className="text-xs">
                  An exact existing principal and base table are required. No account creation, grant option,
                  role membership changes, or automatic privilege escalation.
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label="Privilege action"
                    value={mode}
                    onChange={(event) => {
                      setMode(event.target.value as typeof mode)
                      resetReview()
                    }}
                  >
                    <option value="grant">Grant</option>
                    <option value="revoke">Revoke</option>
                  </select>
                  <Input
                    aria-label="Existing principal"
                    placeholder="Existing role / user"
                    value={principal}
                    onChange={(event) => {
                      setPrincipal(event.target.value)
                      resetReview()
                    }}
                  />
                  {profile.engine !== 'postgres' && (
                    <Input
                      aria-label="Existing account host"
                      placeholder="Exact existing account host"
                      value={host}
                      onChange={(event) => {
                        setHost(event.target.value)
                        resetReview()
                      }}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {privileges.map((privilege) => (
                    <label className="flex items-center gap-1 text-xs" key={privilege}>
                      <input
                        type="checkbox"
                        checked={selected.includes(privilege)}
                        onChange={(event) => {
                          setSelected(
                            event.target.checked
                              ? [...selected, privilege]
                              : selected.filter((value) => value !== privilege),
                          )
                          resetReview()
                        }}
                      />
                      {privilege}
                    </label>
                  ))}
                </div>
                <Button
                  disabled={
                    !principal ||
                    !schema ||
                    !table ||
                    !selected.length ||
                    (profile.engine !== 'postgres' && !host)
                  }
                  onClick={() =>
                    void review({
                      kind: 'privilege',
                      mode,
                      principal,
                      ...(profile.engine !== 'postgres' ? { host } : {}),
                      privileges: selected,
                    })
                  }
                >
                  Preview privilege command
                </Button>
              </fieldset>
            )}
            {kind === 'index-usage' && (
              <div className="space-y-2">
                <p className="text-xs">
                  Use the schema editor for reviewed index creation/removal, dependency checks and native
                  outcomes. Zero observed use is not evidence an index can safely be removed.
                </p>
                <Button
                  disabled={busy || profile.readOnly || !schema || !table}
                  onClick={() =>
                    void run(async () => setStructure(await api.structure({ ...target, schema, table })))
                  }
                >
                  Review table indexes
                </Button>
              </div>
            )}
            {kind === 'timescale' && (
              <fieldset
                disabled={busy || profile.readOnly}
                className="space-y-3 rounded border p-3"
                aria-label="Timescale policy changes"
              >
                <legend>Review persistent server policies</legend>
                <p className="text-xs">
                  Select an existing temporal hypertable. Compression must already be configured. Retention
                  permanently removes chunks. Jobs persist on the server after this app closes.
                </p>
                <div className="flex flex-wrap gap-2">
                  <label>
                    Policy
                    <select
                      aria-label="Timescale policy"
                      value={policy}
                      onChange={(event) => {
                        setPolicy(event.target.value as typeof policy)
                        resetReview()
                      }}
                    >
                      <option value="retention">Retention</option>
                      <option value="compression">Compression / legacy API</option>
                    </select>
                  </label>
                  <label>
                    Action
                    <select
                      aria-label="Timescale policy action"
                      value={policyMode}
                      onChange={(event) => {
                        setPolicyMode(event.target.value as typeof policyMode)
                        resetReview()
                      }}
                    >
                      <option value="add">Add policy</option>
                      <option value="remove">Remove policy</option>
                    </select>
                  </label>
                  {policyMode === 'add' && (
                    <label>
                      Age (hours)
                      <Input
                        aria-label="Policy age hours"
                        type="number"
                        min={1}
                        max={876000}
                        value={age}
                        onChange={(event) => {
                          setAge(Number(event.target.value))
                          resetReview()
                        }}
                      />
                    </label>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <label>
                    Schedule interval (hours)
                    <Input
                      aria-label="Policy schedule hours"
                      type="number"
                      min={1}
                      max={8760}
                      value={schedule}
                      onChange={(event) => {
                        setSchedule(Number(event.target.value))
                        resetReview()
                      }}
                    />
                  </label>
                  <label>
                    Explicit first / next start (local time)
                    <Input
                      aria-label="Policy future start"
                      type="datetime-local"
                      value={firstStart}
                      onChange={(event) => {
                        setFirstStart(event.target.value)
                        resetReview()
                      }}
                    />
                  </label>
                </div>
                <Button
                  disabled={!schema || !table}
                  onClick={() =>
                    void run(async () => {
                      resetReview()
                      setPreview(
                        await api.previewSqlAdministration({
                          target,
                          action: {
                            kind: 'timescale-policy',
                            mode: policyMode,
                            policy,
                            ...(policyMode === 'add'
                              ? { ageHours: age, scheduleHours: schedule, initialStart: time() }
                              : {}),
                          },
                        }),
                      )
                    })
                  }
                >
                  Preview policy command
                </Button>
                <div className="flex flex-wrap items-end gap-2 border-t pt-2">
                  <label>
                    Existing policy job ID
                    <Input
                      aria-label="Existing policy job ID"
                      type="number"
                      min={1}
                      value={jobId}
                      onChange={(event) => {
                        setJobId(event.target.value)
                        resetReview()
                      }}
                    />
                  </label>
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={scheduled}
                      onChange={(event) => {
                        setScheduled(event.target.checked)
                        resetReview()
                      }}
                    />
                    Enable future scheduling
                  </label>
                  <Button
                    disabled={!schema || !table || !jobId}
                    onClick={() =>
                      void run(async () => {
                        resetReview()
                        setPreview(
                          await api.previewSqlAdministration({
                            target,
                            action: {
                              kind: 'timescale-job',
                              jobId: Number(jobId),
                              scheduled,
                              scheduleHours: schedule,
                              ...(scheduled ? { nextStart: time() } : {}),
                            },
                          }),
                        )
                      })
                    }
                  >
                    Preview job schedule
                  </Button>
                </div>
                <p className="text-xs">
                  Only existing extension-owned policy jobs for this exact hypertable are accepted. Pausing
                  does not cancel a currently running job. No immediate Run job action is provided.
                </p>
              </fieldset>
            )}
            {preview && (
              <section aria-label="Administration command review" className="space-y-2 rounded border p-3">
                <p className="font-medium">Review exact server command</p>
                <p className="text-xs">
                  Expires {new Date(preview.expiresAt).toLocaleTimeString()}. Execution rechecks the native
                  target; a used token cannot be retried.
                </p>
                <dl className="text-xs">
                  {preview.identity.map((item) => (
                    <div key={item.name}>
                      <dt className="inline font-medium">{item.name}: </dt>
                      <dd className="inline">{item.value}</dd>
                    </div>
                  ))}
                </dl>
                {preview.statements.map((sql, i) => (
                  <div key={i}>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                      {sql}
                    </pre>
                    <CopyButton value={sql} />
                  </div>
                ))}
                {preview.warnings.map((warning, i) => (
                  <p className="text-xs" key={i}>
                    {warning}
                  </p>
                ))}
                {preview.blockedReasons.map((reason, i) => (
                  <ErrorPanel key={i} message={reason} />
                ))}
                {!result && !preview.blockedReasons.length && (
                  <>
                    <p className="text-xs">
                      Type exactly: <strong>{preview.confirmation}</strong>
                    </p>
                    <Input
                      aria-label="Administration target confirmation"
                      value={confirmation}
                      disabled={busy}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                    <Button
                      disabled={busy || confirmation !== preview.confirmation || profile.readOnly}
                      onClick={() =>
                        void run(async () => {
                          setResult(
                            await api.executeSqlAdministration({
                              token: preview.token,
                              confirm: confirmation,
                            }),
                          )
                          setConfirmation('')
                          setInspection(undefined)
                        })
                      }
                    >
                      Execute reviewed administration command
                    </Button>
                  </>
                )}
              </section>
            )}
            {result && (
              <section role="status" className="space-y-2 border p-3">
                <p className="font-medium">Administration outcome: {result.state}</p>
                <p>{result.message}</p>
                {result.warnings.map((warning, i) => (
                  <p key={i} className="text-xs">
                    {warning}
                  </p>
                ))}
                <p className="text-xs">
                  Load a new snapshot to inspect current server state. No automatic retry was attempted.
                </p>
              </section>
            )}
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              resetReview()
            }}
          >
            Done
          </Button>
        </DialogContent>
      </Dialog>
      {structure && schema && table && (
        <SchemaChangesDialog
          profile={profile}
          target={{ ...target, schema, table }}
          structure={structure}
          mode="edit"
          onClose={() => setStructure(undefined)}
        />
      )}
    </>
  )
}
