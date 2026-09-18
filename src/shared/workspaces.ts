import { z } from 'zod'
import { seriesDraftSchema } from './time-series'
import { parameterDefinitionSchema } from './parameters'

export const tabSchema = z
  .object({
    id: z.string(),
    connectionId: z.string(),
    database: z.string().min(1).max(255).optional(),
    kind: z.enum(['query', 'table', 'redis', 'mongo', 'search', 'couch', 'neo4j', 'dynamodb', 'timeseries', 'cql']),
    seriesDraft: seriesDraftSchema.optional(),
    searchIndex: z.string().max(255).optional(),
    searchPageSize: z.number().int().min(0).max(1000).optional(),
    mongoMode: z.enum(['find', 'aggregate']).optional(),
    title: z.string().max(255),
    sql: z.string().max(1000000).default(''),
    schema: z.string().max(255).optional(),
    table: z.string().max(255).optional(),
    cursor: z.number().int().min(0).optional(),
    scrollTop: z.number().min(0).optional(),
    columnWidths: z.record(z.string(), z.number()).optional(),
    parameterDefinitions: z.array(parameterDefinitionSchema).max(100).optional(),
    hiddenColumns: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
    savedQueryId: z.string().max(100).optional(),
    reportId: z.string().max(100).optional(),
  })
  .strict()
export type WorkspaceTab = z.infer<typeof tabSchema>
export const settingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  editorFontSize: z.number().min(11).max(24).default(14),
  zoom: z.number().min(0.75).max(1.5).default(1),
  historyEnabled: z.boolean().default(true),
  historyRetentionDays: z.number().int().min(1).max(365).default(30),
  privateSession: z.boolean().default(false),
  sidebarWidth: z.number().min(190).max(400).default(248),
  editorHeight: z.number().min(140).max(700).default(290),
  editorLayout: z.enum(['stacked', 'side-by-side']).default('stacked'),
  editorWidthPercent: z.number().min(25).max(75).default(50),
  inspectorOpen: z.boolean().default(true),
  pageSize: z.number().int().min(25).max(1000).default(200),
})
export type Settings = z.infer<typeof settingsSchema>
const draftFields = {
  tabs: z.array(tabSchema).max(100),
  activeTabId: z.string().nullable(),
  expanded: z.array(z.string()).max(1000),
  recentlyClosed: z.array(tabSchema).max(10).default([]),
}
export const workspaceSnapshotSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    updatedAt: z.string(),
    ...draftFields,
  })
  .strict()
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
export const workspaceSchema = z
  .object({
    id: z.string().min(1).max(100).default('default'),
    name: z.string().trim().min(1).max(100).default('Default workspace'),
    ...draftFields,
    archivedWorkspaces: z
      .array(workspaceSnapshotSchema)
      .max(19)
      .default([])
      .refine(
        (snapshots) => new TextEncoder().encode(JSON.stringify(snapshots)).byteLength <= 20 * 1024 * 1024,
        'Saved workspace drafts exceed the 20 MiB archive limit. Remove an unused workspace or shorten its drafts.',
      ),
    settings: settingsSchema,
  })
  .strict()
export type Workspace = z.infer<typeof workspaceSchema>

/** Only schema-validated draft metadata belongs in a snapshot; never runtime/results. */
export function workspaceSnapshot(
  workspace: Workspace,
  updatedAt = new Date().toISOString(),
): WorkspaceSnapshot {
  return workspaceSnapshotSchema.parse({
    id: workspace.id,
    name: workspace.name,
    updatedAt,
    tabs: workspace.tabs.filter((tab) => !tab.connectionId.startsWith('demo-')),
    activeTabId: workspace.activeTabId?.startsWith('demo-') ? null : workspace.activeTabId,
    expanded: workspace.expanded.filter((id) => !id.startsWith('demo-')),
    recentlyClosed: workspace.recentlyClosed.filter((tab) => !tab.connectionId.startsWith('demo-')),
  })
}

export function restoredDrafts(
  snapshot: Pick<WorkspaceSnapshot, 'tabs' | 'activeTabId'>,
  newId: () => string,
) {
  const ids = new Map(snapshot.tabs.map((tab) => [tab.id, newId()]))
  return {
    tabs: snapshot.tabs.map((tab) => ({ ...tab, id: ids.get(tab.id)! })),
    activeTabId: snapshot.activeTabId ? ids.get(snapshot.activeTabId) || null : null,
  }
}

export function switchWorkspaceDrafts(
  workspace: Workspace,
  target: WorkspaceSnapshot,
  newId: () => string,
): Workspace {
  if (workspace.settings.privateSession)
    throw new Error('End the private session before switching workspaces.')
  if (target.id === workspace.id) return workspace
  return workspaceSchema.parse({
    ...workspace,
    id: target.id,
    name: target.name,
    expanded: target.expanded,
    recentlyClosed: target.recentlyClosed,
    ...restoredDrafts(target, newId),
    archivedWorkspaces: [
      workspaceSnapshot(workspace),
      ...workspace.archivedWorkspaces.filter((item) => item.id !== target.id),
    ],
    settings: workspace.settings,
  })
}

export function clearWorkspaceDrafts(workspace: Workspace): Workspace {
  const clear = (tab: WorkspaceTab): WorkspaceTab => ({ ...tab, sql: '', cursor: 0, scrollTop: 0 })
  return {
    ...workspace,
    tabs: workspace.tabs.map(clear),
    recentlyClosed: workspace.recentlyClosed.map(clear),
    archivedWorkspaces: workspace.archivedWorkspaces.map((snapshot) => ({
      ...snapshot,
      tabs: snapshot.tabs.map(clear),
      recentlyClosed: snapshot.recentlyClosed.map(clear),
    })),
  }
}
