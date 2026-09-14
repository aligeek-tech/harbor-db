import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  Bootstrap,
  ConnectionProfile,
  ConnectionStatus,
  HistoryEntry,
  ObjectInfo,
  QueryResult,
  SavedQuery,
  Settings,
  Workspace,
  WorkspaceTab,
} from '@shared/contracts'
import { api } from './lib/api'
import { demoObjects, demoProfiles, demoResult, demoSql, previewBootstrap } from './lib/demo'
import { uid } from './lib/utils'
interface Runtime {
  tableQueryMode?: boolean
  pendingEdits?: boolean
  result?: QueryResult
  error?: string
  running?: boolean
  requestId?: string
  transaction: 'idle' | 'open' | 'failed'
}
interface AppState {
  loaded: boolean
  version: string
  profiles: ConnectionProfile[]
  workspace: Workspace
  savedQueries: SavedQuery[]
  history: HistoryEntry[]
  secureStorage: Bootstrap['secureStorage']
  statuses: Record<string, ConnectionStatus>
  objects: Record<string, ObjectInfo[]>
  runtime: Record<string, Runtime>
  demo: boolean
  section: 'connections' | 'queries' | 'history'
  selectedConnection: string | null
  initialize(): Promise<void>
  refreshMetadata(): Promise<void>
  setProfiles(profiles: ConnectionProfile[]): void
  setStatus(id: string, status: ConnectionStatus): void
  setObjects(id: string, objects: ObjectInfo[]): void
  clearObjects(id: string): void
  setSection(section: AppState['section']): void
  selectConnection(id: string): void
  openTab(tab: Partial<WorkspaceTab> & Pick<WorkspaceTab, 'connectionId' | 'kind' | 'title'>): string
  updateTab(id: string, updates: Partial<WorkspaceTab>): void
  activate(id: string): void
  removeTab(id: string): void
  reorderTab(id: string, before: string): void
  setRuntime(id: string, updates: Partial<Runtime>): void
  setSettings(updates: Partial<Settings>): void
  toggleExpanded(id: string): void
  startDemo(): void
  exitDemo(): void
  flush(): Promise<void>
}
let timer: ReturnType<typeof setTimeout> | undefined
let persistenceWarning = false
function queueSave() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    void useApp
      .getState()
      .flush()
      .then(() => {
        persistenceWarning = false
      })
      .catch(() => {
        if (!persistenceWarning) {
          toast.error(
            'Workspace could not be saved. Check disk space and file permissions. Your current drafts remain open.',
          )
          persistenceWarning = true
        }
      })
  }, 400)
}
export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  version: '',
  profiles: [],
  workspace: previewBootstrap.workspace,
  savedQueries: [],
  history: [],
  secureStorage: previewBootstrap.secureStorage,
  statuses: {},
  objects: {},
  runtime: {},
  demo: false,
  section: 'connections',
  selectedConnection: null,
  initialize: async () => {
    const b = await api.bootstrap()
    set({
      loaded: true,
      version: b.version,
      profiles: b.profiles,
      workspace: b.workspace,
      savedQueries: b.savedQueries,
      history: b.history,
      secureStorage: b.secureStorage,
    })
    for (const p of b.profiles) {
      if (p.autoReconnect) {
        try {
          set((s) => ({ statuses: { ...s.statuses, [p.id]: { state: 'reconnecting' } } }))
          const status = await api.connect({ id: p.id })
          set((s) => ({ statuses: { ...s.statuses, [p.id]: status } }))
        } catch (e) {
          set((s) => ({ statuses: { ...s.statuses, [p.id]: { state: 'failed', error: String(e) } } }))
        }
      }
    }
  },
  refreshMetadata: async () => {
    const b = await api.bootstrap()
    set({
      profiles: get().demo ? [...b.profiles, ...demoProfiles] : b.profiles,
      savedQueries: b.savedQueries,
      history: b.history,
      secureStorage: b.secureStorage,
    })
  },
  setProfiles: (profiles) => set({ profiles }),
  setStatus: (id, status) => set((s) => ({ statuses: { ...s.statuses, [id]: status } })),
  setObjects: (id, objects) => set((s) => ({ objects: { ...s.objects, [id]: objects } })),
  clearObjects: (id) =>
    set((s) => {
      const objects = { ...s.objects }
      delete objects[id]
      return { objects }
    }),
  setSection: (section) => set({ section }),
  selectConnection: (id) => set({ selectedConnection: id }),
  openTab: (input) => {
    const id = input.id || uid()
    const tab: WorkspaceTab = { id, sql: '', ...input }
    set((s) => ({
      workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab], activeTabId: id },
      runtime: { ...s.runtime, [id]: { transaction: 'idle' } },
    }))
    queueSave()
    return id
  },
  updateTab: (id, updates) => {
    set((s) => ({
      workspace: {
        ...s.workspace,
        tabs: s.workspace.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      },
    }))
    queueSave()
  },
  activate: (id) => {
    set((s) => ({ workspace: { ...s.workspace, activeTabId: id } }))
    queueSave()
  },
  removeTab: (id) => {
    set((s) => {
      const tabs = s.workspace.tabs.filter((t) => t.id !== id)
      const runtime = { ...s.runtime }
      delete runtime[id]
      return {
        workspace: {
          ...s.workspace,
          tabs,
          activeTabId: s.workspace.activeTabId === id ? tabs.at(-1)?.id || null : s.workspace.activeTabId,
        },
        runtime,
      }
    })
    queueSave()
  },
  reorderTab: (id, before) => {
    set((s) => {
      const tabs = [...s.workspace.tabs]
      const from = tabs.findIndex((t) => t.id === id)
      const to = tabs.findIndex((t) => t.id === before)
      if (from < 0 || to < 0) return {}
      const [tab] = tabs.splice(from, 1)
      tabs.splice(to, 0, tab)
      return { workspace: { ...s.workspace, tabs } }
    })
    queueSave()
  },
  setRuntime: (id, updates) =>
    set((s) =>
      s.workspace.tabs.some((t) => t.id === id)
        ? { runtime: { ...s.runtime, [id]: { ...(s.runtime[id] || { transaction: 'idle' }), ...updates } } }
        : {},
    ),
  setSettings: (updates) => {
    set((s) => ({ workspace: { ...s.workspace, settings: { ...s.workspace.settings, ...updates } } }))
    queueSave()
  },
  toggleExpanded: (id) => {
    set((s) => ({
      workspace: {
        ...s.workspace,
        expanded: s.workspace.expanded.includes(id)
          ? s.workspace.expanded.filter((x) => x !== id)
          : [...s.workspace.expanded, id],
      },
    }))
    queueSave()
  },
  startDemo: () => {
    const table: WorkspaceTab = {
      id: 'demo-table',
      connectionId: 'demo-postgres',
      kind: 'table',
      title: 'orders',
      schema: 'public',
      table: 'orders',
      sql: '',
    }
    const query: WorkspaceTab = {
      id: 'demo-query',
      connectionId: 'demo-postgres',
      kind: 'query',
      title: 'Query 1',
      sql: demoSql,
    }
    set((s) => ({
      demo: true,
      profiles: [...s.profiles, ...demoProfiles],
      selectedConnection: 'demo-postgres',
      objects: { ...s.objects, 'demo-postgres': demoObjects },
      statuses: {
        ...s.statuses,
        ...Object.fromEntries(
          demoProfiles.map((p) => [p.id, { state: 'connected', version: 'Example data' }]),
        ),
      },
      workspace: {
        ...s.workspace,
        tabs: [...s.workspace.tabs, table, query],
        activeTabId: query.id,
        expanded: [...s.workspace.expanded, 'demo-postgres'],
      },
      runtime: {
        ...s.runtime,
        'demo-table': { transaction: 'idle', result: demoResult },
        'demo-query': { transaction: 'idle', result: demoResult },
      },
    }))
  },
  exitDemo: () => {
    set((s) => {
      const tabs = s.workspace.tabs.filter((t) => !t.connectionId.startsWith('demo-'))
      return {
        demo: false,
        profiles: s.profiles.filter((p) => !p.id.startsWith('demo-')),
        selectedConnection: null,
        workspace: { ...s.workspace, tabs, activeTabId: tabs.at(-1)?.id || null },
      }
    })
  },
  flush: async () => {
    clearTimeout(timer)
    const w = get().workspace
    await api.saveWorkspace({
      ...w,
      tabs: w.tabs
        .filter((t) => !t.connectionId.startsWith('demo-'))
        .map((t) => (w.settings.privateSession ? { ...t, sql: '' } : t)),
      expanded: w.expanded.filter((x) => !x.startsWith('demo-')),
      activeTabId: w.activeTabId?.startsWith('demo-') ? null : w.activeTabId,
    })
  },
}))
