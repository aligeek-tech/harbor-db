import { describe, expect, it } from 'vitest'
import {
  clearWorkspaceDrafts,
  restoredDrafts,
  switchWorkspaceDrafts,
  workspaceSchema,
  workspaceSnapshot,
  workspaceSnapshotSchema,
} from '../src/shared/workspaces'
import { compareLoadedResults, exactCell } from '../src/shared/result-comparison'
import type { ResultSet } from '../src/shared/contracts'

const original = () =>
  workspaceSchema.parse({
    tabs: [
      {
        id: 'draft',
        connectionId: 'database',
        kind: 'query',
        title: 'Precise draft',
        sql: 'select :value',
        pinned: true,
        savedQueryId: 'saved',
        cursor: 8,
        parameterDefinitions: [{ name: 'value', type: 'decimal', secret: true }],
      },
    ],
    activeTabId: 'draft',
    expanded: ['database'],
    settings: {},
  })

describe('workspace draft boundaries', () => {
  it('adds backward-compatible workspace and split defaults without changing draft metadata', () => {
    const workspace = original()
    expect(workspace).toMatchObject({
      id: 'default',
      name: 'Default workspace',
      recentlyClosed: [],
      archivedWorkspaces: [],
      settings: { editorLayout: 'stacked', editorWidthPercent: 50 },
    })
    expect(workspace.tabs[0]).toMatchObject({
      sql: 'select :value',
      cursor: 8,
      pinned: true,
      savedQueryId: 'saved',
      parameterDefinitions: [{ name: 'value', type: 'decimal', secret: true }],
    })
  })
  it('archives only validated drafts and restores new IDs while keeping global preferences', () => {
    const workspace = original()
    workspace.settings.editorLayout = 'side-by-side'
    workspace.recentlyClosed = [{ ...workspace.tabs[0], id: 'closed' }]
    const target = workspaceSnapshotSchema.parse({
      id: 'other',
      name: 'Other',
      updatedAt: '2026-09-18',
      tabs: [{ ...workspace.tabs[0], id: 'second' }],
      activeTabId: 'second',
      expanded: [],
    })
    const result = switchWorkspaceDrafts(workspace, target, () => 'fresh')
    expect(result.id).toBe('other')
    expect(result.activeTabId).toBe('fresh')
    expect(result.tabs[0].id).toBe('fresh')
    expect(result.settings.editorLayout).toBe('side-by-side')
    expect(result.archivedWorkspaces[0]).toMatchObject({
      id: 'default',
      tabs: workspace.tabs,
      recentlyClosed: workspace.recentlyClosed,
    })
    expect(workspace.tabs[0].id).toBe('draft')
    expect(() => workspaceSnapshotSchema.parse({ ...target, result: { rows: [['secret']] } })).toThrow()
    expect(() =>
      workspaceSchema.parse({ ...workspace, tabs: [{ ...workspace.tabs[0], parameterValues: ['secret'] }] }),
    ).toThrow()
    expect(
      restoredDrafts({ tabs: workspace.tabs, activeTabId: 'missing' }, () => 'next').activeTabId,
    ).toBeNull()
  })
  it('blocks private switches, excludes demo content, and enforces count and archive byte limits', () => {
    const workspace = original()
    const target = workspaceSnapshot(workspace)
    target.id = 'new'
    expect(() =>
      switchWorkspaceDrafts(
        { ...workspace, settings: { ...workspace.settings, privateSession: true } },
        target,
        () => 'new',
      ),
    ).toThrow('private')
    workspace.tabs.push({ ...workspace.tabs[0], id: 'demo-tab', connectionId: 'demo-postgres' })
    workspace.recentlyClosed.push({ ...workspace.tabs[0], id: 'closed-demo', connectionId: 'demo-postgres' })
    workspace.activeTabId = 'demo-tab'
    const clean = workspaceSnapshot(workspace)
    expect(clean.tabs).toHaveLength(1)
    expect(clean.recentlyClosed).toHaveLength(0)
    expect(clean.activeTabId).toBeNull()
    expect(() =>
      workspaceSchema.parse({ ...original(), archivedWorkspaces: Array.from({ length: 20 }, () => target) }),
    ).toThrow()
    const huge = {
      ...target,
      tabs: Array.from({ length: 22 }, (_, index) => ({
        ...target.tabs[0],
        id: String(index),
        sql: 'x'.repeat(1000000),
      })),
    }
    expect(() => workspaceSchema.parse({ ...original(), archivedWorkspaces: [huge] })).toThrow('20 MiB')
  })
  it('clears all current, archived, and closed SQL without modifying saved-query references or preferences', () => {
    const workspace = original()
    workspace.recentlyClosed = [...workspace.tabs]
    workspace.archivedWorkspaces = [{ ...workspaceSnapshot(workspace), id: 'archive' }]
    const cleared = clearWorkspaceDrafts(workspace)
    expect(
      [
        cleared.tabs[0],
        cleared.recentlyClosed[0],
        cleared.archivedWorkspaces[0].tabs[0],
        cleared.archivedWorkspaces[0].recentlyClosed[0],
      ].map((tab) => tab.sql),
    ).toEqual(['', '', '', ''])
    expect(cleared.tabs[0].savedQueryId).toBe('saved')
    expect(cleared.settings).toEqual(workspace.settings)
    expect(workspace.tabs[0].sql).toBe('select :value')
  })
})

describe('loaded result comparison', () => {
  const result = (rows: ResultSet['rows']): ResultSet => ({
    columns: [
      { name: 'duplicate', type: 'text' },
      { name: 'duplicate', type: 'text' },
    ],
    rows,
    affectedRows: 0,
    command: 'SELECT',
    truncated: false,
  })
  it('compares exact typed values, null, empty and binary without decimal round trips or duplicate labels collapsing', () => {
    const left = result([
      ['9007199254740993', null],
      ['', { type: 'binary', base64: 'AA==' }],
      [true, '1'],
    ])
    const right = result([
      ['9007199254740992', ''],
      ['', { type: 'binary', base64: 'AQ==' }],
      [true, 1],
    ])
    const comparison = compareLoadedResults(left, right)
    expect(comparison.differences.map(({ row, column }) => [row, column])).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ])
    expect(comparison).toMatchObject({
      complete: true,
      comparedCells: 6,
      differentCells: 4,
      sameShape: true,
      metadata: [],
    })
    expect(exactCell({ type: 'binary', base64: 'AA==' }, { type: 'binary', base64: 'AA==' })).toBe(true)
    expect(exactCell(null, undefined)).toBe(false)
  })
  it('reports missing rows/columns, metadata differences and bounded partial comparison honestly', () => {
    const left = result([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
    const right = { ...result([[2, 1]]), columns: [{ name: 'other', type: 'int' }] }
    const comparison = compareLoadedResults(left, right, 3, 1)
    expect(comparison).toMatchObject({
      complete: false,
      displayedAllDifferences: false,
      comparedCells: 3,
      differentCells: 3,
      sameShape: false,
      metadata: [0, 1],
    })
    expect(comparison.differences).toHaveLength(1)
  })
})
