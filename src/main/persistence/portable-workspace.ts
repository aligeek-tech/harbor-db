import { randomUUID } from 'node:crypto'
import { savedQuerySchema, type SavedQuery, type WorkspaceTab } from '../../shared/contracts'
import { workspaceSchema, workspaceSnapshot, type WorkspaceSnapshot } from '../../shared/workspaces'
import {
  exportWorkspaceHandoffSchema,
  importWorkspaceHandoffSchema,
  importedProfile,
  parsePortableWorkspace,
  portableProfile,
  type ExportWorkspaceHandoff,
  type ImportWorkspaceHandoff,
  type PortableWorkspaceArchive,
  type WorkspaceHandoffPreview,
  type WorkspaceHandoffResult,
} from '../../shared/portable-workspace'
import type { MetadataStore } from './store'

const warnings = [
  'OS credentials, password flags, profile notes, TLS files, SSH private-key paths, and local database file paths are excluded. Re-enter credentials and rebind paths on this laptop before connecting.',
  'SQL and draft text can contain sensitive literal values or paths. Review included text before sharing or running it; it is not automatically redacted.',
  'Imported profiles are read-only with automatic reconnect disabled and TLS verification required. Imports never connect, execute statements, restore results, or restore transactions.',
]
const normalized = (name: string) => name.trim().toLocaleLowerCase()
function copyName(name: string, names: Set<string>, limit: number) {
  let next = name.slice(0, limit),
    suffix = 1
  while (names.has(normalized(next))) {
    const ending = ` (imported ${suffix++})`
    next = `${name.slice(0, limit - ending.length)}${ending}`
  }
  names.add(normalized(next))
  return next
}

/** Previews pin validated content in main memory; renderer decisions cannot inject new archive bytes. */
export class PortableWorkspaceService {
  private previews = new Map<string, { archive: PortableWorkspaceArchive; createdAt: number }>()
  constructor(
    private store: MetadataStore,
    private now: () => number = Date.now,
  ) {}

  export(input: ExportWorkspaceHandoff): string {
    const options = exportWorkspaceHandoffSchema.parse(input)
    const workspace = this.store.workspace()
    if (workspace.settings.privateSession && options.includeDrafts)
      throw new Error('End the private session before exporting draft workspaces.')
    const archive: PortableWorkspaceArchive = {
      format: 'harbor-db-workspace',
      version: 1,
      createdAt: new Date(this.now()).toISOString(),
      profiles: this.store
        .profiles()
        .filter((profile) => !profile.id.startsWith('demo-'))
        .map(portableProfile),
      queries: options.includeQueries ? this.store.queries() : [],
      workspaces: options.includeDrafts
        ? [workspaceSnapshot(workspace), ...workspace.archivedWorkspaces]
        : [],
      settings: { ...workspace.settings, privateSession: false },
    }
    const text = JSON.stringify(archive, null, 2)
    parsePortableWorkspace(text)
    return text
  }

  preview(text: string): WorkspaceHandoffPreview {
    const archive = parsePortableWorkspace(text)
    for (const [token, preview] of this.previews)
      if (this.now() - preview.createdAt > 5 * 60000) this.previews.delete(token)
    while (this.previews.size >= 3) this.previews.delete(this.previews.keys().next().value!)
    const token = randomUUID()
    this.previews.set(token, { archive, createdAt: this.now() })
    const workspace = this.store.workspace()
    const profiles = new Set(this.store.profiles().map((profile) => normalized(profile.name)))
    const queries = new Set(this.store.queries().map((query) => normalized(query.name)))
    const workspaces = new Set(
      [workspace.name, ...workspace.archivedWorkspaces.map((snapshot) => snapshot.name)].map(normalized),
    )
    return {
      token,
      archive: structuredClone(archive),
      warnings: [...warnings],
      conflicts: {
        profileIds: archive.profiles
          .filter((profile) => profiles.has(normalized(profile.name)))
          .map((profile) => profile.id),
        queryIds: archive.queries
          .filter((query) => queries.has(normalized(query.name)))
          .map((query) => query.id),
        workspaceIds: archive.workspaces
          .filter((snapshot) => workspaces.has(normalized(snapshot.name)))
          .map((snapshot) => snapshot.id),
      },
    }
  }

  import(input: ImportWorkspaceHandoff): WorkspaceHandoffResult {
    const decisions = importWorkspaceHandoffSchema.parse(input)
    const preview = this.previews.get(decisions.token)
    if (!preview || this.now() - preview.createdAt > 5 * 60000)
      throw new Error('This preview expired. Choose the workspace handoff file again.')
    const archive = preview.archive
    const current = this.store.workspace()
    if (current.settings.privateSession)
      throw new Error('End the private session before importing a workspace handoff.')
    if (
      decisions.profiles.length !== archive.profiles.length ||
      new Set(decisions.profiles.map((item) => item.sourceId)).size !== decisions.profiles.length ||
      decisions.profiles.some((item) => !archive.profiles.some((profile) => profile.id === item.sourceId))
    )
      throw new Error('Choose one import action for every connection profile.')
    if (
      new Set(decisions.workspaceIds).size !== decisions.workspaceIds.length ||
      decisions.workspaceIds.some((id) => !archive.workspaces.some((snapshot) => snapshot.id === id))
    )
      throw new Error('Choose only workspace IDs shown in this preview.')
    if (current.archivedWorkspaces.length + decisions.workspaceIds.length > 19)
      throw new Error(
        'This import exceeds the 20-workspace limit. Select fewer workspaces or delete an unused archive first.',
      )

    const existingProfiles = this.store.profiles()
    const profileNames = new Set(existingProfiles.map((profile) => normalized(profile.name)))
    const copiedProfiles = [] as ReturnType<typeof importedProfile>[]
    const profileIds = new Map<string, string>()
    for (const decision of decisions.profiles) {
      const source = archive.profiles.find((profile) => profile.id === decision.sourceId)!
      if (decision.action === 'copy') {
        const copy = importedProfile(source, randomUUID(), copyName(source.name, profileNames, 120))
        copiedProfiles.push(copy)
        profileIds.set(source.id, copy.id)
      } else if (decision.action === 'bind') {
        const target = existingProfiles.find((profile) => profile.id === decision.existingId)
        if (!target || target.engine !== source.engine)
          throw new Error('A linked connection must exist and use the same database engine.')
        profileIds.set(source.id, target.id)
      }
    }
    const queryNames = new Set(this.store.queries().map((query) => normalized(query.name)))
    const queryIds = new Map<string, string>()
    const queries: SavedQuery[] = []
    if (decisions.queryMode !== 'skip')
      for (const query of archive.queries) {
        if (decisions.queryMode === 'skip-conflicts' && queryNames.has(normalized(query.name))) continue
        const id = randomUUID()
        queries.push(
          savedQuerySchema.parse({
            ...query,
            id,
            name: copyName(query.name, queryNames, 255),
            connectionId: query.connectionId ? profileIds.get(query.connectionId) : undefined,
            updatedAt: new Date(this.now()).toISOString(),
          }),
        )
        queryIds.set(query.id, id)
      }
    let skippedTabs = 0
    const workspaceNames = new Set(
      [current.name, ...current.archivedWorkspaces.map((snapshot) => snapshot.name)].map(normalized),
    )
    const snapshots: WorkspaceSnapshot[] = []
    for (const source of archive.workspaces.filter((snapshot) =>
      decisions.workspaceIds.includes(snapshot.id),
    )) {
      const ids = new Map<string, string>()
      const remap = (tab: WorkspaceTab): WorkspaceTab[] => {
        const connectionId = profileIds.get(tab.connectionId)
        if (!connectionId) {
          skippedTabs++
          return []
        }
        const id = randomUUID()
        ids.set(tab.id, id)
        return [
          {
            ...tab,
            id,
            connectionId,
            savedQueryId: tab.savedQueryId ? queryIds.get(tab.savedQueryId) : undefined,
          },
        ]
      }
      const tabs = source.tabs.flatMap(remap)
      const activeTabId = source.activeTabId ? ids.get(source.activeTabId) || tabs[0]?.id || null : null
      snapshots.push({
        id: randomUUID(),
        name: copyName(source.name, workspaceNames, 100),
        updatedAt: new Date(this.now()).toISOString(),
        tabs,
        activeTabId,
        recentlyClosed: source.recentlyClosed.flatMap(remap),
        expanded: [],
      })
    }
    const workspace = workspaceSchema.parse({
      ...current,
      archivedWorkspaces: [...current.archivedWorkspaces, ...snapshots],
      settings:
        decisions.settings === 'import'
          ? { ...archive.settings, privateSession: current.settings.privateSession }
          : current.settings,
    })
    this.store.transaction(() => {
      for (const profile of copiedProfiles) this.store.saveProfile(profile)
      for (const query of queries) this.store.saveQuery(query)
      this.store.saveWorkspace(workspace)
    })
    this.previews.delete(decisions.token)
    return {
      profiles: copiedProfiles.length,
      queries: queries.length,
      workspaces: snapshots.length,
      skippedTabs,
      warnings: [
        ...warnings,
        ...(skippedTabs
          ? [`${skippedTabs} tabs were omitted because their source connections were skipped or missing.`]
          : []),
      ],
    }
  }
}
