import { MongoFileTools } from './MongoFileTools'
import { useEffect, useRef, useState } from 'react'
import { Database, Plus, RefreshCw, Play, Trash2, Save } from 'lucide-react'
import type { ConnectionProfile, MongoReadResult, WorkspaceTab } from '@shared/contracts'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { DataGrid } from './DataGrid'
import { ErrorPanel, useConfirm } from './common'
import { MongoPipelineBuilder } from './MongoPipelineBuilder'
import { MongoTools } from './MongoTools'

export function MongoBrowser({
  tab,
  profile,
  onSave,
}: {
  tab: WorkspaceTab
  profile: ConnectionProfile
  onSave: () => void
}) {
  const status = useApp((s) => s.statuses[profile.id]?.state)
  const database = tab.database || profile.database
  const collection = tab.table || ''
  const mode = tab.mongoMode || 'find'
  const query = tab.sql
  const execute = useRef<() => void>(() => {})
  const [databases, setDatabases] = useState<string[]>([])
  const [collections, setCollections] = useState<string[]>([])
  const [collectionFilter, setCollectionFilter] = useState('')
  const [result, setResult] = useState<MongoReadResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>()
  const [edit, setEdit] = useState<{ original?: string; text: string; insert: boolean; readonly: boolean }>()
  const [editError, setEditError] = useState('')
  const [writing, setWriting] = useState(false)
  const [toolsPending, setToolsPending] = useState(false)
  const [toolsBusy, setToolsBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const request = useRef(0)
  const running = useRef(false)
  const writePending = useRef(false)
  const mounted = useRef(true)
  const confirm = useConfirm()
  const limit = 100
  const update = (patch: Partial<WorkspaceTab>) => useApp.getState().updateTab(tab.id, patch)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current++
    }
  }, [])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, {
      pendingEdits:
        toolsPending || (!!edit && !edit.readonly && (edit.insert || edit.text !== edit.original)),
    })
  }, [edit, toolsPending, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy || writing || toolsBusy || fileBusy })
  }, [busy, writing, toolsBusy, fileBusy, tab.id])
  useEffect(() => {
    let active = true
    if (status === 'connected')
      void api
        .mongoDatabases(profile.id)
        .then((items) => {
          if (active) setDatabases(items)
        })
        .catch((e) => {
          if (active) setCatalogError(errorText(e))
        })
    return () => {
      active = false
    }
  }, [status, profile.id])
  useEffect(() => {
    let active = true
    request.current++
    setCollections([])
    setResult(undefined)
    setError('')
    setCatalogError('')
    setOffset(0)
    setSort(undefined)
    if (status === 'connected' && database)
      void api
        .mongoCollections({ connectionId: profile.id, database })
        .then((items) => {
          if (active) setCollections(items)
        })
        .catch((e) => {
          if (active) setCatalogError(errorText(e))
        })
    return () => {
      active = false
    }
  }, [status, profile.id, database])
  async function load(
    target = collection,
    page = 0,
    ordering: typeof sort | null = sort,
    resetQuery = false,
  ) {
    if (running.current || toolsBusy || toolsPending || !database || !target || status !== 'connected') return
    running.current = true
    setBusy(true)
    setError('')
    const ticket = ++request.current
    try {
      const data = await api.mongoRead({
        connectionId: profile.id,
        database,
        collection: target,
        mode: resetQuery ? 'find' : mode,
        query: resetQuery ? '{}' : query,
        offset: page,
        limit,
        sort: ordering?.column,
        direction: ordering?.direction || 'asc',
      })
      if (mounted.current && ticket === request.current) {
        setResult(data)
        setOffset(page)
        setSort(ordering || undefined)
      }
    } catch (e) {
      if (mounted.current && ticket === request.current) {
        setResult(undefined)
        setError(errorText(e))
      }
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }
  execute.current = () => {
    if (!edit) void load(collection, 0)
  }
  useEffect(() => {
    const handler = (event: Event) => {
      if (useApp.getState().workspace.activeTabId !== tab.id) return
      const action = (event as CustomEvent<string>).detail
      if (action === 'run-current') execute.current()
    }
    window.addEventListener('harbor-action', handler)
    return () => window.removeEventListener('harbor-action', handler)
  }, [tab.id])
  async function save(action: 'insert' | 'replace' | 'delete') {
    if (!edit || edit.readonly || profile.readOnly || writePending.current) return
    writePending.current = true
    const approved = await confirm({
      title:
        action === 'delete'
          ? 'Delete this document?'
          : action === 'insert'
            ? 'Insert this document?'
            : 'Replace this document?',
      description: `${profile.name} · ${database}.${collection}. This writes to the database.`,
      detail: action === 'delete' ? edit.original || '' : edit.text,
      label: action === 'delete' ? 'Delete document' : 'Apply document',
    })
    if (!approved) {
      writePending.current = false
      return
    }
    setWriting(true)
    setEditError('')
    try {
      await api.mongoWrite({
        connectionId: profile.id,
        database,
        collection,
        action,
        original: edit.original,
        document: edit.text,
      })
      setEdit(undefined)
      await load(collection, offset)
    } catch (e) {
      setEditError(errorText(e))
    } finally {
      writePending.current = false
      if (mounted.current) setWriting(false)
    }
  }
  return (
    <div className="mongo-browser">
      <div className="mongo-target-bar">
        <Database />
        <label>
          Database{' '}
          <Input
            aria-label="MongoDB database"
            list={`mongo-databases-${tab.id}`}
            value={database}
            disabled={busy || writing || fileBusy}
            onChange={(e) => update({ database: e.target.value || undefined, table: undefined })}
          />
        </label>
        <datalist id={`mongo-databases-${tab.id}`}>
          {databases.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <label>
          Collection{' '}
          <Input
            aria-label="MongoDB collection"
            value={collection}
            disabled={busy || writing || fileBusy}
            onChange={(e) => {
              update({ table: e.target.value })
              setResult(undefined)
              setSort(undefined)
              setOffset(0)
            }}
          />
        </label>
        <Button
          variant="outline"
          disabled={!database || status !== 'connected' || busy}
          onClick={() => {
            const ticket = request.current
            setCatalogError('')
            void api
              .mongoCollections({ connectionId: profile.id, database })
              .then((items) => {
                if (mounted.current && ticket === request.current) setCollections(items)
              })
              .catch((e) => {
                if (mounted.current && ticket === request.current) setCatalogError(errorText(e))
              })
          }}
        >
          <RefreshCw />
          Refresh collections
        </Button>
      </div>
      {catalogError && <ErrorPanel message={catalogError} />}
      <div className="mongo-content">
        <aside className="mongo-collections">
          <Input
            aria-label="Filter MongoDB collections"
            placeholder="Filter collections…"
            value={collectionFilter}
            onChange={(e) => setCollectionFilter(e.target.value)}
          />
          {collections
            .filter((name) => name.toLowerCase().includes(collectionFilter.toLowerCase()))
            .map((name) => (
              <button
                key={name}
                className={`object-row ${collection === name ? 'active' : ''}`}
                disabled={busy || writing || fileBusy}
                onClick={() => {
                  update({ table: name, title: name, mongoMode: 'find', sql: '{}' })
                  setResult(undefined)
                  setSort(undefined)
                  void load(name, 0, null, true)
                }}
              >
                <Database />
                <span>{name}</span>
              </button>
            ))}
          {!collections.length && (
            <p className="field-note">
              Choose a database to browse collections. You can also enter a collection name above.
            </p>
          )}
        </aside>
        <section className="mongo-workspace">
          <div className="mongo-query-toolbar">
            <MongoFileTools
              key={`${profile.id}/${database}/${collection}`}
              profile={profile}
              database={database}
              collection={collection}
              query={query}
              mode={mode}
              disabled={busy || writing || toolsBusy || status !== 'connected'}
              onBusy={setFileBusy}
              onChanged={() => void load(collection, 0)}
            />
            <MongoTools
              profile={profile}
              database={database}
              collection={collection}
              disabled={busy || writing || toolsBusy || status !== 'connected'}
              onPending={setToolsPending}
              onBusy={setToolsBusy}
            />
            <MongoPipelineBuilder
              source={mode === 'aggregate' ? query : '[]'}
              disabled={busy || writing || toolsBusy}
              onPending={setToolsPending}
              onApply={(sql) => {
                update({ mongoMode: 'aggregate', sql })
                setResult(undefined)
              }}
            />
            <select
              aria-label="MongoDB query mode"
              value={mode}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as 'find' | 'aggregate'
                update({ mongoMode: next, sql: next === 'find' ? '{}' : '[]' })
                setResult(undefined)
              }}
            >
              <option value="find">Find documents</option>
              <option value="aggregate">Aggregate (read-only)</option>
            </select>
            <span className="field-note">Extended JSON · ObjectId, dates and decimals preserved</span>
            <div className="toolbar-spacer" />
            <Button variant="ghost" onClick={onSave}>
              <Save />
              Save query
            </Button>
            <Button
              disabled={busy || !database || !collection || status !== 'connected'}
              onClick={() => void load(collection, 0)}
            >
              <Play />
              {busy ? 'Running…' : 'Run query'}
            </Button>
            <Button
              variant="outline"
              disabled={busy || profile.readOnly || !collection || !database || status !== 'connected'}
              onClick={() => {
                setEditError('')
                setEdit({ text: '{}', insert: true, readonly: false })
              }}
            >
              <Plus />
              Insert document
            </Button>
          </div>
          <textarea
            className="mongo-query mono"
            aria-label="MongoDB query"
            value={query}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => update({ sql: e.target.value })}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                void load(collection, 0)
              }
            }}
          />
          {error && <ErrorPanel message={error} />}
          {result ? (
            <>
              <DataGrid
                tab={tab}
                set={result.set}
                serverSort
                sort={sort}
                selectionDisabled={busy}
                onSort={
                  busy ? undefined : (column, direction) => void load(collection, 0, { column, direction })
                }
                onEdit={
                  busy
                    ? undefined
                    : (row) => {
                        setEditError('')
                        setEdit({
                          original: result.documents[row],
                          text: result.documents[row],
                          insert: false,
                          readonly:
                            profile.readOnly ||
                            mode === 'aggregate' ||
                            result.documents[row].length > 1000000,
                        })
                      }
                }
              />
              <div className="results-footer">
                <span>
                  {result.documents.length} documents · {result.durationMs.toFixed(1)} ms
                </span>
                <span>
                  {mode === 'aggregate'
                    ? 'Aggregation results are read-only'
                    : 'Double-click a cell to open its document'}
                </span>
                {result.truncated && <span>4 MiB preview limit reached; narrow the query.</span>}
                <div className="pagination">
                  <Button
                    variant="ghost"
                    disabled={busy || offset === 0}
                    onClick={() => void load(collection, Math.max(0, offset - limit))}
                  >
                    Previous
                  </Button>
                  <span>
                    {offset + (result.documents.length ? 1 : 0)}–{offset + result.documents.length}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={busy || !result.hasMore || result.truncated}
                    onClick={() => void load(collection, offset + limit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="center-empty">
              <Database />
              <h3>{busy ? 'Loading documents…' : 'Browse MongoDB documents'}</h3>
              <p>
                {status === 'connected'
                  ? 'Choose a database and collection, then run a JSON query.'
                  : 'Connect to this MongoDB profile to begin.'}
              </p>
            </div>
          )}
        </section>
      </div>
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open && !writing) setEdit(undefined)
        }}
      >
        <DialogContent className="mongo-document-dialog">
          <DialogHeader>
            <DialogTitle>
              {edit?.insert ? 'Insert document' : edit?.readonly ? 'View document' : 'Edit document'}
            </DialogTitle>
            <DialogDescription>
              {database}.{collection} · Extended JSON. Keep the original _id when editing. Documents over
              1,000,000 characters are view-only.
            </DialogDescription>
          </DialogHeader>
          <textarea
            aria-label="MongoDB document"
            className="mono"
            rows={16}
            spellCheck={false}
            value={edit?.text || ''}
            readOnly={edit?.readonly || writing}
            onChange={(e) => {
              if (edit) setEdit({ ...edit, text: e.target.value })
            }}
          />
          {editError && <ErrorPanel message={editError} />}
          <div className="dialog-actions">
            <Button variant="outline" disabled={writing} onClick={() => setEdit(undefined)}>
              Close
            </Button>
            {edit && !edit.readonly && (
              <>
                <Button disabled={writing} onClick={() => void save(edit.insert ? 'insert' : 'replace')}>
                  {writing ? 'Saving…' : 'Save document'}
                </Button>
                {!edit.insert && (
                  <Button variant="destructive" disabled={writing} onClick={() => void save('delete')}>
                    <Trash2 />
                    Delete document
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
