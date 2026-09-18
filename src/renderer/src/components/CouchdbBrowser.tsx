import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import { couchConfirmation, type CouchDocument, type CouchPage } from '@shared/couchdb'
import { api } from '../lib/api'
import { useApp } from '../store'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ErrorPanel } from './common'
export function CouchdbBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const [database, setDatabase] = useState(tab.database || profile.database),
    [databases, setDatabases] = useState<string[]>([]),
    [selector, setSelector] = useState('{"_id":{"$gt":null}}'),
    [allowScan, setAllowScan] = useState(false),
    [index, setIndex] = useState(''),
    [pageSize, setPageSize] = useState(25),
    [page, setPage] = useState<CouchPage>(),
    [selected, setSelected] = useState<CouchDocument>(),
    [source, setSource] = useState(''),
    [documentId, setDocumentId] = useState(''),
    [action, setAction] = useState<'create' | 'replace' | 'delete'>('replace'),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const request = useRef<string | undefined>(undefined),
    mounted = useRef(true)
  const dirty = selected
    ? source !== selected.source
    : action === 'create' && (!!documentId || source !== '{"_id":""}')
  useEffect(() => {
    mounted.current = true
    void api
      .couchDatabases(profile.id)
      .then(setDatabases)
      .catch((e) => setError(errorText(e)))
    return () => {
      mounted.current = false
      if (request.current)
        void api.couchCancel({ connectionId: profile.id, sessionId: tab.id, requestId: request.current })
      void api.closeSession({ connectionId: profile.id, sessionId: tab.id }).catch(() => {})
    }
  }, [profile.id, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy, pendingEdits: dirty })
    return () => useApp.getState().setRuntime(tab.id, { running: false, pendingEdits: false })
  }, [tab.id, busy, dirty])
  const invoke = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      request.current = undefined
      if (mounted.current) setBusy(false)
    }
  }
  const query = (cursor?: string) =>
    void invoke(async () => {
      const requestId = crypto.randomUUID()
      request.current = requestId
      const result = await api.couchRead({
        connectionId: profile.id,
        database,
        sessionId: tab.id,
        requestId,
        selector,
        pageSize,
        allowScan,
        index: index || undefined,
        cursor,
      })
      if (mounted.current) {
        setPage(result)
        setSelected(undefined)
        setSource('')
        setConfirm('')
      }
    })
  const choose = (document: CouchDocument) => {
    setSelected(document)
    setDocumentId(document.id)
    setSource(document.source)
    setAction('replace')
    setConfirm('')
    setError('')
  }
  const target = {
    connectionId: profile.id,
    database,
    id: documentId,
    action,
    revision: action === 'create' ? undefined : selected?.revision,
  }
  const confirmation = couchConfirmation(target)
  const constrained = !!selected && (selected.conflicts.length > 0 || selected.attachmentNames.length > 0)
  return (
    <div className="mongo-workspace" style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <h2>CouchDB documents</h2>
      <p>
        {profile.name} · {profile.host}:{profile.port} · {profile.environment} ·{' '}
        {profile.readOnly ? 'Read-only safeguard' : 'Writes enabled'}
      </p>
      <p>
        Queries run only when requested. Pages use CouchDB bookmarks, not a snapshot. Concurrent changes can
        affect later pages. Cancel stops waiting; server completion is not confirmed.
      </p>
      <div className="flex flex-wrap gap-3">
        <label>
          Database
          <Input
            aria-label="CouchDB database"
            list={'couch-databases-' + tab.id}
            value={database}
            disabled={busy || dirty}
            onChange={(e) => {
              setDatabase(e.target.value)
              setPage(undefined)
              setSelected(undefined)
              setSource('')
              setConfirm('')
            }}
          />
        </label>
        <datalist id={'couch-databases-' + tab.id}>
          {databases.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <label>
          Page size
          <Input
            aria-label="CouchDB page size"
            type="number"
            min={1}
            max={100}
            value={pageSize}
            disabled={busy}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(undefined)
            }}
          />
        </label>
        <label>
          Index (optional)
          <Input
            aria-label="CouchDB index"
            value={index}
            disabled={busy}
            onChange={(e) => {
              setIndex(e.target.value)
              setPage(undefined)
            }}
          />
        </label>
      </div>
      <label className="block">
        Mango selector
        <textarea
          aria-label="CouchDB Mango selector"
          className="w-full font-mono"
          rows={4}
          value={selector}
          disabled={busy}
          onChange={(e) => {
            setSelector(e.target.value)
            setPage(undefined)
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={allowScan}
          disabled={busy}
          onChange={(e) => {
            setAllowScan(e.target.checked)
            setPage(undefined)
          }}
        />{' '}
        Allow index fallback and potentially expensive document scanning for this query
      </label>
      <div className="flex gap-2">
        <Button
          disabled={busy || dirty || !database || pageSize < 1 || pageSize > 100}
          onClick={() => query()}
        >
          Run selector
        </Button>
        <Button
          variant="outline"
          disabled={busy || dirty || !page?.cursor}
          onClick={() => query(page?.cursor)}
        >
          Next page
        </Button>
        {busy && request.current && (
          <Button
            onClick={() =>
              void api.couchCancel({
                connectionId: profile.id,
                sessionId: tab.id,
                requestId: request.current!,
              })
            }
          >
            Cancel CouchDB query
          </Button>
        )}
      </div>
      {error && <ErrorPanel message={error} />} {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <p role="status">
            {page.documents.length} documents · {page.durationMs} ms · examined{' '}
            {page.examined || 'unavailable'} · {page.cursor ? 'another page may exist' : 'end of results'}
          </p>
          {page.warning && <p role="alert">{page.warning}</p>}
          <div className="flex flex-col gap-1" aria-label="CouchDB result documents">
            {page.documents.map((doc) => (
              <Button variant="outline" key={doc.id} disabled={busy || dirty} onClick={() => choose(doc)}>
                {doc.id} · {doc.revision}{' '}
                {doc.conflicts.length ? `· ${doc.conflicts.length} sibling conflicts` : ''}
              </Button>
            ))}
          </div>
        </>
      )}
      <div className="mt-4">
        <Button
          variant="outline"
          disabled={profile.readOnly || busy || dirty || !database}
          onClick={() => {
            setSelected(undefined)
            setDocumentId('')
            setSource('{"_id":""}')
            setAction('create')
            setConfirm('')
          }}
        >
          New document
        </Button>
      </div>
      {(selected || action === 'create') && (
        <section aria-label="CouchDB document inspector">
          <h3>{selected ? 'Revision-aware document editor' : 'Create document'}</h3>
          {selected && (
            <p>
              Revision: {selected.revision} · Conflicts: {selected.conflicts.join(', ') || 'none'} ·
              Attachments: {selected.attachmentNames.join(', ') || 'none'}
            </p>
          )}
          {constrained && (
            <p role="alert">
              Sibling conflicts and attachments are shown explicitly. Resolve them outside this ordinary
              editor before replacing this document.
            </p>
          )}
          <label>
            Document ID
            <Input
              aria-label="CouchDB document ID"
              value={documentId}
              disabled={!!selected || busy}
              onChange={(e) => setDocumentId(e.target.value)}
            />
          </label>
          <label>
            JSON document
            <textarea
              aria-label="CouchDB JSON document"
              className="w-full font-mono"
              rows={12}
              value={source}
              readOnly={profile.readOnly || busy || constrained}
              onChange={(e) => {
                setSource(e.target.value)
                setConfirm('')
              }}
            />
          </label>
          {selected && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setSource(selected.source)
                  setConfirm('')
                }}
              >
                Discard document draft
              </Button>
              <Button
                variant="outline"
                disabled={busy || dirty}
                onClick={() =>
                  void invoke(async () =>
                    choose(await api.couchDocument({ connectionId: profile.id, database, id: selected.id })),
                  )
                }
              >
                Reload current revision
              </Button>
            </>
          )}
          {action === 'create' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setSelected(undefined)
                setSource('')
                setDocumentId('')
                setAction('replace')
                setConfirm('')
              }}
            >
              Discard new document
            </Button>
          )}
          {!profile.readOnly && (
            <>
              <label>
                Document action
                <select
                  aria-label="CouchDB document action"
                  value={action}
                  disabled={busy}
                  onChange={(e) => {
                    setAction(e.target.value as typeof action)
                    setConfirm('')
                  }}
                >
                  {selected ? (
                    <>
                      <option value="replace">Replace reviewed revision</option>
                      <option value="delete">Delete reviewed revision</option>
                    </>
                  ) : (
                    <option value="create">Create new document</option>
                  )}
                </select>
              </label>
              <p>
                Writes commit individually. A stale revision is rejected; no automatic retry or rollback is
                performed. Delete removes the reviewed revision and may expose a sibling conflict.
              </p>
              <p>
                Type: <code>{confirmation}</code>
              </p>
              <Input
                aria-label="Confirm CouchDB mutation"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <Button
                disabled={
                  busy || !documentId || confirm !== confirmation || (action === 'replace' && constrained)
                }
                onClick={() =>
                  void invoke(async () => {
                    await api.couchMutate({
                      ...target,
                      source: action === 'delete' ? undefined : source,
                      confirm,
                    })
                    setNotice('Document mutation acknowledged. Run the selector again to refresh the list.')
                    setConfirm('')
                    setPage(undefined)
                    if (action === 'delete') {
                      setSelected(undefined)
                      setSource('')
                      setAction('replace')
                    } else
                      choose(await api.couchDocument({ connectionId: profile.id, database, id: documentId }))
                  })
                }
              >
                Apply reviewed document mutation
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  )
}
