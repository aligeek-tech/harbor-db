import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CircleStop, Link2 } from 'lucide-react'
import type { ConnectionProfile, ResultSet, TableStructure, WorkspaceTab } from '@shared/contracts'
import { relatedRecordTarget, type ForeignKeyInfo, type RelatedRecordTarget } from '@shared/related-records'
import type { SqlDialect } from '@shared/sql'
import { api } from '../lib/api'
import { errorText, uid } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { DataGrid } from './DataGrid'

type RelatedStructure = TableStructure & { foreignKeys?: ForeignKeyInfo[] }
type Frame = {
  target: RelatedRecordTarget
  result: ResultSet
  structure: RelatedStructure
  selectedRows: Set<number>
}

/** Independent read sessions leave the parent editor's pending changes/transaction untouched. */
export function RelatedRecords({
  profile,
  tab,
  structure,
  result,
  selectedRow,
  disabled = false,
}: {
  profile: ConnectionProfile
  tab: WorkspaceTab
  structure: RelatedStructure
  result: ResultSet
  selectedRow?: number
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [frames, setFrames] = useState<Frame[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [readingMetadata, setReadingMetadata] = useState(false)
  const active = useRef<{ generation: string; requestId: string; sessionId: string } | null>(null)
  const sessions = useRef(new Map<string, string>())
  const current = frames.at(-1)
  const source = current?.result || result
  const currentRow = current
    ? current.selectedRows.size === 1
      ? [...current.selectedRows][0]
      : undefined
    : selectedRow
  const catalog = current?.structure || structure
  const dialect = profile.engine as SqlDialect
  const currentDatabase = current?.target.database || tab.database
  const keys = catalog.foreignKeys

  function releaseSessions() {
    const request = active.current
    active.current = null
    if (request)
      void api
        .cancel({ connectionId: profile.id, sessionId: request.sessionId, requestId: request.requestId })
        .catch(() => {})
    for (const sessionId of sessions.current.values())
      void api.closeSession({ connectionId: profile.id, sessionId }).catch(() => {})
    sessions.current.clear()
  }
  useEffect(() => () => releaseSessions(), [profile.id, tab.id])

  async function navigate(target: RelatedRecordTarget) {
    if (busy || disabled || frames.length >= 10) return
    const requestId = uid(),
      generation = uid()
    const databaseKey = target.database || ''
    const sessionId = sessions.current.get(databaseKey) || uid()
    sessions.current.set(databaseKey, sessionId)
    active.current = { generation, requestId, sessionId }
    setBusy(true)
    setReadingMetadata(false)
    setError('')
    try {
      const response = await api.query({
        connectionId: profile.id,
        database: target.database,
        sessionId,
        requestId,
        sql: target.sql,
        parameters: target.parameters,
        maxRows: 200,
        privateSession: true,
      })
      if (active.current?.generation !== generation) return
      if (response.cancelled)
        throw new Error('Related-record read was cancelled. Previous results remain available.')
      const related = response.sets[0]
      if (!related) throw new Error('The database returned no result set for the related-record read.')
      let targetStructure: RelatedStructure
      setReadingMetadata(true)
      try {
        targetStructure = await api.structure({
          connectionId: profile.id,
          database: target.database,
          schema: target.schema,
          table: target.table,
        })
      } catch {
        targetStructure = { columns: [], indexes: [], constraints: [], ddl: '' }
      }
      if (active.current?.generation !== generation) return
      setFrames((previous) => [
        ...previous,
        { target, result: related, structure: targetStructure, selectedRows: new Set() },
      ])
    } catch (cause) {
      if (active.current?.generation === generation) setError(errorText(cause))
    } finally {
      if (active.current?.generation === generation) {
        active.current = null
        setBusy(false)
        setReadingMetadata(false)
      }
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || selectedRow === undefined}
        onClick={() => {
          setFrames([])
          setError('')
          setOpen(true)
        }}
      >
        <Link2 />
        Related records
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              releaseSessions()
              setBusy(false)
              setReadingMetadata(false)
              setOpen(false)
            }
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
            <DialogHeader>
              <DialogTitle>Related records</DialogTitle>
              <DialogDescription>
                {profile.name} · {profile.environment}. Follow declared database foreign keys using separate
                read sessions. Uncommitted parent edits may not be visible here. Reads are limited to 200 rows
                and are excluded from history.
              </DialogDescription>
            </DialogHeader>
            <nav aria-label="Related record breadcrumbs" className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setFrames([])
                  setError('')
                }}
              >
                {tab.schema ? `${tab.schema}.` : ''}
                {tab.table}
              </Button>
              {frames.map((frame, index) => (
                <span key={index} className="flex items-center gap-2">
                  →
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setFrames((previous) => previous.slice(0, index + 1))
                      setError('')
                    }}
                  >
                    {frame.target.schema}.{frame.target.table}
                  </Button>
                </span>
              ))}
              {!!frames.length && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setFrames((previous) => previous.slice(0, -1))
                    setError('')
                  }}
                >
                  <ArrowLeft />
                  Back to previous rows
                </Button>
              )}
            </nav>
            {busy && (
              <div role="status" className="flex items-center gap-3">
                {readingMetadata ? 'Reading related table metadata…' : 'Reading selected related records…'}
                <Button
                  variant="outline"
                  onClick={() => {
                    if (readingMetadata) {
                      active.current = null
                      setBusy(false)
                      setReadingMetadata(false)
                      setError(
                        'Stopped waiting for metadata. The bounded server request may finish; late results are ignored.',
                      )
                      return
                    }
                    const request = active.current
                    if (request)
                      void api
                        .cancel({
                          connectionId: profile.id,
                          sessionId: request.sessionId,
                          requestId: request.requestId,
                        })
                        .then((response) => setError(response.message))
                        .catch((cause) => setError(errorText(cause)))
                  }}
                >
                  <CircleStop />
                  {readingMetadata ? 'Stop waiting for metadata' : 'Cancel read'}
                </Button>
              </div>
            )}
            {error && (
              <p className="danger" role="alert">
                {error}
              </p>
            )}
            <div className="flex flex-col gap-2" aria-label="Declared foreign keys">
              {frames.length >= 10 && (
                <p className="field-note">
                  Ten navigation steps are retained. Return to a previous breadcrumb before following another
                  reference.
                </p>
              )}
              {!keys ? (
                <p className="field-note">
                  Structured foreign-key metadata is unavailable for this target or account. No relationships
                  are inferred.
                </p>
              ) : !keys.length ? (
                <p className="field-note">No declared foreign keys were returned for this table.</p>
              ) : (
                keys.map((key, index) => {
                  const available = relatedRecordTarget(key, source, currentRow, dialect, currentDatabase)
                  return (
                    <div key={`${key.name}:${index}`} className="rounded border p-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <strong>{key.name}</strong>
                        <span className="field-note">
                          ({key.columns.join(', ')}) →{' '}
                          {key.referencedDatabase ? `${key.referencedDatabase} / ` : ''}
                          {key.referencedSchema}.{key.referencedTable} ({key.referencedColumns.join(', ')})
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || disabled || frames.length >= 10 || !available.target}
                          onClick={() => {
                            if (available.target) void navigate(available.target)
                          }}
                        >
                          Open referenced rows · {key.name}
                        </Button>
                      </div>
                      {available.reason && <p className="field-note">{available.reason}</p>}
                    </div>
                  )
                })
              )}
            </div>
            {current && (
              <>
                <p role="status" className="field-note">
                  {current.result.rows.length} loaded rows · at most 200 returned. Breadcrumbs restore
                  previously loaded results without another query.
                </p>
                <div className="h-[420px] min-h-0">
                  <DataGrid
                    key={frames.length}
                    set={current.result}
                    tab={{
                      id: `related-${tab.id}-${frames.length}`,
                      connectionId: profile.id,
                      database: current.target.database,
                      schema: current.target.schema,
                      table: current.target.table,
                      kind: 'table',
                      title: current.target.table,
                      sql: '',
                    }}
                    selectedRows={current.selectedRows}
                    onSelectedRowsChange={(rows) =>
                      setFrames((previous) =>
                        previous.map((frame, index) =>
                          index === previous.length - 1 ? { ...frame, selectedRows: rows } : frame,
                        ),
                      )
                    }
                    selectionDisabled={busy}
                  />
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
