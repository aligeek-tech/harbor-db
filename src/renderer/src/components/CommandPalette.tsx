import { isKeyValueEngine } from '@shared/key-value'
import { isLocalEngine, localDatabasePath } from '@shared/local-database'
import type { QueryDraft } from '@shared/query-target'
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Download,
  FileCode2,
  FolderOpen,
  LockKeyhole,
  Moon,
  Plus,
  Search,
  Settings2,
  Table2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, ObjectInfo } from '@shared/contracts'
import { useApp } from '../store'
import { errorText, cn } from '../lib/utils'
import { shortcutHint } from '../lib/shortcuts'
import { api } from '../lib/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { EngineIcon } from './common'

interface PaletteProps {
  onClose: () => void
  onAction: (action: string) => void
  onConnect: (profile: ConnectionProfile) => Promise<void>
  onOpenQuery: (query: QueryDraft) => void
  onOpenObject: (profile: ConnectionProfile, object: ObjectInfo) => void
}
interface Item {
  id: string
  label: string
  detail: string
  keywords: string
  icon: ReactNode
  choose: () => void
  category?: 'actions' | 'connections' | 'queries' | 'objects'
  connectionId?: string
  keepOpen?: boolean
}
const actions = [
  {
    id: 'new-connection',
    label: 'Add a connection',
    detail: 'Action',
    icon: Plus,
    keywords: 'postgres postgresql mariadb redis database server',
  },
  {
    id: 'new-query',
    label: 'New query tab',
    detail: shortcutHint('new-query'),
    icon: FileCode2,
    keywords: 'sql editor command console',
  },
  {
    id: 'settings',
    label: 'Open settings',
    detail: 'Action',
    icon: Settings2,
    keywords: 'appearance density zoom password history privacy retention',
  },
  {
    id: 'import-sql',
    label: 'Open SQL file',
    detail: 'Open without executing',
    icon: FolderOpen,
    keywords: 'import query script',
  },
  {
    id: 'import-connections',
    label: 'Import connection metadata',
    detail: 'Preview before adding',
    icon: Upload,
    keywords: 'profiles restore json',
  },
  {
    id: 'export-connections',
    label: 'Export connection metadata',
    detail: 'Passwords excluded',
    icon: Download,
    keywords: 'profiles backup json',
  },
  {
    id: 'toggle-theme',
    label: 'Switch light / dark theme',
    detail: 'Appearance',
    icon: Moon,
    keywords: 'system color appearance',
  },
  {
    id: 'private-session',
    label: 'Manage private session',
    detail: 'Workspace privacy',
    icon: LockKeyhole,
    keywords: 'drafts history sensitive values',
  },
]

export function CommandPalette({ onClose, onAction, onConnect, onOpenQuery, onOpenObject }: PaletteProps) {
  const profiles = useApp((state) => state.profiles)
  const savedQueries = useApp((state) => state.savedQueries)
  const objects = useApp((state) => state.objects)
  const statuses = useApp((state) => state.statuses)
  const [search, setSearch] = useState('')
  const term = useDeferredValue(search.trim().toLowerCase())
  const [highlighted, setHighlighted] = useState(0)
  const [scope, setScope] = useState<'all' | 'actions' | 'connections' | 'queries' | 'objects'>('all')
  const [targetId, setTargetId] = useState('')
  const [database, setDatabase] = useState('')
  const [catalog, setCatalog] = useState<Item[]>([])
  const [catalogObjects, setCatalogObjects] = useState<ObjectInfo[]>([])
  const [tableIndex, setTableIndex] = useState('')
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogMessage, setCatalogMessage] = useState('')
  const [inspection, setInspection] = useState('')
  const epoch = useRef(0)
  const target = profiles.find((profile) => profile.id === targetId)
  const canLoad =
    !!target &&
    statuses[target.id]?.state === 'connected' &&
    !isKeyValueEngine(target.engine) &&
    !target.id.startsWith('demo-') &&
    !!(database || target.database || isLocalEngine(target.engine) || ['elasticsearch','opensearch'].includes(target.engine))
  useEffect(
    () => () => {
      epoch.current++
    },
    [],
  )
  function changeTarget(id: string) {
    epoch.current++
    setTargetId(id)
    setDatabase('')
    setCatalog([])
    setCatalogObjects([])
    setTableIndex('')
    setCatalogBusy(false)
    setCatalogMessage('')
    setInspection('')
  }
  async function loadCatalog(indexes = false) {
    if (!target || !canLoad || catalogBusy) return
    const ticket = ++epoch.current
    const namespace = isLocalEngine(target.engine) ? 'main' : database || target.database
    const current = () =>
      epoch.current === ticket &&
      useApp.getState().statuses[target.id]?.state === 'connected' &&
      useApp
        .getState()
        .profiles.some(
          (profile) => profile.id === target.id && JSON.stringify(profile) === JSON.stringify(target),
        )
    setCatalogBusy(true)
    setCatalogMessage('')
    try {
      let items: Item[]
      if (indexes) {
        const object = catalogObjects[Number(tableIndex)]
        if (!object) return
        const structure = await api.structure({
          connectionId: target.id,
          database: object.database,
          schema: object.schema,
          table: object.name,
        })
        items = structure.indexes.map((index) => ({
          id: `index:${target.id}:${namespace}:${object.schema}:${object.name}:${index.name}`,
          label: index.name,
          detail: `${target.name} · ${namespace} · ${object.schema}.${object.name} · index`,
          keywords: index.definition,
          icon: <Table2 />,
          category: 'objects',
          connectionId: target.id,
          keepOpen: true,
          choose: () =>
            setInspection(
              `${target.name} · ${namespace} · ${object.schema}.${object.name}\n${index.definition}`,
            ),
        }))
      } else if (target.engine === 'elasticsearch' || target.engine === 'opensearch') {
        const snapshot = await api.searchCatalog({ connectionId: target.id })
        items = snapshot.indices.slice(0,1000).map((index) => ({
          id: `search:${target.id}:${index.name}`, label:index.name,
          detail:`${target.name} · ${snapshot.engine} index · ${index.documents} documents`,
          keywords:index.aliases.join(' '),icon:<Table2 />,category:'objects',connectionId:target.id,
          choose:()=>onOpenQuery({name:index.name,sql:'{"query":{"match_all":{}}}',engine:target.engine,connectionId:target.id,searchIndex:index.name,searchPageSize:200}),
        }))
      } else if (target.engine === 'mongodb') {
        const collections = await api.mongoCollections({ connectionId: target.id, database: namespace })
        items = collections.slice(0, 1000).map((collection) => ({
          id: `collection:${target.id}:${namespace}:${collection}`,
          label: collection,
          detail: `${target.name} · ${namespace} · collection`,
          keywords: 'mongodb',
          icon: <Table2 />,
          category: 'objects',
          connectionId: target.id,
          choose: () =>
            onOpenQuery({
              name: collection,
              sql: '{}',
              engine: target.engine,
              connectionId: target.id,
              database: namespace,
              collection,
              mongoMode: 'find',
            }),
        }))
      } else {
        const objects = await api.listObjects({
          connectionId: target.id,
          ...(['postgres', 'mssql', 'clickhouse'].includes(target.engine)
            ? { database: namespace }
            : { schema: namespace }),
        })
        const bounded = objects
          .slice(0, 1000)
          .map((object) => ({
            ...object,
            ...(['postgres', 'mssql', 'clickhouse'].includes(target.engine) ? { database: namespace } : {}),
          }))
        if (!current()) return
        setCatalogObjects(
          bounded.filter((object) => ['table', 'view', 'materialized view'].includes(object.kind)),
        )
        setTableIndex('')
        items = bounded.map((object) => ({
          id: `catalog:${target.id}:${namespace}:${object.kind}:${object.schema}:${object.name}`,
          label: `${object.schema}.${object.name}`,
          detail: `${target.name} · ${namespace} · ${object.kind}`,
          keywords: target.engine,
          icon: <Table2 />,
          category: 'objects',
          connectionId: target.id,
          keepOpen: !['table', 'view', 'materialized view'].includes(object.kind),
          choose: () =>
            ['table', 'view', 'materialized view'].includes(object.kind)
              ? onOpenObject(target, object)
              : setInspection(
                  `${target.name} · ${namespace} · ${object.schema}.${object.name} · ${object.kind}\nOpen this object in the explorer for engine-specific inspection.`,
                ),
        }))
      }
      if (!current()) return
      setCatalog((previous) =>
        indexes ? [...previous.filter((item) => !item.id.startsWith('index:')), ...items] : items,
      )
      setCatalogMessage(
        `${items.length} ${indexes ? 'indexes' : 'catalog objects'} loaded for ${target.name} / ${namespace}${items.length === 1000 ? ' (first 1,000; refine the database scope)' : ''}. No row data was read.`,
      )
    } catch (error) {
      if (epoch.current === ticket) setCatalogMessage(errorText(error))
    } finally {
      if (epoch.current === ticket) setCatalogBusy(false)
    }
  }
  const listId = useId()
  const items = useMemo(() => {
    const all: Item[] = actions.map((action) => ({
      id: action.id,
      label: action.label,
      detail: action.detail,
      keywords: action.keywords,
      icon: <action.icon />,
      choose: () => onAction(action.id),
      category: 'actions',
    }))
    for (const profile of profiles) {
      all.push({
        id: `connection:${profile.id}`,
        label: profile.name,
        detail: `${profile.engine} · ${profile.environment} · ${statuses[profile.id]?.state || 'disconnected'}`,
        keywords: `${profile.host} ${localDatabasePath(profile)} ${profile.database} ${profile.folder} ${profile.tags.join(' ')}`,
        icon: <EngineIcon engine={profile.engine} />,
        category: 'connections',
        connectionId: profile.id,
        choose: () => {
          void onConnect(profile).catch((error) => toast.error(errorText(error)))
        },
      })
      for (const object of objects[profile.id] || [])
        all.push({
          id: JSON.stringify([
            'object',
            profile.id,
            object.database,
            object.kind,
            object.schema,
            object.name,
          ]),
          label: `${object.schema ? `${object.schema}.` : ''}${object.name}`,
          detail: `${profile.name}${object.database ? ` · ${object.database}` : ''} · ${object.kind}`,
          keywords: profile.engine,
          icon: <Table2 />,
          category: 'objects',
          connectionId: profile.id,
          choose: () => onOpenObject(profile, object),
        })
    }
    for (const query of savedQueries)
      all.push({
        id: `query:${query.id}`,
        label: query.name,
        detail: `Saved query · ${query.engine}${query.database ? ` · ${query.database}` : ''}`,
        keywords: `${query.folder} ${query.tags.join(' ')} ${query.sql}`,
        icon: <FileCode2 />,
        category: 'queries',
        connectionId: query.connectionId,
        choose: () =>
          onOpenQuery({
            name: query.name,
            engine: query.engine,
            schema: query.schema,
            sql: query.sql,
            connectionId: query.connectionId,
            database: query.database,
            collection: query.collection,
            mongoMode: query.mongoMode,
            searchIndex: query.searchIndex,
            searchPageSize: query.searchPageSize,
            parameterDefinitions: query.parameterDefinitions,
            savedQueryId: query.id,
          }),
      })
    all.push(...catalog)
    const words = term.split(/\s+/).filter(Boolean)
    return all
      .filter(
        (item) =>
          (scope === 'all' || item.category === scope) &&
          (!targetId || item.category === 'actions' || item.connectionId === targetId) &&
          words.every((word) => `${item.label} ${item.detail} ${item.keywords}`.toLowerCase().includes(word)),
      )
      .slice(0, 80)
  }, [
    profiles,
    savedQueries,
    objects,
    statuses,
    term,
    scope,
    targetId,
    catalog,
    onAction,
    onConnect,
    onOpenQuery,
    onOpenObject,
  ])
  const activeIndex = Math.min(highlighted, Math.max(0, items.length - 1))
  useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, listId])
  function select(item: Item) {
    if (!item.keepOpen) onClose()
    item.choose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="palette max-h-[85vh] overflow-y-auto" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Find actions, connections, saved queries, and loaded database objects. Use arrow keys and Enter to
            choose.
          </DialogDescription>
        </DialogHeader>
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search actions and database objects"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items.length ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={search}
            placeholder="Where would you like to go?"
            onChange={(event) => {
              setSearch(event.target.value)
              setHighlighted(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlighted((index) => (items.length ? (index + 1) % items.length : 0))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlighted((index) =>
                  items.length ? (Math.min(index, items.length - 1) - 1 + items.length) % items.length : 0,
                )
              }
              if (event.key === 'Enter' && items[activeIndex]) {
                event.preventDefault()
                select(items[activeIndex])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <label>
            Search scope{' '}
            <select
              aria-label="Search scope"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as typeof scope)
                setHighlighted(0)
              }}
            >
              <option value="all">All loaded content</option>
              <option value="actions">Actions</option>
              <option value="connections">Connections</option>
              <option value="queries">Saved queries</option>
              <option value="objects">Objects and indexes</option>
            </select>
          </label>
          <label>
            Connection{' '}
            <select
              aria-label="Search connection"
              value={targetId}
              onChange={(event) => changeTarget(event.target.value)}
            >
              <option value="">All loaded connections</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.engine}
                </option>
              ))}
            </select>
          </label>
        </div>
        {target && (
          <div className="flex flex-col gap-2 px-4 pb-2">
            {!['elasticsearch','opensearch'].includes(target.engine) && <label>
              Database{' '}
              <input
                aria-label="Catalog database"
                value={isLocalEngine(target.engine) ? 'main' : database}
                disabled={isLocalEngine(target.engine)}
                placeholder={target.database || 'Choose a database explicitly'}
                onChange={(event) => {
                  epoch.current++
                  setDatabase(event.target.value)
                  setCatalog([])
                  setCatalogObjects([])
                  setCatalogBusy(false)
                  setCatalogMessage('')
                }}
              />
            </label>}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canLoad || catalogBusy}
                onClick={() => void loadCatalog()}
              >
                {['elasticsearch','opensearch'].includes(target.engine) ? 'Load index catalog' : 'Load this database’s catalog'}
              </Button>
              {catalogBusy && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    epoch.current++
                    setCatalogBusy(false)
                    setCatalogMessage(
                      'Stopped waiting. The bounded metadata request may finish on the server; its results will be ignored.',
                    )
                  }}
                >
                  Stop waiting
                </Button>
              )}
            </div>
            {!canLoad && (
              <p className="field-note">
                {isKeyValueEngine(target.engine)
                  ? 'Use the Redis key browser for an explicit, bounded SCAN.'
                  : 'Connect this profile and select one database to load metadata.'}
              </p>
            )}
            {!!catalogObjects.length && (
              <div className="flex gap-2">
                <select
                  aria-label="Table for index search"
                  value={tableIndex}
                  onChange={(event) => setTableIndex(event.target.value)}
                >
                  <option value="">Select one table for indexes</option>
                  {catalogObjects.map((object, index) => (
                    <option key={index} value={index}>
                      {object.schema}.{object.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={tableIndex === '' || catalogBusy || !canLoad}
                  onClick={() => void loadCatalog(true)}
                >
                  Load indexes
                </Button>
              </div>
            )}
          </div>
        )}
        {target && statuses[target.id]?.state !== 'connected' && catalog.length > 0 && (
          <p className="field-note warning px-4" role="status">
            Catalog results are from the previous connection and may be stale. Reconnect and load the catalog
            to refresh them.
          </p>
        )}
        {catalogMessage && (
          <p className="field-note px-4" role="status">
            {catalogMessage}
          </p>
        )}
        {inspection && (
          <pre
            className="mx-4 max-h-40 overflow-auto whitespace-pre-wrap text-xs"
            aria-label="Catalog object details"
          >
            {inspection}
          </pre>
        )}
        <div className="palette-results" id={listId} role="listbox" aria-label="Matching actions and objects">
          {items.length ? (
            items.map((item, index) => (
              <button
                type="button"
                id={`${listId}-${index}`}
                key={item.id}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                className={cn('palette-item', index === activeIndex && 'bg-accent')}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => select(item)}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
                <small>{item.detail}</small>
              </button>
            ))
          ) : (
            <p className="center-empty" role="status">
              No matches. Objects become searchable after loading a connection’s explorer.
            </p>
          )}
        </div>
        <div className="palette-footer">
          <kbd>↑</kbd> <kbd>↓</kbd> Navigate &nbsp; <kbd>Enter</kbd> Open &nbsp; <kbd>Esc</kbd> Close ·{' '}
          {items.length} matches{items.length === 80 ? ' shown; refine your search' : ''}
        </div>
      </DialogContent>
    </Dialog>
  )
}
