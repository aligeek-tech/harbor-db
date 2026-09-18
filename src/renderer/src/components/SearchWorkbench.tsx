import { useEffect, useRef, useState } from 'react'
import { Copy, Database, Play, Plus, RefreshCw, Save, Square, Trash2 } from 'lucide-react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import {
  searchMutationConfirmation,
  type SearchCatalog,
  type SearchHit,
  type SearchMapping,
  type SearchMutationInput,
  type SearchResult,
} from '@shared/search'
import { api } from '../lib/api'
import { engineNames, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel, useConfirm } from './common'
import './SearchWorkbench.css'

type DocumentDraft = {
  index: string
  id: string
  routing: string
  text: string
  original?: SearchHit
  create: boolean
  stale?: boolean
}
type Page = { data: SearchResult; index: string; dsl: string; pageSize: number; number: number }

/** JSON text crosses IPC intact: never decode/re-encode document numeric values in the renderer. */
export function SearchWorkbench({
  tab,
  profile,
  onSave,
}: {
  tab: WorkspaceTab
  profile: ConnectionProfile
  onSave: () => void
}) {
  const connected = useApp((state) => state.statuses[profile.id]?.state === 'connected')
  const [catalog, setCatalog] = useState<SearchCatalog>()
  const [mapping, setMapping] = useState<SearchMapping>()
  const [page, setPage] = useState<Page>()
  const [draft, setDraft] = useState<DocumentDraft>()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editError, setEditError] = useState('')
  const mounted = useRef(true)
  const pending = useRef(false)
  const requestId = useRef<string | undefined>(undefined)
  const runAction = useRef<() => void>(() => {})
  const confirm = useConfirm()
  const index = tab.searchIndex || ''
  const pageSize = tab.searchPageSize ?? 200
  const dirty = !!draft && (draft.create || draft.text !== draft.original?.sourceJson)
  const canContinue =
    !!page?.data.nextCursor && page.index === index && page.dsl === tab.sql && page.pageSize === pageSize
  const update = (patch: Partial<WorkspaceTab>) => useApp.getState().updateTab(tab.id, patch)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void api.closeSession({ connectionId: profile.id, sessionId: tab.id }).catch(() => {})
    }
  }, [profile.id, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: !!busy, pendingEdits: dirty })
  }, [busy, dirty, tab.id])
  async function perform(label: string, action: () => Promise<void>, cancellable = false) {
    if (pending.current) return
    pending.current = true
    setBusy(label)
    setError('')
    setNotice('')
    requestId.current = cancellable ? crypto.randomUUID() : undefined
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      requestId.current = undefined
      pending.current = false
      if (mounted.current) setBusy('')
    }
  }
  async function search(next = false) {
    if (!connected || !index || draft) return
    const prior = next ? page : undefined
    if (next && !canContinue) return
    await perform(
      'Searching',
      async () => {
        const data = await api.searchRead({
          connectionId: profile.id,
          sessionId: tab.id,
          requestId: requestId.current!,
          index,
          dsl: tab.sql,
          pageSize,
          ...(prior?.data.nextCursor ? { cursor: prior.data.nextCursor } : {}),
        })
        if (mounted.current)
          setPage({ data, index, dsl: tab.sql, pageSize, number: prior ? prior.number + 1 : 1 })
      },
      true,
    )
  }
  runAction.current = () => {
    void search()
  }
  useEffect(() => {
    const listener = (event: Event) => {
      if (
        useApp.getState().workspace.activeTabId === tab.id &&
        (event as CustomEvent<string>).detail === 'run-current'
      )
        runAction.current()
    }
    window.addEventListener('harbor-action', listener)
    return () => window.removeEventListener('harbor-action', listener)
  }, [tab.id])
  async function stopWaiting() {
    const id = requestId.current
    if (!id) return
    try {
      const result = await api.searchCancel({ connectionId: profile.id, sessionId: tab.id, requestId: id })
      if (mounted.current) setNotice(result.message)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    }
  }
  async function openDocument(hit: SearchHit) {
    await perform('Loading document', async () => {
      const current = await api.searchDocument({
        connectionId: profile.id,
        index: hit.index,
        id: hit.id,
        ...(hit.routing ? { routing: hit.routing } : {}),
      })
      if (mounted.current) {
        setEditError('')
        setDraft({
          index: current.index,
          id: current.id,
          routing: current.routing || hit.routing || '',
          text: current.sourceJson,
          original: current,
          create: false,
        })
      }
    })
  }
  async function dismissDocument() {
    if (pending.current) return
    if (
      dirty &&
      !(await confirm({
        title: 'Discard document draft?',
        description: 'The unsubmitted document text is held only in this tab. Closing discards it.',
        label: 'Discard draft',
        danger: true,
      }))
    )
      return
    setDraft(undefined)
    setEditError('')
  }
  async function mutate(operation: SearchMutationInput['operation']) {
    if (!draft || pending.current || profile.readOnly || draft.stale || !connected) return
    pending.current = true
    const target = { operation, index: draft.index, id: draft.id }
    const phrase = searchMutationConfirmation(target, profile)
    const approved = await confirm({
      title: `Review ${operation} document`,
      description: `${engineNames[profile.engine]} · ${profile.name} · ${draft.index}/${draft.id}${draft.routing ? ` · routing ${draft.routing}` : ''}. ${operation === 'create' ? 'Create only; an existing ID will not be overwritten.' : `Observed sequence ${draft.original?.seqNo}, primary term ${draft.original?.primaryTerm}. A concurrent change will be rejected.`} This changes one live document. There is no multi-document transaction.`,
      detail: operation === 'delete' ? draft.original?.sourceJson : draft.text,
      typed: phrase,
      label: operation === 'delete' ? 'Delete document' : 'Apply document',
      danger: true,
    })
    pending.current = false
    if (!approved || !mounted.current) return
    await perform(
      'Writing document',
      async () => {
        try {
          const result = await api.searchMutate({
            connectionId: profile.id,
            sessionId: tab.id,
            requestId: requestId.current!,
            ...target,
            ...(draft.routing ? { routing: draft.routing } : {}),
            ...(operation !== 'delete' ? { document: draft.text } : {}),
            ...(operation !== 'create'
              ? { seqNo: draft.original?.seqNo, primaryTerm: draft.original?.primaryTerm }
              : {}),
            confirm: phrase,
          })
          if (mounted.current) {
            setDraft(undefined)
            setNotice(
              `${result.result}: ${result.index}/${result.id}. ${result.warnings.join(' ')} Displayed search pages remain snapshots; run Search to refresh.`,
            )
          }
        } catch (cause) {
          if (mounted.current) {
            setEditError(errorText(cause))
            setDraft((current) => (current ? { ...current, stale: true } : current))
          }
        }
      },
      true,
    )
  }
  return (
    <div className="search-workbench" aria-label={`${engineNames[profile.engine]} search workspace`}>
      <div className="search-controls">
        <label>
          Index or pattern
          <Input
            aria-label="Search index or pattern"
            list={`search-indices-${tab.id}`}
            value={index}
            disabled={!!busy || !!draft}
            onChange={(event) => update({ searchIndex: event.target.value })}
            placeholder="orders-*"
            maxLength={255}
          />
        </label>
        <datalist id={`search-indices-${tab.id}`}>
          {catalog?.indices.map((item) => (
            <option key={item.name} value={item.name} />
          ))}
        </datalist>
        <label>
          Hits per page
          <Input
            aria-label="Search hits per page"
            type="number"
            min={0}
            max={1000}
            value={pageSize}
            disabled={!!busy || !!draft}
            onChange={(event) =>
              update({
                searchPageSize: Math.min(1000, Math.max(0, Math.trunc(Number(event.target.value) || 0))),
              })
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={!!busy || !connected}
          onClick={() =>
            void perform('Loading indices', async () => {
              const result = await api.searchCatalog({ connectionId: profile.id })
              if (mounted.current) setCatalog(result)
            })
          }
        >
          <Database />
          Load indices
        </Button>
        <Button
          variant="outline"
          disabled={!!busy || !connected || !index}
          onClick={() =>
            void perform('Loading mappings', async () => {
              const result = await api.searchMappings({ connectionId: profile.id, index })
              if (mounted.current) setMapping(result)
            })
          }
        >
          Mappings & aliases
        </Button>
      </div>
      <p className="field-note search-scope">
        {engineNames[profile.engine]} · {profile.name} · {profile.environment} ·{' '}
        {profile.readOnly ? 'Read-only safeguard' : 'Document writes enabled'}. Metadata loads and searches
        run only when requested. Page size 0 returns aggregations only.
      </p>
      <div className="search-body">
        {catalog && (
          <aside className="search-catalog" aria-label="Search indices">
            <strong>
              {catalog.version} · {catalog.health?.status || 'Health unavailable'}
            </strong>
            <Input
              aria-label="Filter loaded indices"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter loaded indices"
            />
            {catalog.warnings.map((warning) => (
              <p className="field-note" key={warning}>
                {warning}
              </p>
            ))}
            {catalog.indices
              .filter(
                (item) => item.name.includes(filter) || item.aliases.some((alias) => alias.includes(filter)),
              )
              .map((item) => (
                <button
                  className="search-index"
                  key={item.name}
                  disabled={!!busy || !!draft}
                  onClick={() => update({ searchIndex: item.name })}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.documents} indexed docs · {item.health} · {item.status}
                  </span>
                  {item.aliases.length > 0 && <span>Aliases: {item.aliases.join(', ')}</span>}
                </button>
              ))}
            <p className="field-note">
              Counts are index metadata, not query totals. Selecting an index does not execute a search.
            </p>
          </aside>
        )}
        <div className="search-main">
          <label className="search-dsl-label" htmlFor={`dsl-${tab.id}`}>
            Search JSON DSL
          </label>
          <textarea
            id={`dsl-${tab.id}`}
            className="search-json-editor"
            spellCheck={false}
            value={tab.sql}
            maxLength={1000000}
            disabled={!!busy || !!draft}
            onChange={(event) => update({ sql: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void search()
              }
            }}
          />
          <div className="search-actions">
            <Button disabled={!!busy || !connected || !index || !!draft} onClick={() => void search()}>
              <Play />
              Search
            </Button>
            <Button variant="outline" disabled={!requestId.current} onClick={() => void stopWaiting()}>
              <Square />
              Stop waiting
            </Button>
            <Button variant="outline" disabled={!!busy} onClick={onSave}>
              <Save />
              Save DSL
            </Button>
            <Button
              variant="outline"
              disabled={!!busy || !connected || profile.readOnly || !index}
              onClick={() => {
                setEditError('')
                setDraft({ index, id: '', routing: '', text: '{}', create: true })
              }}
            >
              <Plus />
              Create document
            </Button>
            {busy && <span role="status">{busy}…</span>}
          </div>
          <p className="field-note">
            Up to 1,000 hits and 8 MiB per response. Forward pages use a short-lived point-in-time snapshot.
            Stop waiting closes the HTTP request; server cancellation is not confirmed.
          </p>
          {error && <ErrorPanel message={error} />}
          {notice && (
            <p role="status" className="search-notice">
              {notice}
            </p>
          )}
          {page && (
            <section className="search-results" aria-label="Search results">
              <div className="search-result-heading">
                <strong>
                  Page {page.number} · {page.data.hits.length} loaded hits ·{' '}
                  {page.data.total.relation === 'gte'
                    ? 'at least '
                    : page.data.total.relation === 'unknown'
                      ? 'unknown total; reported '
                      : ''}
                  {page.data.total.value} total · {page.data.tookMs} ms on server
                </strong>
                <Button
                  variant="outline"
                  disabled={!!busy || !connected || !canContinue || !!draft}
                  onClick={() => void search(true)}
                >
                  Next page
                </Button>
                {page.data.nextCursor && (
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() =>
                      void perform('Closing snapshot', async () => {
                        await api.searchCloseCursor({
                          connectionId: profile.id,
                          sessionId: tab.id,
                          cursor: page.data.nextCursor!,
                        })
                        if (mounted.current)
                          setPage({ ...page, data: { ...page.data, nextCursor: undefined } })
                      })
                    }
                  >
                    Close snapshot
                  </Button>
                )}
              </div>
              <p className="field-note">
                Result target: {page.index}.{' '}
                {page.data.cursorExpiresAt
                  ? `Continue before ${new Date(page.data.cursorExpiresAt).toLocaleTimeString()}.`
                  : 'No further snapshot page.'}{' '}
                {page.index !== index || page.dsl !== tab.sql || page.pageSize !== pageSize
                  ? 'Draft changed; these results belong to the preceding search. Run Search to apply it.'
                  : ''}
              </p>
              {page.data.partial && (
                <p role="alert" className="search-warning">
                  Partial result: {page.data.timedOut ? 'server timed out; ' : ''}
                  {page.data.shardFailures} failed shards. No complete-result claim or continuation.
                </p>
              )}
              {page.data.warnings.map((warning) => (
                <p className="field-note" key={warning}>
                  {warning}
                </p>
              ))}
              {page.data.aggregationsJson && (
                <details open className="search-aggregations">
                  <summary>Query aggregations (all matching documents, not this page)</summary>
                  <pre aria-label="Search aggregation JSON">{page.data.aggregationsJson}</pre>
                </details>
              )}
              <div className="search-hits">
                {page.data.hits.map((hit) => (
                  <button
                    className="search-hit"
                    key={`${hit.index}/${hit.id}/${hit.routing || ''}`}
                    disabled={!!busy || !connected}
                    onClick={() => void openDocument(hit)}
                    aria-label={`Open document ${hit.index}/${hit.id}`}
                  >
                    <strong>
                      {hit.index} / {hit.id}
                    </strong>
                    <span>
                      Score {hit.score ?? 'none'}
                      {hit.routing ? ` · routing ${hit.routing}` : ''}
                    </span>
                    <code>
                      {hit.sourceJson.slice(0, 1200)}
                      {hit.sourceJson.length > 1200 ? '…' : ''}
                    </code>
                  </button>
                ))}
              </div>
              {!page.data.hits.length && (
                <p className="field-note">
                  No hits on this page. Aggregation-only requests intentionally load no documents.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
      {mapping && (
        <Dialog open onOpenChange={(open) => !open && setMapping(undefined)}>
          <DialogContent className="search-detail-dialog">
            <DialogHeader>
              <DialogTitle>Mappings & aliases · {mapping.index}</DialogTitle>
              <DialogDescription>
                Engine-native metadata for the selected target. No document query was executed.
              </DialogDescription>
            </DialogHeader>
            {mapping.warnings.map((warning) => (
              <p className="field-note" key={warning}>
                {warning}
              </p>
            ))}
            <h3>Mappings</h3>
            <pre aria-label="Index mapping JSON">{mapping.mappingsJson}</pre>
            <h3>Aliases</h3>
            <pre aria-label="Index alias JSON">{mapping.aliasesJson}</pre>
            <Button variant="outline" onClick={() => setMapping(undefined)}>
              Close mappings
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {draft && (
        <Dialog open onOpenChange={(open) => !open && void dismissDocument()}>
          <DialogContent className="search-detail-dialog">
            <DialogHeader>
              <DialogTitle>
                {draft.create ? 'Create document' : 'Live document'} · {draft.index}
              </DialogTitle>
              <DialogDescription>
                {profile.name} · {profile.environment}. Document text is temporary and is not saved in
                workspace drafts. Numeric tokens remain exact JSON text.
              </DialogDescription>
            </DialogHeader>
            <div className="search-controls">
              <label>
                Document ID
                <Input
                  aria-label="Search document ID"
                  value={draft.id}
                  disabled={!draft.create || !!busy}
                  onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                  maxLength={512}
                />
              </label>
              <label>
                Routing (optional)
                <Input
                  aria-label="Search document routing"
                  value={draft.routing}
                  disabled={!draft.create || !!busy}
                  onChange={(event) => setDraft({ ...draft, routing: event.target.value })}
                  maxLength={512}
                />
              </label>
            </div>
            {draft.original && (
              <p className="field-note">
                Sequence {draft.original.seqNo ?? 'unavailable'} · primary term{' '}
                {draft.original.primaryTerm ?? 'unavailable'}. Replace writes the entire document source, not
                a field patch.
              </p>
            )}
            <label htmlFor={`doc-${tab.id}`}>Document JSON</label>
            <textarea
              id={`doc-${tab.id}`}
              className="search-json-editor search-document-editor"
              aria-label="Search document JSON"
              spellCheck={false}
              value={draft.text}
              maxLength={1000000}
              readOnly={profile.readOnly || !!busy || draft.original?.sourceJson === 'null'}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            {draft.original?.sourceJson === 'null' && (
              <p className="field-note">This index has no available source. Replacement is disabled.</p>
            )}
            {editError && <ErrorPanel message={editError} />}
            {draft.stale && (
              <p role="alert" className="search-warning">
                The previous write was rejected or has an uncertain outcome. Inspect and reload this exact
                document before another review. The draft remains available to copy.
              </p>
            )}
            <div className="search-actions">
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void api.copyText(draft.text).catch((cause) => setEditError(errorText(cause)))}
              >
                <Copy />
                Copy JSON
              </Button>
              {!draft.create && (
                <Button
                  variant="outline"
                  disabled={!!busy || !connected}
                  onClick={async () => {
                    if (
                      dirty &&
                      !(await confirm({
                        title: 'Reload and discard document draft?',
                        description:
                          'The latest document replaces this unsubmitted text. Copy it first if needed.',
                        label: 'Reload document',
                        danger: true,
                      }))
                    )
                      return
                    await openDocument(draft.original!)
                  }}
                >
                  <RefreshCw />
                  Reload document
                </Button>
              )}
              <Button
                disabled={
                  !!busy ||
                  !connected ||
                  profile.readOnly ||
                  !draft.id ||
                  draft.stale ||
                  (!draft.create &&
                    (!dirty ||
                      !draft.original?.seqNo ||
                      !draft.original?.primaryTerm ||
                      draft.original.sourceJson === 'null'))
                }
                onClick={() => void mutate(draft.create ? 'create' : 'replace')}
              >
                Review {draft.create ? 'create' : 'replacement'}
              </Button>
              {!draft.create && (
                <Button
                  variant="destructive"
                  disabled={
                    !!busy ||
                    !connected ||
                    profile.readOnly ||
                    draft.stale ||
                    !draft.original?.seqNo ||
                    !draft.original?.primaryTerm
                  }
                  onClick={() => void mutate('delete')}
                >
                  <Trash2 />
                  Review delete
                </Button>
              )}
              <Button variant="ghost" disabled={!!busy} onClick={() => void dismissDocument()}>
                Close document
              </Button>
            </div>
            {draft.create && draft.stale && (
              <p className="field-note">
                Close this draft, search for the exact ID, and reload it before deciding whether a fresh
                create is appropriate.
              </p>
            )}
            {busy === 'Writing document' && (
              <Button variant="outline" onClick={() => void stopWaiting()}>
                Stop waiting for write (outcome may be uncertain)
              </Button>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
