import { hasDatabaseContext } from '@shared/capabilities'
import { isKeyValueEngine } from '@shared/key-value'
import { Diagnostics } from './Diagnostics'
import { ObjectInspector } from './ObjectInspector'
import { isLocalEngine, localDatabasePath } from '@shared/local-database'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import {
  ArrowRight,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  DatabaseZap,
  FileCode2,
  Folder,
  FolderOpen,
  History,
  KeyRound,
  Layers,
  ListOrdered,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Shield,
  Table2,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, ObjectInfo } from '@shared/contracts'
import { qualifiedName, sqlDialect } from '@shared/sql'
import { duplicateProfile, recentConnectionIds } from '@shared/connection-hub'
import { useApp } from '../store'
import { api } from '../lib/api'
import { cn, engineNames, errorText, uid } from '../lib/utils'
import { EngineIcon, ErrorPanel, IconButton, Loading, useConfirm } from './common'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface SidebarProps {
  onNewConnection: () => void
  onEditConnection: (profile: ConnectionProfile) => void
  onConnect: (profile: ConnectionProfile) => Promise<void>
  onNewQuery: (profile?: ConnectionProfile, database?: string) => void
  onOpenObject: (profile: ConnectionProfile, object: ObjectInfo) => void
  onSettings: () => void
  onImport: () => void
}
type Inspection = {
  profile: ConnectionProfile
  object: ObjectInfo
}
type DatabasePicker = { profile: ConnectionProfile; databases?: string[]; error?: string }
const relational = (object: ObjectInfo) => ['table', 'view', 'materialized view'].includes(object.kind)
const isDemo = (profile: ConnectionProfile) => profile.id.startsWith('demo-')
const serverExplorer = (profile: ConnectionProfile) =>
  !['redis', 'valkey', 'neo4j', 'dynamodb', 'cassandra', 'influxdb', 'questdb', 'couchdb', 'mongodb', 'sqlite', 'duckdb', 'elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && !profile.database
const databaseKey = (id: string, database: string) => `${id}:database:${encodeURIComponent(database)}`
const databaseSchemaKey = (id: string, database: string, schema: string) =>
  `${databaseKey(id, database)}:schema:${encodeURIComponent(schema)}`
const catalogContext = (profile: ConnectionProfile) =>
  JSON.stringify([
    profile.engine,
    profile.database,
    profile.schema,
    profile.host,
    profile.port,
    profile.username,
    profile.tls,
    profile.ssh,
    profile.sqlite,
    profile.duckdb,
  ])
function matches(value: string, search: string): boolean {
  const haystack = value.toLocaleLowerCase()
  return search
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((needle) => {
      if (haystack.includes(needle)) return true
      let position = 0
      for (const character of needle) {
        position = haystack.indexOf(character, position)
        if (position < 0) return false
        position++
      }
      return true
    })
}
function withoutCredentials(
  profile: ConnectionProfile,
  updates: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    ...duplicateProfile(profile, uid()),
    ...updates,
  }
}
function ObjectIcon({ object }: { object: ObjectInfo }) {
  if (object.kind === 'function') return <Braces />
  if (object.kind === 'sequence') return <ListOrdered />
  if (object.kind === 'trigger') return <Zap />
  if (object.kind === 'view' || object.kind === 'materialized view') return <Layers />
  return <Table2 />
}

const OBJECT_PAGE_SIZE = 300

function PagedObjectList({
  members,
  label,
  children,
}: {
  members: ObjectInfo[]
  label: string
  children: (object: ObjectInfo, index: number) => ReactNode
}) {
  const [limit, setLimit] = useState(OBJECT_PAGE_SIZE)
  const ordered = useMemo(() => {
    const tables: ObjectInfo[] = []
    const other: ObjectInfo[] = []
    for (const object of members) (relational(object) ? tables : other).push(object)
    return [...tables, ...other]
  }, [members])
  const shown = Math.min(limit, ordered.length)
  const next = Math.min(OBJECT_PAGE_SIZE, ordered.length - shown)
  return (
    <>
      {ordered.slice(0, shown).map(children)}
      {ordered.length > OBJECT_PAGE_SIZE && (
        <div className="py-1">
          <p className="group-subtitle" role="status">
            Showing {shown.toLocaleString()} of {ordered.length.toLocaleString()} objects.
          </p>
          {next > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Show ${next} more objects in ${label}`}
              onClick={() => setLimit((current) => current + OBJECT_PAGE_SIZE)}
            >
              Show {next.toLocaleString()} more
            </Button>
          )}
        </div>
      )}
    </>
  )
}

export function Sidebar({
  onNewConnection,
  onEditConnection,
  onConnect,
  onNewQuery,
  onOpenObject,
  onSettings,
  onImport,
}: SidebarProps) {
  const profiles = useApp((s) => s.profiles)
  const statuses = useApp((s) => s.statuses)
  const objects = useApp((s) => s.objects)
  const expanded = useApp((s) => s.workspace.expanded)
  const activeTab = useApp((s) => s.workspace.tabs.find((tab) => tab.id === s.workspace.activeTabId))
  const sidebarWidth = useApp((s) => s.workspace.settings.sidebarWidth)
  const savedCount = useApp((s) => s.savedQueries.length)
  const historyCount = useApp((s) => s.history.length)
  const history = useApp((s) => s.history)
  const section = useApp((s) => s.section)
  const selected = useApp((s) => s.selectedConnection)
  const [search, setSearch] = useState('')
  const [hubView, setHubView] = useState<'all' | 'favorites' | 'recent'>('all')
  const recent = useMemo(() => recentConnectionIds(history, statuses), [history, statuses])
  const filter = useDeferredValue(search.trim())
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({})
  const loadedSchemas = useRef(new Map<string, Set<string>>())
  const loadedDatabases = useRef(new Map<string, Set<string>>())
  const catalogGeneration = useRef<Record<string, number>>({})
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [picker, setPicker] = useState<DatabasePicker | null>(null)
  const [databaseSearch, setDatabaseSearch] = useState('')
  const pending = useRef(new Set<string>())
  const previousStates = useRef<Record<string, string>>({})
  const previousContexts = useRef<Record<string, string>>({})
  const resize = useRef<{ x: number; width: number } | null>(null)
  const confirm = useConfirm()

  const invalidateCatalog = useCallback((id: string) => {
    catalogGeneration.current[id] = (catalogGeneration.current[id] || 0) + 1
    loadedSchemas.current.delete(id)
    loadedDatabases.current.delete(id)
    setCatalogs((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    useApp.getState().clearObjects(id)
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => key !== id && !key.startsWith(`${id}:schema:`) && !key.startsWith(`${id}:database:`),
        ),
      ),
    )
  }, [])

  const loadObjects = useCallback(
    async (profile: ConnectionProfile, force = false, schema?: string, database?: string) => {
      const allDatabases = serverExplorer(profile)
      const requestKey = database
        ? databaseKey(profile.id, database)
        : schema
          ? `${profile.id}:schema:${schema}`
          : profile.id
      if (['redis', 'valkey', 'neo4j', 'dynamodb', 'cassandra', 'influxdb', 'questdb', 'couchdb', 'mongodb', 'elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) || isDemo(profile) || pending.current.has(requestKey))
        return
      const state = useApp.getState()
      if (!force) {
        if (database && loadedDatabases.current.get(profile.id)?.has(database)) return
        if (schema && loadedSchemas.current.get(profile.id)?.has(schema)) return
        if (!schema && !database && allDatabases && catalogs[profile.id] !== undefined) return
        if (!schema && !allDatabases && state.objects[profile.id] !== undefined) return
      }
      if (state.statuses[profile.id]?.state !== 'connected') return
      if (allDatabases && !schema && !database && force) invalidateCatalog(profile.id)
      const generation = catalogGeneration.current[profile.id] || 0
      const context = catalogContext(profile)
      const currentRequest = () => {
        const latest = useApp.getState()
        return (
          latest.statuses[profile.id]?.state === 'connected' &&
          latest.profiles.some((item) => item.id === profile.id && catalogContext(item) === context) &&
          (catalogGeneration.current[profile.id] || 0) === generation
        )
      }
      pending.current.add(requestKey)
      setLoading((current) => ({ ...current, [requestKey]: true }))
      setErrors((current) => ({ ...current, [requestKey]: '' }))
      try {
        if (allDatabases && !schema && !database) {
          const databases = await api.listDatabases(profile.id)
          if (currentRequest()) setCatalogs((current) => ({ ...current, [profile.id]: databases }))
        } else {
          const list = await api.listObjects({
            connectionId: profile.id,
            ...(schema ? { schema } : {}),
            ...(database ? { database } : {}),
          })
          if (currentRequest()) {
            const latest = useApp.getState()
            if (allDatabases && database) {
              const loaded = loadedDatabases.current.get(profile.id) || new Set<string>()
              loaded.add(database)
              loadedDatabases.current.set(profile.id, loaded)
              latest.setObjects(profile.id, [
                ...(latest.objects[profile.id] || []).filter((object) => object.database !== database),
                ...list.map((object) => ({ ...object, database })),
              ])
            } else if (allDatabases && schema) {
              const loaded = loadedSchemas.current.get(profile.id) || new Set<string>()
              loaded.add(schema)
              loadedSchemas.current.set(profile.id, loaded)
              latest.setObjects(profile.id, [
                ...(latest.objects[profile.id] || []).filter((object) => object.schema !== schema),
                ...list,
              ])
            } else latest.setObjects(profile.id, list)
          }
        }
      } catch (error) {
        if (currentRequest()) setErrors((current) => ({ ...current, [requestKey]: errorText(error) }))
      } finally {
        pending.current.delete(requestKey)
        setLoading((current) => ({ ...current, [requestKey]: false }))
      }
    },
    [catalogs, invalidateCatalog],
  )

  useEffect(() => {
    for (const profile of profiles) {
      const state = statuses[profile.id]?.state || 'disconnected'
      const reconnected = state === 'connected' && previousStates.current[profile.id] !== state
      const context = catalogContext(profile)
      const previousContext = previousContexts.current[profile.id]
      const contextChanged = previousContext !== undefined && previousContext !== context
      if (contextChanged || (previousStates.current[profile.id] === 'connected' && state !== 'connected'))
        invalidateCatalog(profile.id)
      previousContexts.current[profile.id] = context
      const missingMetadata = serverExplorer(profile)
        ? catalogs[profile.id] === undefined
        : objects[profile.id] === undefined
      if (
        expanded.includes(profile.id) &&
        state === 'connected' &&
        (reconnected || contextChanged || (missingMetadata && !errors[profile.id]))
      )
        void loadObjects(profile, reconnected || contextChanged)
      previousStates.current[profile.id] = state
      if (
        serverExplorer(profile) &&
        expanded.includes(profile.id) &&
        state === 'connected' &&
        !loading[profile.id] &&
        !pending.current.has(profile.id)
      ) {
        for (const database of catalogs[profile.id] || []) {
          const postgres = hasDatabaseContext(profile.engine)
          const key = postgres ? databaseKey(profile.id, database) : `${profile.id}:schema:${database}`
          const loaded = postgres ? loadedDatabases : loadedSchemas
          if (expanded.includes(key) && !loaded.current.get(profile.id)?.has(database) && !errors[key])
            void loadObjects(profile, false, postgres ? undefined : database, postgres ? database : undefined)
        }
      }
      if (
        expanded.includes(profile.id) &&
        !(hasDatabaseContext(profile.engine) && !profile.database) &&
        objects[profile.id]?.length &&
        !expanded.includes(`${profile.id}:schemas-initialized`)
      ) {
        const store = useApp.getState()
        store.toggleExpanded(`${profile.id}:schemas-initialized`)
        const schema =
          objects[profile.id].find((object) => object.schema === profile.schema)?.schema ||
          objects[profile.id][0].schema
        if (!store.workspace.expanded.includes(`${profile.id}:schema:${schema}`))
          store.toggleExpanded(`${profile.id}:schema:${schema}`)
      }
    }
  }, [profiles, statuses, expanded, objects, errors, loading, catalogs, loadObjects, invalidateCatalog])

  const groups = useMemo(() => {
    const result = new Map<string, ConnectionProfile[]>()
    const ordered =
      hubView === 'recent'
        ? [...profiles].sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id))
        : profiles
    for (const profile of ordered) {
      if (hubView === 'favorites' && !profile.favorite) continue
      if (hubView === 'recent' && !recent.slice(0, 10).includes(profile.id)) continue
      const ownMatch = matches(
        `${profile.name} ${profile.host} ${localDatabasePath(profile)} ${profile.database} ${profile.folder} ${profile.environment} ${profile.tags.join(' ')} ${engineNames[profile.engine]}`,
        filter,
      )
      if (
        filter &&
        !ownMatch &&
        !catalogs[profile.id]?.some((database) => matches(database, filter)) &&
        !objects[profile.id]?.some((object) =>
          matches(`${object.database || ''} ${object.schema} ${object.name} ${object.kind}`, filter),
        )
      )
        continue
      const label =
        hubView === 'recent'
          ? 'Recent targets'
          : isDemo(profile)
            ? 'Demo workspace'
            : profile.favorite
              ? 'Favorites'
              : profile.folder || 'Connections'
      result.set(label, [...(result.get(label) || []), profile])
    }
    return [...result.entries()].sort(([a], [b]) =>
      a === 'Favorites'
        ? -1
        : b === 'Favorites'
          ? 1
          : a === 'Demo workspace'
            ? 1
            : b === 'Demo workspace'
              ? -1
              : a.localeCompare(b),
    )
  }, [profiles, objects, catalogs, filter, hubView, recent])

  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => toast.error(errorText(error)))
  }
  const copy = (value: string) =>
    run(async () => {
      await api.copyText(value)
      toast.success('Copied to clipboard')
    })

  async function guard(profile: ConnectionProfile, action: string): Promise<boolean> {
    const state = useApp.getState()
    const tabs = state.workspace.tabs.filter((tab) => tab.connectionId === profile.id)
    if (tabs.some((tab) => state.runtime[tab.id]?.running)) {
      toast.error(`Cancel or finish running operations before ${action.toLowerCase()}.`)
      return false
    }
    if (tabs.some((tab) => state.runtime[tab.id]?.pendingEdits)) {
      toast.error(
        `Apply or discard staged edits before ${action.toLowerCase()}. Your local changes are still preserved.`,
      )
      return false
    }
    const transactions = tabs.filter(
      (tab) =>
        state.runtime[tab.id]?.transaction === 'open' || state.runtime[tab.id]?.transaction === 'failed',
    )
    if (transactions.length) {
      const accepted = await confirm({
        title: `${action} with an open transaction?`,
        description: `${transactions.length} tab(s) on ${profile.name} have an open transaction. Continuing will roll back those transactions.`,
        detail: transactions.map((tab) => tab.title).join('\n'),
        label: `Roll back and ${action.toLowerCase()}`,
        danger: true,
        typed: profile.environment === 'production' ? profile.name : undefined,
      })
      if (!accepted) return false
    }
    return true
  }

  async function disconnect(profile: ConnectionProfile, reconnect = false) {
    if (!(await guard(profile, reconnect ? 'Reconnect' : 'Disconnect'))) return
    await api.disconnect(profile.id)
    const state = useApp.getState()
    state.setStatus(profile.id, { state: 'disconnected' })
    for (const tab of state.workspace.tabs.filter((tab) => tab.connectionId === profile.id))
      state.setRuntime(tab.id, { transaction: 'idle', running: false })
    if (reconnect) {
      await onConnect(profile)
      await loadObjects(profile, true)
    }
  }
  async function connect(profile: ConnectionProfile) {
    await onConnect(profile)
    const state = useApp.getState()
    if (!state.workspace.expanded.includes(profile.id)) state.toggleExpanded(profile.id)
    await loadObjects(profile, true)
  }
  async function saveMetadata(profile: ConnectionProfile, updates: Partial<ConnectionProfile>) {
    await api.saveProfile({
      profile: { ...profile, ...updates },
      rememberPassword: profile.hasPassword || profile.hasSshPassword || profile.hasPassphrase,
    })
    await useApp.getState().refreshMetadata()
  }
  async function remove(profile: ConnectionProfile) {
    if (!(await guard(profile, 'Delete connection'))) return
    const state = useApp.getState()
    const tabs = state.workspace.tabs.filter((tab) => tab.connectionId === profile.id)
    const accepted = await confirm({
      title: `Delete ${profile.name}?`,
      description: `This removes the saved profile, its remembered credentials and its query history. ${tabs.length} related tab(s) and their drafts will close. Saved queries remain in your library without this connection association. Your database is not deleted.`,
      label: 'Delete connection',
      danger: true,
      typed: profile.name,
    })
    if (!accepted) return
    await api.deleteProfile(profile.id)
    for (const tab of tabs) useApp.getState().removeTab(tab.id)
    useApp.getState().setStatus(profile.id, { state: 'disconnected' })
    await useApp.getState().refreshMetadata()
    toast.success('Connection deleted')
  }
  async function edit(profile: ConnectionProfile) {
    if (await guard(profile, 'Edit connection')) onEditConnection(profile)
  }
  async function changeGroup(profile: ConnectionProfile) {
    const name = await confirm({
      title: 'Organize connection',
      description: `Move ${profile.name} into a sidebar group.`,
      input: true,
      defaultValue: profile.folder || 'Development',
      label: 'Move to group',
    })
    if (name) await saveMetadata(profile, { folder: name.trim() })
  }
  function openQuery(profile: ConnectionProfile, object: ObjectInfo) {
    const dialect = sqlDialect(profile.engine)
    const name = qualifiedName(object.schema, object.name, dialect)
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    let sql = dialect === 'mssql' ? `SELECT TOP (200) * FROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT 200;`
    if (object.kind === 'function')
      sql =
        dialect === 'postgres'
          ? `SELECT pg_get_functiondef(p.oid)\nFROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\nWHERE n.nspname = ${literal(object.schema)} AND p.proname = ${literal(object.name)};`
          : `SELECT ROUTINE_TYPE, ROUTINE_DEFINITION\nFROM information_schema.ROUTINES\nWHERE ROUTINE_SCHEMA = ${literal(object.schema)} AND ROUTINE_NAME = ${literal(object.name)};`
    if (object.kind === 'trigger')
      sql =
        dialect === 'sqlite'
          ? `SELECT sql FROM main.sqlite_schema WHERE type = 'trigger' AND name = ${literal(object.name)};`
          : dialect === 'mssql'
            ? `SELECT OBJECT_DEFINITION(OBJECT_ID(N${literal(name)})) AS definition;`
            : `SHOW CREATE TRIGGER ${name};`
    const state = useApp.getState()
    state.setSection('connections')
    state.openTab({
      connectionId: profile.id,
      kind: 'query',
      title: object.name,
      sql,
      schema: object.schema,
      ...(object.database ? { database: object.database } : {}),
    })
  }
  async function inspect(profile: ConnectionProfile, object: ObjectInfo) {
    if (isDemo(profile)) {
      toast('Demo objects use example data. Connect a database to inspect its live structure.')
      return
    }
    if (object.kind === 'sequence' || (isLocalEngine(profile.engine) && !relational(object))) {
      openQuery(profile, object)
      return
    }
    setInspection({ profile, object })
  }
  async function databases(profile: ConnectionProfile) {
    setDatabaseSearch('')
    setPicker({ profile })
    try {
      const list = await api.listDatabases(profile.id)
      setPicker((current) => (current?.profile.id === profile.id ? { profile, databases: list } : current))
    } catch (error) {
      setPicker((current) =>
        current?.profile.id === profile.id ? { profile, error: errorText(error) } : current,
      )
    }
  }
  function renderObjectRows(
    profile: ConnectionProfile,
    members: ObjectInfo[],
    schema: string,
    database?: string,
  ) {
    return (
      <PagedObjectList
        key={JSON.stringify([
          profile.id,
          database || profile.database,
          schema,
          filter,
          catalogGeneration.current[profile.id] || 0,
        ])}
        members={members}
        label={[database || profile.database, schema].filter(Boolean).join('.')}
      >
        {(object, index) => {
          const name = qualifiedName(object.schema, object.name, sqlDialect(profile.engine))
          const active =
            activeTab?.connectionId === profile.id &&
            activeTab.table === object.name &&
            activeTab.schema === object.schema &&
            (!hasDatabaseContext(profile.engine) ||
              (activeTab.database || profile.database) === (object.database || profile.database))
          return (
            <div
              className="connection-row"
              style={{ minHeight: 28 }}
              key={`${object.kind}:${object.name}:${index}`}
            >
              <button
                type="button"
                className={cn('object-row', active && 'active')}
                title={`${object.kind} · ${name}${object.estimatedRows && Number(object.estimatedRows) >= 0 ? ` · approximately ${Number(object.estimatedRows).toLocaleString()} rows` : ''}`}
                onClick={() =>
                  relational(object) ? onOpenObject(profile, object) : openQuery(profile, object)
                }
              >
                <ObjectIcon object={object} />
                <span className="truncate">{object.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="icon-button connection-menu"
                    aria-label={`Actions for ${database ? `${database}.` : ''}${object.schema}.${object.name}`}
                  >
                    <MoreHorizontal />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{object.name}</DropdownMenuLabel>
                    {relational(object) && (
                      <DropdownMenuItem onSelect={() => onOpenObject(profile, object)}>
                        <Table2 />
                        Open data
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => run(() => inspect(profile, object))}>
                      <ListOrdered />
                      {object.kind === 'sequence' || (isLocalEngine(profile.engine) && !relational(object))
                        ? 'Open definition query'
                        : relational(object)
                          ? 'Inspect structure'
                          : 'Inspect definition'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openQuery(profile, object)}>
                      <FileCode2 />
                      Open query
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => copy(object.name)}>
                      <Copy />
                      Copy name
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => copy(name)}>
                      <Copy />
                      Copy qualified name
                    </DropdownMenuItem>
                    {relational(object) && (
                      <DropdownMenuItem
                        onSelect={() =>
                          copy(
                            profile.engine === 'mssql'
                              ? `SELECT TOP (200) * FROM ${name};`
                              : `SELECT * FROM ${name} LIMIT 200;`,
                          )
                        }
                      >
                        <FileCode2 />
                        Copy SELECT statement
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={() =>
                        run(() =>
                          loadObjects(
                            profile,
                            true,
                            ['mariadb', 'mysql'].includes(profile.engine) && !profile.database
                              ? object.schema
                              : undefined,
                            object.database,
                          ),
                        )
                      }
                    >
                      <RefreshCw />
                      Refresh metadata
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        }}
      </PagedObjectList>
    )
  }
  function renderPostgresDatabases(profile: ConnectionProfile, databases: string[], filtered: ObjectInfo[]) {
    return databases.map((database) => {
      const key = databaseKey(profile.id, database)
      const open = expanded.includes(key) || !!filter
      const members = filtered.filter((object) => object.database === database)
      const schemas = [...new Set(members.map((object) => object.schema))].sort()
      const loaded = loadedDatabases.current.get(profile.id)?.has(database)
      return (
        <div key={database} data-database={database}>
          <button
            type="button"
            className="object-row"
            aria-label={`${open ? 'Collapse' : 'Expand'} database ${database}`}
            aria-expanded={open}
            onClick={() => {
              useApp.getState().toggleExpanded(key)
              if (!open) void loadObjects(profile, false, undefined, database)
            }}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            <Database />
            <span className="truncate">{database}</span>
            {loaded && <small>{members.length}</small>}
          </button>
          {open && (
            <div className="ml-3">
              <div className="flex items-center gap-1 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`New query in ${database}`}
                  onClick={() => onNewQuery(profile, database)}
                >
                  <FileCode2 data-icon="inline-start" />
                  New query
                </Button>
                <IconButton
                  label={`Refresh database ${database}`}
                  disabled={loading[key]}
                  onClick={() => run(() => loadObjects(profile, true, undefined, database))}
                >
                  {loading[key] ? <LoaderCircle className="spin" /> : <RefreshCw />}
                </IconButton>
              </div>
              {loading[key] && (
                <p className="group-subtitle" role="status">
                  Loading {database} objects…
                </p>
              )}
              {errors[key] && (
                <p className="field-note text-destructive" role="alert">
                  {errors[key]}
                </p>
              )}
              {!loading[key] && !loaded && !errors[key] && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => run(() => loadObjects(profile, false, undefined, database))}
                >
                  Load objects
                </Button>
              )}
              {loaded && !loading[key] && !schemas.length && (
                <p className="group-subtitle">
                  {filter ? 'No matching loaded objects.' : `No user objects found in ${database}.`}
                </p>
              )}
              {schemas.map((schema) => {
                const schemaKey = databaseSchemaKey(profile.id, database, schema)
                const schemaOpen = expanded.includes(schemaKey) || !!filter
                const objects = members.filter((object) => object.schema === schema)
                return (
                  <div key={schema} data-schema={schema}>
                    <button
                      type="button"
                      className="object-row"
                      aria-label={`${schemaOpen ? 'Collapse' : 'Expand'} schema ${schema} in ${database}`}
                      aria-expanded={schemaOpen}
                      onClick={() => useApp.getState().toggleExpanded(schemaKey)}
                    >
                      {schemaOpen ? <ChevronDown /> : <ChevronRight />}
                      <Folder />
                      <span className="truncate">{schema}</span>
                      <small>{objects.length}</small>
                    </button>
                    {schemaOpen && (
                      <div className="ml-3">{renderObjectRows(profile, objects, schema, database)}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )
    })
  }
  function resizeStart(event: PointerEvent<HTMLDivElement>) {
    resize.current = { x: event.clientX, width: sidebarWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    if (resize.current)
      useApp.getState().setSettings({
        sidebarWidth: Math.max(190, Math.min(400, resize.current.width + event.clientX - resize.current.x)),
      })
  }

  return (
    <>
      <aside className="sidebar" style={{ width: sidebarWidth }} aria-label="Workspace navigation">
        <div className="workspace-name">
          <FolderOpen />
          <span>Local workspace</span>
          <ChevronDown aria-hidden="true" />
        </div>
        <nav className="sidebar-nav" aria-label="Workspace sections">
          <button
            type="button"
            className={cn('nav-item', section === 'connections' && 'active')}
            aria-current={section === 'connections' ? 'page' : undefined}
            onClick={() => useApp.getState().setSection('connections')}
          >
            <Database />
            <span>Connections</span>
            <span className="count">{profiles.length}</span>
          </button>
          <button
            type="button"
            className={cn('nav-item', section === 'queries' && 'active')}
            aria-current={section === 'queries' ? 'page' : undefined}
            onClick={() => useApp.getState().setSection('queries')}
          >
            <FileCode2 />
            <span>Saved queries</span>
            <span className="count">{savedCount}</span>
          </button>
          <button
            type="button"
            className={cn('nav-item', section === 'history' && 'active')}
            aria-current={section === 'history' ? 'page' : undefined}
            onClick={() => useApp.getState().setSection('history')}
          >
            <History />
            <span>History</span>
            <span className="count">{historyCount || ''}</span>
          </button>
        </nav>
        <label className="sidebar-search">
          <Search />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter connections & objects…"
            aria-label="Filter connections and loaded objects"
          />
        </label>
        <label className="sidebar-connection-view">
          <span className="sr-only">Connection view</span>
          <select
            aria-label="Connection view"
            value={hubView}
            onChange={(event) => setHubView(event.target.value as typeof hubView)}
          >
            <option value="all">All connections</option>
            <option value="favorites">Favorites</option>
            <option value="recent">Recent targets</option>
          </select>
          <ChevronDown className="sidebar-connection-chevron" aria-hidden="true" />
        </label>
        {hubView === 'recent' && (
          <p className="group-subtitle">Recent retained queries and successful connections this session.</p>
        )}
        <div className="sidebar-body">
          {!groups.length && (
            <>
              <div className="group-title">
                Connections
                <IconButton label="Add connection" onClick={onNewConnection}>
                  <Plus />
                </IconButton>
              </div>
              <p className="group-subtitle">
                {filter
                  ? 'No matching connections or loaded objects.'
                  : hubView !== 'all'
                    ? `No ${hubView} connections yet. Choose All connections to browse saved profiles.`
                    : 'Your databases, in one place. Add a connection to get started.'}
              </p>
              {!filter && (
                <Button variant="outline" size="sm" onClick={onNewConnection}>
                  <Plus data-icon="inline-start" />
                  Add connection
                </Button>
              )}
            </>
          )}
          {groups.map(([label, items]) => (
            <section key={label} aria-label={label}>
              <div className="group-title">
                {label === 'Favorites' ? (
                  <Star />
                ) : label === 'Demo workspace' ? (
                  <CircleHelp />
                ) : label !== 'Connections' ? (
                  <Folder />
                ) : null}
                <span>{label}</span>
                <IconButton label="Add connection" onClick={onNewConnection}>
                  <Plus />
                </IconButton>
              </div>
              {items.map((profile) => {
                const allDatabases = serverExplorer(profile)
                const postgresServer = allDatabases && hasDatabaseContext(profile.engine)
                const status = statuses[profile.id]?.state || 'disconnected'
                const connected = status === 'connected'
                const connecting = status === 'connecting' || status === 'reconnecting'
                const open = expanded.includes(profile.id) || !!filter
                const list = objects[profile.id] || []
                const catalogLoaded = allDatabases
                  ? catalogs[profile.id] !== undefined
                  : objects[profile.id] !== undefined
                const ownMatch = matches(
                  `${profile.name} ${profile.host} ${localDatabasePath(profile)} ${profile.database} ${profile.folder} ${profile.environment}`,
                  filter,
                )
                const filtered =
                  filter && !ownMatch
                    ? list.filter((object) =>
                        matches(
                          `${object.database || ''} ${object.schema} ${object.name} ${object.kind}`,
                          filter,
                        ),
                      )
                    : list
                const databaseNames = allDatabases
                  ? (catalogs[profile.id] || []).filter(
                      (name) =>
                        !filter ||
                        ownMatch ||
                        matches(name, filter) ||
                        filtered.some((object) =>
                          postgresServer ? object.database === name : object.schema === name,
                        ),
                    )
                  : []
                const schemas = postgresServer
                  ? []
                  : [...new Set([...databaseNames, ...filtered.map((object) => object.schema)])].sort()
                return (
                  <div key={profile.id}>
                    <div className={cn('connection-row', selected === profile.id && 'selected')}>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`${open ? 'Collapse' : 'Expand'} ${profile.name}`}
                        aria-expanded={open}
                        onClick={() => useApp.getState().toggleExpanded(profile.id)}
                      >
                        {open ? <ChevronDown /> : <ChevronRight />}
                      </button>
                      <button
                        type="button"
                        className="connection-name"
                        title={`${profile.name}\n${engineNames[profile.engine]} · ${isLocalEngine(profile.engine) ? localDatabasePath(profile) : `${profile.host}:${profile.port}`}\n${profile.environment} · ${status}`}
                        onClick={() => {
                          const state = useApp.getState()
                          state.selectConnection(profile.id)
                          state.setSection('connections')
                          if (!expanded.includes(profile.id)) state.toggleExpanded(profile.id)
                        }}
                        onDoubleClick={() => {
                          if (!connected && !connecting && !isDemo(profile)) run(() => connect(profile))
                          else onNewQuery(profile)
                        }}
                      >
                        <EngineIcon engine={profile.engine} />
                        <span>{profile.name}</span>
                      </button>
                      {profile.environment === 'production' && (
                        <small className="warning flex items-center gap-1" title="Production environment">
                          <Shield aria-hidden="true" />
                          Production
                        </small>
                      )}
                      <span
                        className={cn('status-dot', status)}
                        title={status}
                        aria-label={`${profile.name}: ${status}`}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="icon-button connection-menu"
                            aria-label={`Actions for ${profile.name}`}
                          >
                            <MoreHorizontal />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start">
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>{profile.name}</DropdownMenuLabel>
                            <DropdownMenuItem onSelect={() => onNewQuery(profile)}>
                              <FileCode2 />
                              New {isKeyValueEngine(profile.engine) ? 'console' : ['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? 'search' : 'query'}
                            </DropdownMenuItem>
                            {!isDemo(profile) && !['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && (
                              <>
                                <DropdownMenuItem
                                  disabled={connecting}
                                  onSelect={() =>
                                    run(() => (connected ? disconnect(profile) : connect(profile)))
                                  }
                                >
                                  <Power />
                                  {connected ? 'Disconnect' : 'Connect'}
                                </DropdownMenuItem>
                                {connected && (
                                  <DropdownMenuItem onSelect={() => run(() => disconnect(profile, true))}>
                                    <RefreshCw />
                                    Reconnect
                                  </DropdownMenuItem>
                                )}
                                {!['redis', 'valkey', 'neo4j', 'dynamodb', 'cassandra', 'influxdb', 'questdb', 'couchdb', 'mongodb', 'sqlite', 'duckdb', 'elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && (
                                  <DropdownMenuItem
                                    disabled={!connected}
                                    onSelect={() => run(() => databases(profile))}
                                  >
                                    <DatabaseZap />
                                    Open another database…
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                          </DropdownMenuGroup>
                          {!isDemo(profile) && !['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem onSelect={() => run(() => edit(profile))}>
                                  <Pencil />
                                  Edit connection
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => onEditConnection(withoutCredentials(profile))}
                                >
                                  <Copy />
                                  Duplicate without credentials
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    run(() => saveMetadata(profile, { favorite: !profile.favorite }))
                                  }
                                >
                                  <Star />
                                  {profile.favorite ? 'Remove favorite' : 'Add to favorites'}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => run(() => changeGroup(profile))}>
                                  <Folder />
                                  Move to group…
                                </DropdownMenuItem>
                                {profile.folder && (
                                  <DropdownMenuItem
                                    onSelect={() => run(() => saveMetadata(profile, { folder: '' }))}
                                  >
                                    <FolderOpen />
                                    Remove from group
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onSelect={() =>
                                    copy(
                                      isLocalEngine(profile.engine)
                                        ? localDatabasePath(profile)
                                        : `${profile.host}:${profile.port}`,
                                    )
                                  }
                                >
                                  <Copy />
                                  {isLocalEngine(profile.engine)
                                    ? 'Copy database file path'
                                    : 'Copy host and port'}
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => run(() => remove(profile))}
                                >
                                  <Trash2 />
                                  Delete connection
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {open && (
                      <div className="tree-level">
                        {connected ? (
                          <>
                            {!isDemo(profile) && !['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && (
                              <Diagnostics profile={profile} database={profile.database || undefined} />
                            )}
                            <div className="tree-label">
                              <Database />
                              <span className="truncate" title={profile.database}>
                                {isKeyValueEngine(profile.engine)
                                  ? `Database ${profile.redisDb}`
                                  : profile.engine === 'dynamodb' ? profile.dynamo.region
                                  : ['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? (['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? 'Vector collections / indexes' : 'Search indices')
                                  : allDatabases
                                    ? 'Databases'
                                    : isLocalEngine(profile.engine)
                                      ? 'main'
                                      : profile.database || 'Default database'}
                              </span>
                              <span className="ml-auto" title={`${profile.environment} environment`}>
                                {profile.environment}
                              </span>
                              {!['redis', 'valkey', 'neo4j', 'dynamodb', 'cassandra', 'influxdb', 'questdb', 'couchdb', 'mongodb', 'elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) && (
                                <IconButton
                                  label={`Refresh ${profile.name} objects`}
                                  disabled={loading[profile.id]}
                                  onClick={() => run(() => loadObjects(profile, true))}
                                >
                                  {loading[profile.id] ? <LoaderCircle className="spin" /> : <RefreshCw />}
                                </IconButton>
                              )}
                            </div>
                            {['redis', 'valkey', 'neo4j', 'dynamodb', 'cassandra', 'influxdb', 'questdb', 'couchdb', 'mongodb', 'elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? (
                              <button
                                type="button"
                                className="object-row"
                                onClick={() => {
                                  const state = useApp.getState()
                                  state.setSection('connections')
                                  const kind = ['influxdb','questdb'].includes(profile.engine) ? 'timeseries' : ['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? 'search' : profile.engine === 'mongodb' ? 'mongo' : profile.engine === 'couchdb' ? 'couch' : profile.engine === 'cassandra' ? 'cql' : profile.engine === 'dynamodb' ? 'dynamodb' : profile.engine === 'neo4j' ? 'neo4j' : 'redis'
                                  const existing = state.workspace.tabs.find(
                                    (tab) => tab.connectionId === profile.id && tab.kind === kind,
                                  )
                                  if (existing) state.activate(existing.id)
                                  else
                                    state.openTab({
                                      connectionId: profile.id,
                                      kind,
                                      title: kind === 'timeseries' ? engineNames[profile.engine]+' time series' : kind === 'search' ? `${engineNames[profile.engine]} ${['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? 'vectors' : 'search'}` : kind === 'mongo' ? 'MongoDB documents' : kind === 'couch' ? 'CouchDB documents' : kind === 'cql' ? 'Cassandra CQL' : kind === 'dynamodb' ? 'DynamoDB items' : kind === 'neo4j' ? 'Neo4j Cypher' : 'Keys',
                                      sql: kind === 'search' ? (['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? '[]' : '{"query":{"match_all":{}}}') : kind === 'mongo' ? '{}' : '',
                                    })
                                }}
                              >
                                <KeyRound />
                                <span>
                                  {['influxdb','questdb'].includes(profile.engine) ? 'Browse time series' : ['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? (['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? 'Browse collections & vector search' : 'Browse indices & search') : profile.engine === 'mongodb' ? 'Browse collections' : profile.engine === 'couchdb' ? 'Browse documents' : profile.engine === 'cassandra' ? 'Browse keyspaces & CQL' : profile.engine === 'dynamodb' ? 'Browse items' : profile.engine === 'neo4j' ? 'Browse graph' : 'Browse keys'}
                                </span>
                                <ChevronRight className="ml-auto" />
                              </button>
                            ) : (
                              <>
                                {allDatabases && (
                                  <p className="group-subtitle">
                                    No default database. Expand a database to browse its objects.
                                  </p>
                                )}
                                {loading[profile.id] && !list.length && (
                                  <div className="tree-label" role="status">
                                    <LoaderCircle className="spin" />
                                    {allDatabases ? 'Loading databases…' : 'Loading objects…'}
                                  </div>
                                )}
                                {errors[profile.id] && (
                                  <div className="flex flex-col gap-2 py-2">
                                    <p className="field-note text-destructive" role="alert">
                                      {errors[profile.id]}
                                    </p>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => run(() => loadObjects(profile, true))}
                                    >
                                      Retry metadata
                                    </Button>
                                  </div>
                                )}
                                {postgresServer
                                  ? renderPostgresDatabases(profile, databaseNames, filtered)
                                  : schemas.map((schema) => {
                                      const key = `${profile.id}:schema:${schema}`
                                      const schemaOpen = expanded.includes(key) || !!filter
                                      const members = filtered.filter((object) => object.schema === schema)
                                      const schemaLoaded =
                                        !allDatabases || loadedSchemas.current.get(profile.id)?.has(schema)
                                      return (
                                        <div key={schema}>
                                          <button
                                            type="button"
                                            className="object-row"
                                            aria-expanded={schemaOpen}
                                            onClick={() => {
                                              useApp.getState().toggleExpanded(key)
                                              if (allDatabases && !schemaOpen)
                                                void loadObjects(profile, false, schema)
                                            }}
                                          >
                                            {schemaOpen ? <ChevronDown /> : <ChevronRight />}
                                            {allDatabases ? <Database /> : <Folder />}
                                            <span className="truncate">{schema}</span>
                                            {schemaLoaded && <small>{members.length}</small>}
                                          </button>
                                          {schemaOpen && (
                                            <div className="ml-3">
                                              {allDatabases && loading[key] && (
                                                <p className="group-subtitle" role="status">
                                                  Loading {schema} objects…
                                                </p>
                                              )}
                                              {allDatabases && errors[key] && (
                                                <p className="field-note text-destructive" role="alert">
                                                  {errors[key]}
                                                </p>
                                              )}
                                              {allDatabases &&
                                                !loading[key] &&
                                                !schemaLoaded &&
                                                !errors[key] && (
                                                  <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                      run(() => loadObjects(profile, false, schema))
                                                    }
                                                  >
                                                    Load objects
                                                  </Button>
                                                )}
                                              {allDatabases &&
                                                !loading[key] &&
                                                schemaLoaded &&
                                                !members.length && (
                                                  <p className="group-subtitle">
                                                    {filter
                                                      ? 'No matching loaded objects.'
                                                      : `No tables, views, routines, or triggers are visible in ${schema}.`}
                                                  </p>
                                                )}
                                              {allDatabases && (schemaLoaded || errors[key]) && (
                                                <IconButton
                                                  label={`Refresh ${schema} objects`}
                                                  disabled={loading[key]}
                                                  onClick={() =>
                                                    run(() => loadObjects(profile, true, schema))
                                                  }
                                                >
                                                  <RefreshCw />
                                                </IconButton>
                                              )}
                                              {renderObjectRows(profile, members, schema)}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                {catalogLoaded &&
                                  !loading[profile.id] &&
                                  !errors[profile.id] &&
                                  !(postgresServer ? databaseNames : schemas).length && (
                                    <div className="flex flex-col items-start gap-2 py-2">
                                      <p className="group-subtitle">
                                        {filter
                                          ? 'No matching loaded objects.'
                                          : allDatabases
                                            ? 'No databases are visible to this account.'
                                            : hasDatabaseContext(profile.engine)
                                              ? `No user objects found in ${profile.database || 'the connected database'}.`
                                              : 'No tables, views, routines, or triggers are visible in this database.'}
                                      </p>
                                      {!filter &&
                                        hasDatabaseContext(profile.engine) &&
                                        !allDatabases &&
                                        !isDemo(profile) && (
                                          <>
                                            <p className="group-subtitle">
                                              Choose another database for a new query, or clear this
                                              connection's default database to browse the server.
                                            </p>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              onClick={() => run(() => databases(profile))}
                                            >
                                              <DatabaseZap data-icon="inline-start" />
                                              Choose database
                                            </Button>
                                          </>
                                        )}
                                    </div>
                                  )}
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="field-note py-1">
                              {connecting
                                ? 'Connecting…'
                                : `${engineNames[profile.engine]} · ${profile.environment}`}
                            </p>
                            {statuses[profile.id]?.error && (
                              <p className="field-note text-destructive py-1" role="alert">
                                {statuses[profile.id].error}
                              </p>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={connecting}
                              onClick={() => run(() => connect(profile))}
                            >
                              {connecting ? (
                                <LoaderCircle data-icon="inline-start" className="spin" />
                              ) : (
                                <Power data-icon="inline-start" />
                              )}
                              {status === 'failed' ? 'Try again' : 'Connect'}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}
          {filter && (
            <p className="group-subtitle pt-4">
              Search includes objects already loaded from connected databases.
            </p>
          )}
        </div>
        <footer className="sidebar-footer">
          <button type="button" className="nav-item" onClick={onImport}>
            <Upload />
            <span>Import connections</span>
          </button>
          <button type="button" className="nav-item" onClick={onSettings}>
            <Settings2 />
            <span>Settings & preferences</span>
          </button>
        </footer>
        <div
          className="sidebar-resizer"
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={400}
          aria-valuenow={sidebarWidth}
          onPointerDown={resizeStart}
          onPointerMove={resizeMove}
          onPointerUp={() => {
            resize.current = null
          }}
          onPointerCancel={() => {
            resize.current = null
          }}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
              event.preventDefault()
              useApp.getState().setSettings({
                sidebarWidth: Math.max(
                  190,
                  Math.min(400, sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10)),
                ),
              })
            }
          }}
        />
      </aside>
      {inspection && (
        <ObjectInspector
          profile={inspection.profile}
          object={inspection.object}
          onClose={() => setInspection(null)}
        />
      )}
      <Dialog
        open={!!picker}
        onOpenChange={(open) => {
          if (!open) setPicker(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open another database</DialogTitle>
            <DialogDescription>
              {!!picker && hasDatabaseContext(picker.profile.engine) && !picker.profile.database
                ? 'Open a query bound to this database using the saved connection. Your other tabs keep their database.'
                : 'A database gets its own connection profile and tab context. Review its details and authentication before connecting.'}
            </DialogDescription>
          </DialogHeader>
          {picker?.error ? (
            <ErrorPanel message={picker.error} />
          ) : picker?.databases ? (
            <>
              <input
                aria-label="Filter databases"
                placeholder="Find a database…"
                value={databaseSearch}
                onChange={(event) => setDatabaseSearch(event.target.value)}
              />
              <div className="flex max-h-80 flex-col gap-1 overflow-auto">
                {picker.databases
                  .filter((name) => matches(name, databaseSearch))
                  .map((database) => (
                    <Button
                      key={database}
                      variant="ghost"
                      disabled={database === picker.profile.database}
                      className="justify-start"
                      onClick={() => {
                        if (
                          hasDatabaseContext(picker.profile.engine) &&
                          !picker.profile.database
                        ) {
                          const profile = picker.profile
                          setPicker(null)
                          onNewQuery(profile, database)
                          return
                        }
                        const profile = withoutCredentials(picker.profile, {
                          name: `${picker.profile.name} · ${database}`.slice(0, 120),
                          database,
                        })
                        setPicker(null)
                        onEditConnection(profile)
                      }}
                    >
                      <Database data-icon="inline-start" />
                      <span className="truncate">{database}</span>
                      {database === picker.profile.database ? (
                        <small className="ml-auto">Current</small>
                      ) : (
                        <ArrowRight data-icon="inline-end" className="ml-auto" />
                      )}
                    </Button>
                  ))}
              </div>
            </>
          ) : (
            <Loading text="Loading available databases…" />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
