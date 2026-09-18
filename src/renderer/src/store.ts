import type { ReportDefinition } from '@shared/reports'
import {
  restoredDrafts,
  switchWorkspaceDrafts,
  workspaceSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from '@shared/workspaces'
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
  restored?: boolean
  tableQueryMode?: boolean
  pendingEdits?: boolean
  result?: QueryResult
  error?: string
  running?: boolean
  requestId?: string
  transaction: 'idle' | 'open' | 'failed'
}
interface AppState {
  draftSaveState: 'saved' | 'pending' | 'saving' | 'error'
  switchingWorkspace: boolean
  loaded: boolean
  version: string
  profiles: ConnectionProfile[]
  workspace: Workspace
  reports: ReportDefinition[]
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
  reopenTab(id: string): void
  switchWorkspace(target: WorkspaceSnapshot, discardReviewed: boolean): Promise<void>
  endPrivateSession(): Promise<void>
  renameWorkspace(name: string): Promise<void>
  deleteWorkspace(id: string): Promise<void>
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
let saveChain: Promise<void> = Promise.resolve()
function persist(workspace: Workspace) {
  const safe = workspaceSchema.parse({
    ...workspace,
    tabs: workspace.tabs.filter((tab) => !tab.connectionId.startsWith('demo-')),
    recentlyClosed: workspace.recentlyClosed.filter((tab) => !tab.connectionId.startsWith('demo-')),
    expanded: workspace.expanded.filter((id) => !id.startsWith('demo-')),
    activeTabId: workspace.activeTabId?.startsWith('demo-') ? null : workspace.activeTabId,
  })
  saveChain = saveChain.catch(() => {}).then(() => api.saveWorkspace(safe))
  return saveChain
}
const restoredRuntime = (tabs: WorkspaceTab[]) =>
  Object.fromEntries(
    tabs.map((tab) => [tab.id, { transaction: 'idle' as const, restored: tab.kind !== 'query' }]),
  )
const pinnedFirst = (tabs: WorkspaceTab[]) => [
  ...tabs.filter((tab) => tab.pinned),
  ...tabs.filter((tab) => !tab.pinned),
]

function queueSave() {
  useApp.setState({ draftSaveState: 'pending' })
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
  draftSaveState: 'saved',
  switchingWorkspace: false,
  loaded: false,
  version: '',
  profiles: [],
  workspace: previewBootstrap.workspace,
  reports: [],
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
      runtime: restoredRuntime(b.workspace.tabs),
      reports: b.reports,
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
      reports: b.reports,
      savedQueries: b.savedQueries,
      history: b.history,
      secureStorage: b.secureStorage,
    })
  },
  setProfiles: (profiles) => set({ profiles }),
  setStatus: (id, status) =>
    set((s) => {
      const previous = s.statuses[id]
      const now = new Date().toISOString()
      return {
        statuses: {
          ...s.statuses,
          [id]: {
            ...status,
            checkedAt: status.checkedAt || now,
            changedAt: status.changedAt || (previous?.state === status.state ? previous.changedAt : now),
            lastConnectedAt:
              status.lastConnectedAt ||
              (status.state === 'connected' && previous?.state !== 'connected'
                ? now
                : previous?.lastConnectedAt),
          },
        },
      }
    }),
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
      workspace: { ...s.workspace, tabs: pinnedFirst([...s.workspace.tabs, tab]), activeTabId: id },
      runtime: { ...s.runtime, [id]: { transaction: 'idle' } },
    }))
    queueSave()
    return id
  },
  updateTab: (id, updates) => {
    set((s) => ({
      workspace: {
        ...s.workspace,
        tabs: pinnedFirst(s.workspace.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t))),
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
      const closed = s.workspace.tabs.find((t) => t.id === id)
      const tabs = s.workspace.tabs.filter((t) => t.id !== id)
      const runtime = { ...s.runtime }
      delete runtime[id]
      return {
        workspace: {
          ...s.workspace,
          tabs,
          recentlyClosed:
            closed && !closed.connectionId.startsWith('demo-')
              ? [closed, ...s.workspace.recentlyClosed.filter((tab) => tab.id !== id)].slice(0, 10)
              : s.workspace.recentlyClosed,
          activeTabId: s.workspace.activeTabId === id ? tabs.at(-1)?.id || null : s.workspace.activeTabId,
        },
        runtime,
      }
    })
    queueSave()
  },
  reopenTab: (closedId) => {
    const snapshot = get().workspace.recentlyClosed.find((tab) => tab.id === closedId)
    if (!snapshot || get().workspace.tabs.length >= 100) return
    const tab = { ...snapshot, id: uid() }
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: pinnedFirst([...state.workspace.tabs, tab]),
        activeTabId: tab.id,
        recentlyClosed: state.workspace.recentlyClosed.filter((item) => item.id !== closedId),
      },
      runtime: { ...state.runtime, ...restoredRuntime([tab]) },
      section: 'connections',
    }))
    queueSave()
  },
  switchWorkspace: async (target, discardReviewed) => {
    if (get().switchingWorkspace) throw new Error('A workspace change is already in progress.')
    const state = get()
    if (state.demo) throw new Error('Exit the example workspace before switching saved workspaces.')
    if (Object.values(state.runtime).some((runtime) => runtime.running))
      throw new Error('Cancel running operations before switching workspaces.')
    if (
      !discardReviewed &&
      Object.values(state.runtime).some((runtime) => runtime.pendingEdits || runtime.transaction !== 'idle')
    )
      throw new Error('Review staged changes and open transactions before switching workspaces.')
    // Validate limits before closing any physical sessions. The old workspace stays visible on failure.
    const next = switchWorkspaceDrafts(state.workspace, workspaceSnapshotSchema.parse(target), uid)
    if (next === state.workspace) return
    clearTimeout(timer)
    set({ switchingWorkspace: true })
    try {
      await saveChain.catch(() => {})
      for (const tab of state.workspace.tabs) {
        if (!tab.connectionId.startsWith('demo-')) {
          await api.closeSession({ connectionId: tab.connectionId, sessionId: tab.id })
          get().setRuntime(tab.id, { transaction: 'idle' })
        }
      }
      await persist(next)
      set({
        workspace: next,
        runtime: restoredRuntime(next.tabs),
        section: 'connections',
        draftSaveState: 'saved',
      })
    } finally {
      set({ switchingWorkspace: false })
    }
  },
  endPrivateSession: async () => {
    const state = get()
    if (state.switchingWorkspace) throw new Error('A workspace change is already in progress.')
    if (Object.values(state.runtime).some((runtime) => runtime.running))
      throw new Error('Cancel running operations before ending the private session.')
    clearTimeout(timer)
    set({ switchingWorkspace: true })
    try {
      await saveChain.catch(() => {})
      const previous = (await api.bootstrap()).workspace
      const next = workspaceSchema.parse({
        ...previous,
        ...restoredDrafts(previous, uid),
        settings: { ...state.workspace.settings, privateSession: false },
      })
      for (const tab of state.workspace.tabs) {
        if (!tab.connectionId.startsWith('demo-')) {
          await api.closeSession({ connectionId: tab.connectionId, sessionId: tab.id })
          get().setRuntime(tab.id, { transaction: 'idle' })
        }
      }
      await persist(next)
      set({
        workspace: next,
        runtime: restoredRuntime(next.tabs),
        draftSaveState: 'saved',
        section: 'connections',
      })
    } finally {
      set({ switchingWorkspace: false })
    }
  },
  renameWorkspace: async (name) => {
    const state = get()
    if (state.workspace.settings.privateSession)
      throw new Error('End the private session before renaming a workspace.')
    const next = workspaceSchema.parse({ ...state.workspace, name })
    clearTimeout(timer)
    await persist(next)
    set({ workspace: next })
  },
  deleteWorkspace: async (id) => {
    const state = get()
    if (state.workspace.settings.privateSession)
      throw new Error('End the private session before deleting a workspace.')
    const next = {
      ...state.workspace,
      archivedWorkspaces: state.workspace.archivedWorkspaces.filter((snapshot) => snapshot.id !== id),
    }
    clearTimeout(timer)
    await persist(next)
    set({ workspace: next })
  },
  reorderTab: (id, before) => {
    set((s) => {
      const tabs = [...s.workspace.tabs]
      const from = tabs.findIndex((t) => t.id === id)
      const to = tabs.findIndex((t) => t.id === before)
      if (from < 0 || to < 0 || !!tabs[from].pinned !== !!tabs[to].pinned) return {}
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
    if (get().switchingWorkspace) {
      await saveChain
      return
    }
    const workspace = get().workspace
    set({ draftSaveState: 'saving' })
    try {
      await persist(workspace)
      if (get().workspace === workspace) set({ draftSaveState: 'saved' })
    } catch (error) {
      set({ draftSaveState: 'error' })
      throw error
    }
  },
}))
