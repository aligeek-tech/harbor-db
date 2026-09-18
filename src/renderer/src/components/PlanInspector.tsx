import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import type { QueryParameter } from '@shared/parameters'
import type { ExplainResult } from '@shared/inspection'
import { api } from '../lib/api'
import { uid, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { CopyButton, ErrorPanel, IconButton, useConfirm } from './common'

function Tree({ value, depth = 0, path = 'Plan' }: { value: unknown; depth?: number; path?: string }) {
  if (depth > 12) return <p>Further nesting is available in the raw plan.</p>
  if (value === null || typeof value !== 'object') return <span>{String(value)}</span>
  const entries = Object.entries(value)
  return (
    <ul className="space-y-1 border-l pl-3">
      {entries.slice(0, 100).map(([key, child]) => (
        <li key={key}>
          {child && typeof child === 'object' ? (
            <details open={depth < 3}>
              <summary>{Array.isArray(value) ? `${path} ${Number(key) + 1}` : key}</summary>
              <Tree value={child} depth={depth + 1} path={key} />
            </details>
          ) : (
            <span>
              <strong>{key}:</strong> {String(child)}
            </span>
          )}
        </li>
      ))}
      {entries.length > 100 && <li>Additional fields remain in raw plan.</li>}
    </ul>
  )
}
export function PlanInspector({
  profile,
  tab,
  database,
  getStatement,
  disabled,
}: {
  profile: ConnectionProfile
  tab: WorkspaceTab
  database?: string
  getStatement: () => { sql: string; parameters: QueryParameter[] }
  disabled: boolean
}) {
  const [open, setOpen] = useState(false),
    [review, setReview] = useState<ReturnType<typeof getStatement>>(),
    [result, setResult] = useState<ExplainResult>(),
    [view, setView] = useState<'tree' | 'raw'>('tree'),
    [error, setError] = useState(''),
    [request, setRequest] = useState('')
  const confirm = useConfirm(),
    sessionId = `plan-${tab.id}`
  if (!['postgres', 'mariadb', 'mysql', 'clickhouse'].includes(profile.engine)) return null
  async function run(mode: 'estimate' | 'analyze') {
    if (!review) return
    if (
      mode === 'analyze' &&
      (await confirm({
        title: 'Run execution-based analysis?',
        description: `${profile.name} · ${database || profile.database} · ${profile.environment}. This really executes the SELECT and can consume resources or acquire locks. It uses a separate read-only transaction and cannot see this tab’s uncommitted data.`,
        detail: review.sql,
        typed: profile.name,
        label: 'Execute analysis',
      })) === false
    )
      return
    const id = uid()
    setRequest(id)
    setError('')
    setResult(undefined)
    useApp.getState().setRuntime(tab.id, { running: true, requestId: id })
    try {
      setResult(
        await api.explainQuery({
          connectionId: profile.id,
          database,
          sessionId,
          requestId: id,
          ...review,
          mode,
          ...(mode === 'analyze' ? { consentAnalyze: true } : {}),
        }),
      )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setRequest('')
      if (useApp.getState().runtime[tab.id]?.requestId === id)
        useApp.getState().setRuntime(tab.id, { running: false })
    }
  }
  let tree: unknown
  if (result?.format === 'json')
    try {
      tree = JSON.parse(result.raw)
    } catch {
      /* Raw is retained if an engine returns a non-JSON notice. */
    }
  return (
    <>
      <IconButton
        label="Inspect query plan"
        disabled={disabled}
        onClick={() => {
          try {
            setReview(getStatement())
            setError('')
            setResult(undefined)
            setOpen(true)
          } catch (failure) {
            setError(errorText(failure))
            setOpen(true)
          }
        }}
      >
        <GitBranch />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!request) {
            setOpen(next)
            if (!next) setReview(undefined)
          }
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-4xl flex-col">
          <DialogHeader>
            <DialogTitle>Query plan inspector</DialogTitle>
            <DialogDescription>
              {profile.name} · {database || profile.database} · {profile.environment}. Estimate planning and
              execution-based analysis are separate actions. {profile.engine === 'clickhouse' ? 'ClickHouse supports estimated plans here; execution-based analysis is unavailable.' : 'Estimates are approximate; compare actual rows and timing only after reviewed analysis.'}
            </DialogDescription>
          </DialogHeader>
          {review && (
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs">
              {review.sql}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <Button disabled={!review || !!request} onClick={() => void run('estimate')}>
              Estimate only
            </Button>
            <Button variant="outline" disabled={!review || !!request || profile.engine === 'clickhouse'} onClick={() => void run('analyze')}>
              Review execution-based analysis
            </Button>
            {!!request && (
              <Button
                variant="destructive"
                onClick={async () => {
                  try {
                    const cancelled = await api.cancel({
                      connectionId: profile.id,
                      sessionId,
                      requestId: request,
                    })
                    setError(cancelled.message)
                  } catch (failure) {
                    setError(errorText(failure))
                  }
                }}
              >
                Cancel plan
              </Button>
            )}
          </div>
          {error && <ErrorPanel message={error} />}
          {result?.warnings.map((warning, index) => (
            <p className="text-xs" key={index}>
              {warning}
            </p>
          ))}
          {result && (
            <>
              <div className="flex gap-2">
                <Button variant={view === 'tree' ? 'secondary' : 'ghost'} onClick={() => setView('tree')}>
                  Plan tree
                </Button>
                <Button variant={view === 'raw' ? 'secondary' : 'ghost'} onClick={() => setView('raw')}>
                  Raw plan
                </Button>
                <CopyButton label="Copy raw plan" value={result.raw} />
                <span role="status">
                  {result.mode} · {result.durationMs.toFixed(0)} ms{result.cancelled ? ' · cancelled' : ''}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto text-xs">
                {view === 'tree' && tree ? (
                  <Tree value={tree} />
                ) : (
                  <pre className="whitespace-pre-wrap">{result.raw}</pre>
                )}
              </div>
            </>
          )}
          {!result && (
            <p role="status">
              {request
                ? 'Waiting for the database plan…'
                : 'Choose Estimate only to plan without executing the statement.'}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              variant="outline"
              disabled={!!request}
              onClick={() => {
                setOpen(false)
                setReview(undefined)
              }}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
