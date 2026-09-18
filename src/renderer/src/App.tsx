import { TimeSeriesBrowser } from './components/TimeSeriesBrowser'
import { CqlBrowser } from './components/CqlBrowser'
import { DynamoBrowser } from './components/DynamoBrowser'
import { Neo4jBrowser } from './components/Neo4jBrowser'
import { CouchdbBrowser } from './components/CouchdbBrowser'
import { athenaTableDraft } from '@shared/athena'
import { warehouseTableDraft } from '@shared/warehouses'
import type { ReportDefinition } from '@shared/reports'
import { hasDatabaseContext } from '@shared/capabilities'
import { isKeyValueEngine } from '@shared/key-value'
import { isLocalEngine, localDatabasePath } from '@shared/local-database'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  Anchor,
  ArrowRight,
  Code2,
  Database,
  FileCode2,
  FlaskConical,
  FolderOpen,
  Import,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Pin,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  Table2,
  Unplug,
  X,
} from 'lucide-react'
import { Toaster, toast } from 'sonner'
import type { ConnectionProfile, ObjectInfo, WorkspaceTab } from '@shared/contracts'
import { boundQueryTarget, compatibleQueryTarget, type QueryDraft } from '@shared/query-target'
import { applicationShortcut } from '@shared/shortcuts'
import { platform, shortcutHint } from './lib/shortcuts'
import { api, isDesktop } from './lib/api'
import { engineNames, errorText, uid } from './lib/utils'
import { useApp } from './store'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { ConfirmProvider, EngineIcon, ErrorPanel, IconButton, Loading, useConfirm } from './components/common'
import { ConnectionDialog } from './components/ConnectionDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Library } from './components/Library'
import { WorkspaceManager } from './components/WorkspaceManager'
import { ResultComparison } from './components/ResultComparison'
import { CommandPalette } from './components/CommandPalette'
import { TableBrowser } from './components/TableBrowser'
import { MongoBrowser } from './components/MongoBrowser'
import { VectorBrowser } from './components/VectorBrowser'
import { SearchWorkbench } from './components/SearchWorkbench'
import { RedisBrowser } from './components/RedisBrowser'
const QueryEditor = lazy(() =>
  import('./components/QueryEditor').then((module) => ({ default: module.QueryEditor })),
)
export function App() {
  return (
    <ConfirmProvider>
      <Workbench />
    </ConfirmProvider>
  )
}
function Workbench() {
  const loaded = useApp((s) => s.loaded)
  const version = useApp((s) => s.version)
  const profiles = useApp((s) => s.profiles)
  const workspace = useApp((s) => s.workspace)
  const savedQueries = useApp((s) => s.savedQueries)
  const draftSaveState = useApp((s) => s.draftSaveState)
  const statuses = useApp((s) => s.statuses)
  const section = useApp((s) => s.section)
  const demo = useApp((s) => s.demo)
  const [fatal, setFatal] = useState('')
  const [connectionDialog, setConnectionDialog] = useState<{ profile?: ConnectionProfile } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [importProfiles, setImportProfiles] = useState<ConnectionProfile[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [queryTarget, setQueryTarget] = useState<QueryDraft | null>(null)
  const initialized = useRef(false)
  const visitedTabs = useRef(new Set<string>())
  const actionRef = useRef<(action: string) => void>(() => {})
  const confirm = useConfirm()
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
  const activeProfile = profiles.find((p) => p.id === activeTab?.connectionId)
  const activeRuntime = useApp((s) => (activeTab ? s.runtime[activeTab.id] : undefined))
  const activeStatus = activeProfile ? statuses[activeProfile.id] : undefined
  if (activeTab) visitedTabs.current.add(activeTab.id)
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void useApp
      .getState()
      .initialize()
      .catch((e) => setFatal(errorText(e)))
  }, [])
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        workspace.settings.theme === 'dark' || (workspace.settings.theme === 'system' && mq.matches),
      )
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [workspace.settings.theme])
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const action = applicationShortcut(e, platform)
      if (action === 'next-tab' || action === 'previous-tab') {
        e.preventDefault()
        const w = useApp.getState().workspace
        const index = w.tabs.findIndex((t) => t.id === w.activeTabId)
        const next = w.tabs[(index + (action === 'previous-tab' ? -1 : 1) + w.tabs.length) % w.tabs.length]
        if (next) useApp.getState().activate(next.id)
      } else if (action) {
        e.preventDefault()
        actionRef.current(action)
      }
    }
    window.addEventListener('keydown', listener)
    const remove = api.onMenu((action) => actionRef.current(action))
    return () => {
      window.removeEventListener('keydown', listener)
      remove()
    }
  }, [])
  useEffect(() => {
    if (!loaded || !isDesktop) return
    const timer = setInterval(() => {
      const state = useApp.getState()
      for (const p of state.profiles) {
        if (
          !p.id.startsWith('demo-') &&
          ['connected', 'reconnecting', 'degraded', 'authentication-failed'].includes(
            state.statuses[p.id]?.state,
          )
        ) {
          void api
            .status(p.id)
            .then((status) => state.setStatus(p.id, status))
            .catch(() => {})
        }
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [loaded])
  async function connect(profile: ConnectionProfile) {
    if (profile.id.startsWith('demo-')) return
    useApp.getState().setStatus(profile.id, { state: 'connecting' })
    try {
      const status = await api.connect({ id: profile.id })
      useApp.getState().setStatus(profile.id, status)
      if (status.state !== 'connected') throw new Error(status.error || 'Connection failed')
      toast.success(`Connected to ${profile.name}`)
      if (['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine)) {
        openSearch(profile)
        return
      }
      if (['influxdb','questdb'].includes(profile.engine)) { newQuery(profile); return }
      if(profile.engine==='cassandra'){newQuery(profile);return}
      if (profile.engine === 'dynamodb') { newQuery(profile); return }
      if (profile.engine === 'neo4j') { newQuery(profile); return }
      if (profile.engine === 'couchdb') { newQuery(profile); return }
      if (profile.engine === 'mongodb') {
        openMongo(profile)
        return
      }
      if (
        isKeyValueEngine(profile.engine) &&
        !useApp.getState().workspace.tabs.some((t) => t.connectionId === profile.id && t.kind === 'redis')
      )
        openRedis(profile)
      if (!isKeyValueEngine(profile.engine)) {
        try {
          const objects = !profile.database ? [] : await api.listObjects({ connectionId: profile.id })
          useApp.getState().setObjects(profile.id, objects)
        } catch (error) {
          toast.error(`Connected to ${profile.name}. Could not load database objects: ${errorText(error)}`)
        }
        if (!useApp.getState().workspace.expanded.includes(profile.id))
          useApp.getState().toggleExpanded(profile.id)
      }
    } catch (e) {
      const error = errorText(e)
      const status = useApp.getState().statuses[profile.id]
      useApp.getState().setStatus(profile.id, {
        ...status,
        state: status?.state === 'authentication-failed' ? status.state : 'failed',
        error,
      })
      toast.error(error)
      setConnectionDialog({ profile })
    }
  }
  function resolveProfile(profile?: ConnectionProfile) {
    return (
      profile ||
      profiles.find((p) => p.id === useApp.getState().selectedConnection) ||
      activeProfile ||
      profiles[0]
    )
  }
  function newQuery(profile?: ConnectionProfile, database?: string) {
    const target = resolveProfile(profile)
    if (!target) {
      setConnectionDialog({})
      return
    }
    if (['influxdb','questdb'].includes(target.engine)) { useApp.getState().openTab({connectionId:target.id,kind:'timeseries',title:engineNames[target.engine]+' time series',sql:''});useApp.getState().setSection('connections');return }
    if(target.engine==='cassandra'){useApp.getState().openTab({connectionId:target.id,kind:'cql',title:'Cassandra CQL',sql:'',database:target.database||undefined});useApp.getState().setSection('connections');return}
    if (target.engine === 'dynamodb') { useApp.getState().openTab({connectionId:target.id,kind:'dynamodb',title:'DynamoDB items',sql:''});useApp.getState().setSection('connections');return }
    if (target.engine === 'neo4j') { useApp.getState().openTab({connectionId:target.id,kind:'neo4j',title:'Neo4j Cypher',sql:'',database:target.database||undefined});useApp.getState().setSection('connections');return }
    if (target.engine === 'couchdb') { useApp.getState().openTab({connectionId:target.id,kind:'couch',title:'CouchDB documents',sql:'',database:target.database||undefined});useApp.getState().setSection('connections');return }
    if (target.engine === 'mongodb') {
      useApp.getState().openTab({
        connectionId: target.id,
        kind: 'mongo',
        title: 'MongoDB query',
        sql: '{}',
        database:
          database ||
          (activeTab?.connectionId === target.id ? activeTab.database : undefined) ||
          target.database ||
          undefined,
        table: activeTab?.connectionId === target.id ? activeTab.table : undefined,
        mongoMode: 'find',
      })
      useApp.getState().setSection('connections')
      return
    }
    if (['elasticsearch', 'opensearch', 'qdrant', 'milvus', 'weaviate', 'pinecone'].includes(target.engine)) {
      const vector = ['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(target.engine)
      useApp.getState().openTab({ connectionId: target.id, kind: 'search', title: `${engineNames[target.engine]} ${vector ? 'vectors' : 'search'}`, sql: vector ? '[]' : '{"query":{"match_all":{}}}', searchIndex: activeTab?.connectionId === target.id ? activeTab.searchIndex : undefined, searchPageSize: 200 })
      useApp.getState().setSection('connections')
      return
    }
    const number = useApp.getState().workspace.tabs.filter((t) => t.kind === 'query').length + 1
    const queryDatabase = hasDatabaseContext(target.engine)
      ? database ||
        target.database ||
        (activeTab?.connectionId === target.id ? activeTab.database : undefined)
      : undefined
    useApp.getState().openTab({
      connectionId: target.id,
      ...(queryDatabase ? { database: queryDatabase } : {}),
      kind: 'query',
      title: isKeyValueEngine(target.engine) ? `Console ${number}` : `Query ${number}`,
      sql:
        isKeyValueEngine(target.engine)
          ? 'PING'
          : `-- ${target.name} · ${queryDatabase || target.database || 'Choose a database'}\nSELECT 1;`,
    })
    useApp.getState().setSection('connections')
  }
  function openRedis(profile: ConnectionProfile) {
    const existing = useApp
      .getState()
      .workspace.tabs.find((t) => t.kind === 'redis' && t.connectionId === profile.id)
    if (existing) useApp.getState().activate(existing.id)
    else useApp.getState().openTab({ connectionId: profile.id, kind: 'redis', title: 'Redis keys', sql: '' })
    useApp.getState().setSection('connections')
  }
  function openMongo(profile: ConnectionProfile) {
    const state = useApp.getState()
    const existing = state.workspace.tabs.find((t) => t.kind === 'mongo' && t.connectionId === profile.id)
    if (existing) state.activate(existing.id)
    else
      state.openTab({
        connectionId: profile.id,
        kind: 'mongo',
        title: 'MongoDB documents',
        sql: '{}',
        ...(profile.database ? { database: profile.database } : {}),
      })
    state.setSection('connections')
  }
  function openSearch(profile: ConnectionProfile) {
    const state = useApp.getState()
    const existing = state.workspace.tabs.find((tab) => tab.kind === 'search' && tab.connectionId === profile.id)
    if (existing) state.activate(existing.id)
    else newQuery(profile)
    state.setSection('connections')
  }
  function openObject(profile: ConnectionProfile, object: ObjectInfo) {
    if (profile.engine === 'athena') {
      useApp.getState().openTab({ connectionId: profile.id, database: object.database || profile.database, schema: object.database || profile.database, kind: 'query', title: object.name + ' (review job)', sql: athenaTableDraft(profile.athena.catalog, object.database || profile.database, object.name) })
      return
    }
    if (profile.engine === 'bigquery' || profile.engine === 'snowflake' || profile.engine === 'databricks') {
      useApp.getState().openTab({ connectionId: profile.id, database: object.database || profile.database, schema: object.schema, kind: 'query', title: object.name + ' (review job)', sql: warehouseTableDraft(profile.engine, object.database || profile.database, object.schema, object.name) })
      useApp.getState().setSection('connections')
      return
    }
    const database = hasDatabaseContext(profile.engine)
      ? object.database || profile.database || undefined
      : undefined
    const existing = useApp
      .getState()
      .workspace.tabs.find(
        (t) =>
          t.connectionId === profile.id &&
          t.kind === 'table' &&
          (t.database || profile.database || undefined) === (database || profile.database || undefined) &&
          t.table === object.name &&
          t.schema === object.schema,
      )
    if (existing) useApp.getState().activate(existing.id)
    else
      useApp.getState().openTab({
        connectionId: profile.id,
        ...(database ? { database } : {}),
        kind: 'table',
        title: object.name,
        table: object.name,
        schema: object.schema,
        sql: '',
      })
    useApp.getState().setSection('connections')
  }
  async function closeTab(tab: WorkspaceTab) {
    if (tab.pinned) {
      toast.info('Unpin this tab before closing it.')
      return
    }
    const runtime = useApp.getState().runtime[tab.id]
    if (runtime?.running) {
      toast.info('Cancel the running operation before closing this tab.')
      return
    }
    if (runtime?.pendingEdits) {
      if (
        !(await confirm({
          title: 'Discard staged changes?',
          description: `There are unapplied changes in ${tab.title}. Closing this tab discards those local changes.`,
          label: 'Discard and close',
          danger: true,
        }))
      )
        return
    }
    if (runtime?.transaction && runtime.transaction !== 'idle') {
      if (
        !(await confirm({
          title: 'Roll back this transaction?',
          description: `${tab.title} has an open transaction on ${profiles.find((p) => p.id === tab.connectionId)?.name}. Closing the tab rolls it back.`,
          label: 'Roll back and close',
          danger: true,
        }))
      )
        return
    }
    try {
      if (!tab.connectionId.startsWith('demo-') && isDesktop)
        await api.closeSession({ connectionId: tab.connectionId, sessionId: tab.id })
      useApp.getState().removeTab(tab.id)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  async function saveQuery(tab = activeTab) {
    if (!tab || !['query', 'table', 'mongo', 'search'].includes(tab.kind)) return
    const target = profiles.find((p) => p.id === tab.connectionId)
    if (!target) return
    const name = await confirm({
      title: 'Save query',
      description: 'Save this query locally for later. Queries can contain sensitive values.',
      input: true,
      defaultValue: tab.title,
      label: 'Save query',
    })
    if (name === false) return
    try {
      const previous = useApp.getState().savedQueries.find((query) => query.id === tab.savedQueryId)
      const savedQueryId = previous?.id || uid()
      await api.saveQuery({
        id: savedQueryId,
        name,
        sql: tab.sql,
        engine: target.engine,
        schema: tab.schema || target.schema,
        parameterDefinitions: tab.parameterDefinitions,
        connectionId: target.id.startsWith('demo-') ? undefined : target.id,
        ...(target.engine === 'mongodb'
          ? { collection: tab.table || undefined, mongoMode: tab.mongoMode || 'find' }
          : {}),
        ...(tab.kind === 'search' ? { searchIndex: tab.searchIndex, searchPageSize: tab.searchPageSize } : {}),
        ...((hasDatabaseContext(target.engine) || target.engine === 'mongodb') && (tab.database || target.database)
          ? { database: tab.database || target.database }
          : {}),
        folder: previous?.folder || '',
        tags: previous?.tags || [],
        updatedAt: new Date().toISOString(),
      })
      useApp.getState().updateTab(tab.id, { ...(['query', 'search'].includes(tab.kind) ? { title: name } : {}), savedQueryId })
      await useApp.getState().refreshMetadata()
      toast.success('Query saved')
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  function openSaved(query: QueryDraft) {
    const target = boundQueryTarget(query, profiles)
    if (!target) {
      setQueryTarget(query)
      return
    }
    openTargetedQuery(query, target)
  }
  function openReport(report: ReportDefinition) {
    openSaved({
      reportId: report.id,
      name: report.name,
      sql: report.sql,
      engine: 'duckdb',
      connectionId: report.connectionId,
      database: report.database,
      parameterDefinitions: report.parameterDefinitions,
    })
  }
  function openTargetedQuery(query: QueryDraft, target: ConnectionProfile) {
    if (!compatibleQueryTarget(query, target)) return
    useApp.getState().openTab({
      connectionId: target.id,
      ...(query.database || target.database ? { database: query.database || target.database } : {}),
      // The physical connection owns search_path/default schema. A saved schema
      // is provenance, not permission to silently retarget that session.
      schema: target.schema,
      parameterDefinitions: query.parameterDefinitions,
      savedQueryId: query.savedQueryId,
      reportId: query.reportId,
      kind: ['elasticsearch', 'opensearch'].includes(target.engine) ? 'search' : target.engine === 'mongodb' ? 'mongo' : 'query',
      ...(['elasticsearch', 'opensearch'].includes(target.engine) ? { searchIndex: query.searchIndex, searchPageSize: query.searchPageSize } : {}),
      ...(target.engine === 'mongodb' ? { table: query.collection, mongoMode: query.mongoMode } : {}),
      title: query.name,
      sql: query.sql,
    })
    setQueryTarget(null)
    useApp.getState().setSection('connections')
  }
  async function importSql() {
    try {
      const file = await api.importSql()
      if (file) openSaved(file)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  async function previewImport() {
    try {
      const imported = await api.previewImport()
      if (imported) setImportProfiles(imported)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  async function prepareClose() {
    const runtime = useApp.getState().runtime
    const needsReview = Object.values(runtime).some(
      (r) => r.running || r.pendingEdits || r.transaction !== 'idle',
    )
    if (
      needsReview &&
      !(await confirm({
        title: 'Close Harbor DB?',
        description:
          'Active operations will be interrupted, open transactions rolled back, and unapplied changes discarded. Query drafts will be saved according to your privacy settings.',
        label: 'Close application',
        danger: true,
      }))
    )
      return
    try {
      await useApp.getState().flush()
      await api.readyToClose()
    } catch (e) {
      toast.error(`Workspace could not be saved: ${errorText(e)}`)
    }
  }
  actionRef.current = (action) => {
    if (useApp.getState().switchingWorkspace) return
    switch (action) {
      case 'new-connection':
        setConnectionDialog({})
        break
      case 'new-query':
        newQuery()
        break
      case 'command-palette':
        setPaletteOpen(true)
        break
      case 'settings':
        setSettingsOpen(true)
        break
      case 'save-query':
        void saveQuery()
        break
      case 'close-tab':
        if (activeTab) void closeTab(activeTab)
        break
      case 'import-sql':
        void importSql()
        break
      case 'import-connections':
        void previewImport()
        break
      case 'export-connections':
        void api.exportProfiles().catch((e) => toast.error(errorText(e)))
        break
      case 'prepare-close':
        void prepareClose()
        break
      case 'toggle-theme':
        useApp
          .getState()
          .setSettings({ theme: document.documentElement.classList.contains('dark') ? 'light' : 'dark' })
        break
      case 'private-session':
        setSettingsOpen(true)
        break
      default:
        window.dispatchEvent(new CustomEvent('harbor-action', { detail: action }))
    }
  }
  const startDemo = () => {
    useApp.getState().startDemo()
    useApp.getState().setSection('connections')
  }
  if (fatal)
    return (
      <div className="center-empty">
        <Anchor />
        <h3>Harbor DB could not open your workspace</h3>
        <ErrorPanel message={fatal} />
        <p>Your existing application data has been preserved. Resolve the storage issue and restart.</p>
      </div>
    )
  if (!loaded) return <Loading text="Opening your workspace…" />
  return (
    <div className={`app ${workspace.settings.density}`}>
      <header className="topbar">
        <div className="brand">
          <Anchor />
          <span>Harbor DB</span>
          <span className="brand-subtitle">Local database workbench</span>
        </div>
        <button className="global-search" onClick={() => setPaletteOpen(true)}>
          <Search />
          <span>Search anything…</span>
          <kbd>{shortcutHint('command-palette')}</kbd>
        </button>
        <div className="topbar-actions">
          <WorkspaceManager />
          <Button variant="outline" onClick={() => newQuery()}>
            <Plus />
            New query
          </Button>
          <Button onClick={() => setConnectionDialog({})}>
            <Plus />
            New connection
          </Button>
        </div>
      </header>
      <div className="workbench">
        <Sidebar
          onNewConnection={() => setConnectionDialog({})}
          onEditConnection={(profile) => setConnectionDialog({ profile })}
          onConnect={connect}
          onNewQuery={newQuery}
          onOpenObject={openObject}
          onSettings={() => setSettingsOpen(true)}
          onImport={() => void previewImport()}
        />
        <main className="main-area">
          <div className="flex min-w-0 shrink-0 border-b border-[var(--line)]">
            <div className="tabs flex-1" role="tablist" aria-label="Workspace tabs">
              {workspace.tabs.map((tab) => (
                <div
                  role="tab"
                  id={`workspace-tab-${tab.id}`}
                  aria-controls={`workspace-panel-${tab.id}`}
                  tabIndex={tab.id === workspace.activeTabId ? 0 : -1}
                  aria-selected={tab.id === workspace.activeTabId}
                  key={tab.id}
                  className={`tab ${tab.id === workspace.activeTabId && section === 'connections' ? 'active' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/harbor-tab', tab.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    useApp.getState().reorderTab(e.dataTransfer.getData('text/harbor-tab'), tab.id)
                  }}
                  onClick={() => {
                    useApp.getState().activate(tab.id)
                    useApp.getState().setSection('connections')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault()
                      void closeTab(tab)
                      return
                    }
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                      e.preventDefault()
                      const index = workspace.tabs.findIndex((item) => item.id === tab.id)
                      const next =
                        workspace.tabs[
                          e.key === 'Home'
                            ? 0
                            : e.key === 'End'
                              ? workspace.tabs.length - 1
                              : (index + (e.key === 'ArrowRight' ? 1 : workspace.tabs.length - 1)) %
                                workspace.tabs.length
                        ]
                      if (next) {
                        useApp.getState().activate(next.id)
                        document.getElementById(`workspace-tab-${next.id}`)?.focus()
                      }
                      return
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      useApp.getState().activate(tab.id)
                      useApp.getState().setSection('connections')
                    }
                  }}
                  title={`${tab.title} · ${profiles.find((p) => p.id === tab.connectionId)?.name || 'Connection removed'}${tab.database ? ` · ${tab.database}` : ''}`}
                >
                  {tab.kind === 'table' ? <Table2 /> : tab.kind === 'redis' ? <Database /> : <FileCode2 />}
                  {tab.pinned && <Pin aria-label="Pinned tab" />}
                  <span>{tab.title}</span>
                  {tab.savedQueryId &&
                    savedQueries.some(
                      (query) =>
                        query.id === tab.savedQueryId &&
                        (query.sql !== tab.sql ||
                          JSON.stringify(query.parameterDefinitions || []) !==
                            JSON.stringify(tab.parameterDefinitions || [])),
                    ) && (
                      <span
                        aria-label="Changed from saved query"
                        title="This draft differs from the saved query. Local draft saving is independent."
                      >
                        ●
                      </span>
                    )}
                </div>
              ))}
            </div>
            <div className="tab-add flex gap-1 pr-2">
              <ResultComparison />
              {activeTab && (
                <IconButton label={`Close ${activeTab.title}`} onClick={() => void closeTab(activeTab)}>
                  <X />
                </IconButton>
              )}
              <IconButton label={`New query · ${shortcutHint('new-query')}`} onClick={() => newQuery()}>
                <Plus />
              </IconButton>
            </div>
          </div>
          {section !== 'connections' && (
            <Library section={section} onOpenQuery={openSaved} onOpenReport={openReport} onImportSql={() => void importSql()} />
          )}
          <div className="query-workspace" style={{ display: section === 'connections' ? 'flex' : 'none' }}>
            {activeTab && activeProfile ? (
              <>
                <div className="context-bar">
                  <div className="context-target">
                    <EngineIcon engine={activeProfile.engine} />
                    {activeProfile.name}
                  </div>
                  <span className="text-xs opacity-70">
                    {isLocalEngine(activeProfile.engine)
                      ? localDatabasePath(activeProfile)
                      : `${activeProfile.host}:${activeProfile.port}`}
                  </span>
                  <span className="slash">/</span>
                  <span>
                    {isKeyValueEngine(activeProfile.engine)
                      ? `db ${activeProfile.redisDb}`
                      : activeProfile.engine === 'dynamodb' ? activeProfile.dynamo.region
                      : ['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(activeProfile.engine)
                        ? activeTab.searchIndex || 'Choose a collection or index'
                      : ['elasticsearch', 'opensearch'].includes(activeProfile.engine)
                        ? activeTab.searchIndex || 'Choose an index or pattern'
                      : ['mariadb', 'mysql'].includes(activeProfile.engine) &&
                          activeTab.kind === 'table' &&
                          !activeRuntime?.tableQueryMode
                        ? activeTab.schema || activeProfile.database || 'No default database'
                        : activeTab.database ||
                          activeProfile.database ||
                          (isLocalEngine(activeProfile.engine) ? 'main' : 'Choose a database')}
                  </span>
                  {['postgres', 'sqlite', 'duckdb'].includes(activeProfile.engine) && (
                    <>
                      <span className="slash">/</span>
                      <span>{activeTab.schema || activeProfile.schema}</span>
                    </>
                  )}
                  <div className="badges">
                    <Badge variant="outline" className={`env ${activeProfile.environment}`}>
                      {activeProfile.environment}
                    </Badge>
                    <span className="read-state">
                      <Shield />
                      {activeProfile.readOnly ? 'Read-only' : 'Writes enabled'}
                    </span>
                    {isKeyValueEngine(activeProfile.engine) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          activeTab.kind === 'redis' ? newQuery(activeProfile) : openRedis(activeProfile)
                        }
                      >
                        {activeTab.kind === 'redis' ? <Code2 /> : <Database />}
                        {activeTab.kind === 'redis' ? 'Console' : 'Key browser'}
                      </Button>
                    )}
                  </div>
                </div>
                {!activeProfile.id.startsWith('demo-') && activeStatus?.state !== 'connected' && (
                  <div className="hint-bar">
                    <Unplug />
                    {activeStatus?.error ||
                      `Disconnected from ${activeProfile.name}. Your draft is preserved.`}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={activeStatus?.state === 'connecting'}
                      onClick={() => void connect(activeProfile)}
                    >
                      {activeStatus?.state === 'connecting' ? (
                        <LoaderCircle className="spin" />
                      ) : (
                        <Database />
                      )}
                      Connect
                    </Button>
                  </div>
                )}
                {workspace.tabs.map((tab) => {
                  const profile = profiles.find((p) => p.id === tab.connectionId)
                  if (!profile || !visitedTabs.current.has(tab.id)) return null
                  return (
                    <div
                      key={tab.id}
                      id={`workspace-panel-${tab.id}`}
                      role="tabpanel"
                      aria-labelledby={`workspace-tab-${tab.id}`}
                      className="query-workspace"
                      style={{ display: tab.id === workspace.activeTabId ? 'flex' : 'none' }}
                    >
                      {useApp.getState().runtime[tab.id]?.restored ? (
                        <div className="center-empty">
                          <RotateCcw />
                          <h3>Restored tab · no query executed</h3>
                          <p>
                            Review {profile.name} /{' '}
                            {tab.searchIndex || tab.database || profile.database || tab.schema || 'default namespace'} before
                            loading. Results, staged changes and transactions were not restored.
                          </p>
                          <Button
                            disabled={statuses[profile.id]?.state !== 'connected'}
                            onClick={() => useApp.getState().setRuntime(tab.id, { restored: false })}
                          >
                            {tab.kind === 'redis'
                              ? 'Open key browser'
                              : ['mongo', 'couch'].includes(tab.kind)
                                ? 'Open document browser'
                                : tab.kind === 'timeseries' ? 'Open time-series workspace' : tab.kind === 'search' ? 'Open search workspace' : 'Open table view'}
                          </Button>
                        </div>
                      ) : ['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine) ? (
                        <VectorBrowser tab={tab} profile={profile} />
                      ) : ['elasticsearch', 'opensearch'].includes(profile.engine) ? (
                        <SearchWorkbench tab={tab} profile={profile} onSave={() => void saveQuery(tab)} />
                      ) : ['influxdb','questdb'].includes(profile.engine) ? (
                        <TimeSeriesBrowser profile={profile} tab={tab} />
                      ) : profile.engine === 'cassandra' ? (
                        <CqlBrowser profile={profile} tab={tab} />
                      ) : profile.engine === 'dynamodb' ? (
                        <DynamoBrowser profile={profile} tab={tab} />
                      ) : profile.engine === 'neo4j' ? (
                        <Neo4jBrowser tab={tab} profile={profile} />
                      ) : profile.engine === 'couchdb' ? (
                        <CouchdbBrowser tab={tab} profile={profile} />
                      ) : profile.engine === 'mongodb' ? (
                        <MongoBrowser tab={tab} profile={profile} onSave={() => void saveQuery(tab)} />
                      ) : tab.kind === 'query' ? (
                        <Suspense fallback={<Loading text="Loading editor…" />}>
                          <QueryEditor
                            tab={tab}
                            profile={profile}
                            visible={tab.id === workspace.activeTabId}
                            onSave={() => void saveQuery(tab)}
                            onOpenReport={openReport}
                          />
                        </Suspense>
                      ) : tab.kind === 'table' ? (
                        <TableBrowser
                          tab={tab}
                          profile={profile}
                          visible={tab.id === workspace.activeTabId}
                          onSave={() => void saveQuery(tab)}
                        />
                      ) : (
                        <RedisBrowser tab={tab} profile={profile} />
                      )}
                    </div>
                  )
                })}
              </>
            ) : activeTab ? (
              <div className="center-empty">
                <Unplug />
                <h3>This connection was removed</h3>
                <p>The query draft is preserved. Save it to your library or close the tab.</p>
                <Button variant="outline" onClick={() => void closeTab(activeTab)}>
                  Close tab
                </Button>
              </div>
            ) : (
              <Welcome
                onNew={() => setConnectionDialog({})}
                onImport={() => void previewImport()}
                onDemo={startDemo}
                hasConnections={profiles.length > 0}
                onQuery={() => newQuery()}
              />
            )}
          </div>
        </main>
      </div>
      <footer className="statusbar">
        <span className="status-item">
          <Anchor />
          Harbor DB <span className="muted">{version}</span>
        </span>
        {workspace.settings.privateSession && (
          <span className="status-item warning">
            <LockKeyhole />
            Private session
          </span>
        )}
        <span
          title={
            workspace.settings.privateSession
              ? 'Current private drafts and recently closed tabs stay in memory.'
              : 'Local draft saving is separate from named saved queries.'
          }
        >
          {workspace.name} ·{' '}
          {workspace.settings.privateSession
            ? 'Private drafts'
            : draftSaveState === 'saved'
              ? 'Drafts saved locally'
              : draftSaveState === 'saving'
                ? 'Saving drafts…'
                : draftSaveState === 'pending'
                  ? 'Draft changes not saved yet'
                  : 'Draft saving failed'}
        </span>
        {!isDesktop && <span className="warning">Browser preview</span>}
        {demo && (
          <button className="muted" onClick={() => useApp.getState().exitDemo()}>
            Exit demo
          </button>
        )}
        <div className="right">
          <span
            className="status-item"
            title={[
              activeStatus?.checkedAt && `Checked: ${activeStatus.checkedAt}`,
              activeStatus?.changedAt && `Changed: ${activeStatus.changedAt}`,
              activeStatus?.lastConnectedAt &&
                `Last authenticated connection: ${activeStatus.lastConnectedAt}`,
              activeStatus?.error,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <span className={`status-dot ${activeStatus?.state || 'disconnected'}`} />
            {activeProfile?.id.startsWith('demo-')
              ? 'Demo · example data'
              : activeStatus?.state === 'connected'
                ? 'Connected'
                : activeStatus?.state || 'No active connection'}
          </span>
          {activeProfile && (
            <>
              <span>{engineNames[activeProfile.engine]}</span>
              <span className="status-item">
                <Shield />
                {activeProfile.readOnly ? 'Read-only' : 'Writes enabled'}
              </span>
              <span>
                {activeProfile.tls.enabled
                  ? 'TLS' + (!activeProfile.tls.rejectUnauthorized ? ' · unverified' : '')
                  : activeProfile.ssh.enabled
                    ? 'SSH tunnel'
                    : 'Direct'}
              </span>
            </>
          )}
          {activeRuntime?.transaction && activeRuntime.transaction !== 'idle' && (
            <span className="warning">Transaction {activeRuntime.transaction}</span>
          )}
          <span>UTF-8</span>
        </div>
      </footer>
      {connectionDialog && (
        <ConnectionDialog initial={connectionDialog.profile} onClose={() => setConnectionDialog(null)} />
      )}{' '}
      <Dialog
        open={!!queryTarget}
        onOpenChange={(open) => {
          if (!open) setQueryTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose query target</DialogTitle>
            <DialogDescription>
              Open {queryTarget?.name} as a draft. This does not connect or execute it. Review the server,
              database, and schema before running.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 max-h-96 overflow-auto">
            {profiles.map((profile) => {
              const compatible = !!queryTarget && compatibleQueryTarget(queryTarget, profile)
              return (
                <Button
                  key={profile.id}
                  variant="outline"
                  className="h-auto justify-start whitespace-normal text-left"
                  disabled={!compatible}
                  onClick={() => {
                    if (queryTarget) openTargetedQuery(queryTarget, profile)
                  }}
                >
                  <EngineIcon engine={profile.engine} />
                  <span>
                    {profile.name}
                    <small className="block">
                      {engineNames[profile.engine]} ·{' '}
                      {isLocalEngine(profile.engine)
                        ? localDatabasePath(profile)
                        : `${profile.host}:${profile.port}`}{' '}
                      / {queryTarget?.database || profile.database || 'Choose database in tab'} /{' '}
                      {profile.schema || 'default schema'} · {profile.environment}
                    </small>
                    {queryTarget?.schema && queryTarget.schema !== profile.schema && (
                      <small className="block">
                        Saved namespace: {queryTarget.schema}. This target keeps its configured default
                        schema; SQL text stays unchanged.
                      </small>
                    )}
                    {!compatible && (
                      <small className="block">
                        {queryTarget?.engine
                          ? `Requires ${engineNames[queryTarget.engine]}`
                          : 'Requires a SQL connection'}
                      </small>
                    )}
                  </span>
                </Button>
              )
            })}
            {!profiles.some((profile) => queryTarget && compatibleQueryTarget(queryTarget, profile)) && (
              <p>No compatible connection. Add one, then open this query again.</p>
            )}
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setQueryTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setQueryTarget(null)
                setConnectionDialog({})
              }}
            >
              Add connection
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}{' '}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onAction={(a) => actionRef.current(a)}
          onConnect={connect}
          onOpenQuery={openSaved}
          onOpenObject={openObject}
        />
      )}
      <Dialog
        open={!!importProfiles}
        onOpenChange={(open) => {
          if (!open) setImportProfiles(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import connections</DialogTitle>
            <DialogDescription>
              Review {importProfiles?.length || 0} profiles. Each gets a new ID; duplicate names get a suffix.
              Existing profiles and credentials will not be overwritten. Passwords are excluded.
            </DialogDescription>
          </DialogHeader>
          <div className="import-preview">
            {importProfiles?.map((p, i) => (
              <div className="import-row" key={i}>
                <EngineIcon engine={p.engine} />
                {p.name}
                <small>
                  {p.host}:{p.port}
                </small>
              </div>
            ))}
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setImportProfiles(null)}>
              Cancel
            </Button>
            <Button
              disabled={importing || !importProfiles?.length}
              onClick={() => {
                if (!importProfiles) return
                setImporting(true)
                void api
                  .importProfiles(importProfiles)
                  .then(async (p) => {
                    await useApp.getState().refreshMetadata()
                    setImportProfiles(null)
                    toast.success(`Imported ${p.length} connections`)
                  })
                  .catch((e) => toast.error(errorText(e)))
                  .finally(() => setImporting(false))
              }}
            >
              <Import />
              {importing ? 'Importing…' : 'Import profiles'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Toaster
        position="bottom-right"
        theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        closeButton
        richColors
        toastOptions={{
          style: {
            fontSize: '12px',
            background: 'var(--raised)',
            borderColor: 'var(--line)',
            color: 'var(--text)',
          },
        }}
      />
    </div>
  )
}
function Welcome({
  onNew,
  onImport,
  onDemo,
  hasConnections,
  onQuery,
}: {
  onNew: () => void
  onImport: () => void
  onDemo: () => void
  hasConnections: boolean
  onQuery: () => void
}) {
  return (
    <div className="empty-workspace">
      <div className="welcome">
        <div className="welcome-mark">
          <Anchor />
        </div>
        <h1>Your databases. One calm workspace.</h1>
        <p>
          {hasConnections
            ? 'Choose a connection in the sidebar to browse your data, or open a new query. Your workspace is ready when you are.'
            : 'Connect, explore, and query. A thoughtful home for your databases, with everything kept on your computer.'}
        </p>
        <div className="welcome-actions">
          <Button onClick={hasConnections ? onQuery : onNew}>
            <Plus />
            {hasConnections ? 'New query' : 'Add connection'}
          </Button>
          <Button variant="outline" onClick={onImport}>
            <FolderOpen />
            Import connections
          </Button>
        </div>
        <div className="engine-list">
          <div className="engine-summary">
            <EngineIcon engine="postgres" />
            <div>
              <strong>PostgreSQL</strong>
              <small>Schemas, tables & SQL</small>
            </div>
          </div>
          <div className="engine-summary">
            <EngineIcon engine="mariadb" />
            <div>
              <strong>MariaDB</strong>
              <small>Databases, tables & SQL</small>
            </div>
          </div>
          <div className="engine-summary">
            <EngineIcon engine="mongodb" />
            <div>
              <strong>MongoDB</strong>
              <small>Collections, documents & queries</small>
            </div>
          </div>
          <div className="engine-summary">
            <EngineIcon engine="redis" />
            <div>
              <strong>Redis</strong>
              <small>Keys, values & commands</small>
            </div>
          </div>
        </div>
        <button className="demo-link" onClick={onDemo}>
          <FlaskConical />
          Take a look around. <span>Open demo workspace</span>
          <ArrowRight />
        </button>
        <div className="welcome-shortcuts">
          <span>
            <kbd>{shortcutHint('command-palette')}</kbd>Find anything
          </span>
          <span>
            <kbd>{shortcutHint('new-query')}</kbd>New query
          </span>
          <span>
            <ShieldCheck />
            Local by design
          </span>
        </div>
      </div>
    </div>
  )
}
