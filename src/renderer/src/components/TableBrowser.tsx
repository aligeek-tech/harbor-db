import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Calculator,
  CircleStop,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Database,
  Filter,
  Plus,
  RefreshCw,
  Table2,
  Undo2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  Cell,
  ConnectionProfile,
  EditsInput,
  QueryResult,
  TableInput,
  TableStructure,
  WorkspaceTab,
} from '@shared/contracts'
import { api } from '../lib/api'
import { qualifiedName, quoteIdentifier } from '@shared/sql'
import { displayCell, errorText, uid } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { DataGrid } from './DataGrid'
import { CsvImportDialog } from './CsvImportDialog'
import { CopyButton, ErrorPanel, IconButton, Loading, useConfirm } from './common'

const QueryEditor = lazy(() => import('./QueryEditor').then((module) => ({ default: module.QueryEditor })))

const binaryType = (type: string) => /bytea|blob|binary/i.test(type)
function decodeBinary(value: string): Cell {
  const normalized = value.replace(/\s+/g, '')
  if (normalized.length > 2000000) throw new Error('Binary edits are limited to 2,000,000 Base64 characters.')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0)
    throw new Error('Enter valid padded Base64, for example AP+A. Hex text is not Base64.')
  try {
    return { type: 'binary', base64: btoa(atob(normalized)) }
  } catch {
    throw new Error('This value is not valid Base64.')
  }
}

export function TableBrowser({
  tab,
  profile,
  visible,
  onSave,
}: {
  tab: WorkspaceTab
  profile: ConnectionProfile
  visible: boolean
  onSave: () => void
}) {
  const runtime = useApp((s) => s.runtime[tab.id])
  const pageSize = useApp((s) => s.workspace.settings.pageSize)
  const status = useApp((s) => s.statuses[profile.id]?.state)
  const [structure, setStructure] = useState<TableStructure | null>(null)
  const [view, setView] = useState<'data' | 'structure'>('data')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>()
  const [filter, setFilter] = useState<TableInput['filter']>()
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterColumn, setFilterColumn] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [filterOperator, setFilterOperator] = useState<'contains' | 'equals' | 'is null'>('contains')
  const [changes, setChanges] = useState<Record<number, Record<string, Cell>>>({})
  const [inserts, setInserts] = useState<Record<string, Cell>[]>([])
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  // A restored SQL draft is shown without automatically executing or replacing it.
  const [queryMode, setQueryMode] = useState(() => !!tab.sql.trim())
  const [edit, setEdit] = useState<{
    row: number
    column: number
    value: string
    isNull: boolean
    binary: boolean
  } | null>(null)
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertValues, setInsertValues] = useState<Record<string, string>>({})
  const [insertNulls, setInsertNulls] = useState<Set<string>>(new Set())
  const [editError, setEditError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [exactCount, setExactCount] = useState<string | null>(null)
  const [countRequest, setCountRequest] = useState<string | null>(null)
  const operation = useRef<string | null>(null)
  const pendingRef = useRef(0)
  const [applying, setApplying] = useState(false)
  const confirm = useConfirm()
  const demo = profile.id.startsWith('demo-')
  const pending = Object.keys(changes).length + inserts.length
  pendingRef.current = pending
  const set = runtime?.result?.sets[0]
  const uniqueColumns = !!set && new Set(set.columns.map((column) => column.name)).size === set.columns.length
  const editable =
    !queryMode &&
    !profile.readOnly &&
    !demo &&
    uniqueColumns &&
    !!structure?.columns.some((c) => c.primaryKey)
  const busy = !!runtime?.running || applying
  const input: TableInput = {
    connectionId: profile.id,
    database: tab.database,
    sessionId: tab.id,
    schema: tab.schema || (profile.engine === 'postgres' ? profile.schema || 'public' : profile.database),
    table: tab.table!,
    offset,
    limit: pageSize,
    direction: sort?.direction || 'asc',
    sort: sort?.column,
    filter,
  }
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { pendingEdits: pending > 0, tableQueryMode: queryMode })
  }, [pending, queryMode, tab.id])
  function updateTableSql(result: QueryResult, expectedSql: string) {
    const latest = useApp.getState().workspace.tabs.find((item) => item.id === tab.id)
    if (result.tableQuery && latest?.sql === expectedSql)
      useApp.getState().updateTab(tab.id, { sql: result.tableQuery.editorSql, cursor: 0, scrollTop: 0 })
  }
  async function load(override: Partial<TableInput> = {}) {
    if (
      demo ||
      (profile.engine === 'postgres' && !tab.database && !profile.database) ||
      operation.current ||
      useApp.getState().runtime[tab.id]?.running ||
      useApp.getState().statuses[profile.id]?.state !== 'connected'
    )
      return
    if (pendingRef.current) {
      toast.info('Apply or discard your staged changes before refreshing.')
      return
    }
    const current = useApp.getState()
    const requested = { ...input, ...override }
    const previousSql = current.workspace.tabs.find((item) => item.id === tab.id)?.sql || ''
    const previousTableSql = current.runtime[tab.id]?.result?.tableQuery?.editorSql
    if (previousSql.trim() && previousSql !== previousTableSql) {
      operation.current = 'review-table-query'
      let approved: string | false
      try {
        approved = await confirm({
          title: 'Replace the SQL editor with the table query?',
          description:
            'Your edited query will be replaced by the SELECT for this table page. Save it first if you want to keep it.',
          detail: previousSql,
          label: 'Load table query',
        })
      } finally {
        operation.current = null
      }
      if (
        !approved ||
        useApp.getState().statuses[profile.id]?.state !== 'connected' ||
        !useApp.getState().workspace.tabs.some((item) => item.id === tab.id)
      )
        return
    }
    const requestId = uid()
    operation.current = requestId
    useApp.getState().setRuntime(tab.id, { running: true, requestId, error: undefined })
    try {
      const [result, metadata] = await Promise.allSettled([
        api.table(requested),
        api.structure({
          connectionId: profile.id,
          database: tab.database,
          schema: requested.schema,
          table: requested.table,
        }),
      ])
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      if (metadata.status === 'fulfilled') {
        setStructure(metadata.value)
        setFilterColumn((c) => c || metadata.value.columns[0]?.name || '')
      }
      if (result.status === 'rejected') throw result.reason
      useApp.getState().setRuntime(tab.id, {
        running: false,
        result: result.value,
        transaction: result.value.transaction,
        ...(metadata.status === 'rejected'
          ? { error: `Rows loaded; structure could not be refreshed: ${errorText(metadata.reason)}` }
          : {}),
      })
      updateTableSql(result.value, previousSql)
      setOffset(requested.offset)
      setSort(requested.sort ? { column: requested.sort, direction: requested.direction } : undefined)
      setFilter(requested.filter)
      if (requested.limit !== useApp.getState().workspace.settings.pageSize)
        useApp.getState().setSettings({ pageSize: requested.limit })
      setQueryMode(false)
      setSelectedRows(new Set())
    } catch (e) {
      await reportError(e, requestId)
    } finally {
      operation.current = null
    }
  }
  async function reportError(error: unknown, requestId: string, prefix = '') {
    const session = await api
      .getSessionState({ connectionId: tab.connectionId, sessionId: tab.id })
      .catch(() => undefined)
    if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
    useApp.getState().setRuntime(tab.id, {
      running: false,
      error: prefix + errorText(error),
      ...(session ? { transaction: session.state } : {}),
    })
  }
  useEffect(() => {
    if (status !== 'connected' || demo || queryMode) return
    const current = useApp.getState()
    const sql = current.workspace.tabs.find((item) => item.id === tab.id)?.sql
    if (sql?.trim() && sql !== current.runtime[tab.id]?.result?.tableQuery?.editorSql) {
      setQueryMode(true)
      return
    }
    void load()
  }, [status, tab.database])
  async function guardNavigation(action: () => void) {
    if (operation.current || useApp.getState().runtime[tab.id]?.running) return
    if (pendingRef.current) {
      toast.info('Apply or discard staged changes before changing the table view.')
      return
    }
    action()
  }
  const displaySet = useMemo(
    () =>
      set
        ? {
            ...set,
            rows: set.rows.map((r, i) =>
              r.map((v, c) =>
                changes[i] && set.columns[c].name in changes[i] ? changes[i][set.columns[c].name] : v,
              ),
            ),
          }
        : undefined,
    [set, changes],
  )
  const modified = useMemo(
    () =>
      new Set(
        Object.entries(changes).flatMap(([r, values]) =>
          Object.keys(values).map((name) => `${r}:${set?.columns.findIndex((c) => c.name === name)}`),
        ),
      ),
    [changes, set],
  )
  async function apply(deleteSelection?: number[]) {
    if (
      !set ||
      (!pending && !deleteSelection?.length) ||
      !editable ||
      operation.current ||
      useApp.getState().runtime[tab.id]?.running
    )
      return
    if (
      deleteSelection &&
      (pending || deleteSelection.length > 200 || deleteSelection.some((index) => !set.rows[index]))
    ) {
      toast.info(
        pending
          ? 'Apply or discard staged changes before deleting selected rows.'
          : 'Select up to 200 loaded rows per deletion.',
      )
      return
    }
    if (runtime?.transaction !== 'idle') {
      toast.info('Commit or roll back this tab’s transaction before applying row changes.')
      return
    }
    operation.current = 'review-edits'
    const makeOriginal = (index: number) =>
      Object.fromEntries(set.columns.map((c, i) => [c.name, set.rows[index][i]]))
    const inputChanges: EditsInput['changes'] = deleteSelection
      ? deleteSelection.map((index) => ({
          kind: 'delete' as const,
          original: makeOriginal(index),
          values: {},
        }))
      : [
          ...Object.entries(changes).map(([i, values]) => ({
            kind: 'update' as const,
            original: makeOriginal(Number(i)),
            values,
          })),
          ...inserts.map((values) => ({ kind: 'insert' as const, values })),
        ]
    let approval: string | false
    try {
      approval = await confirm({
        title: deleteSelection
          ? `Delete ${inputChanges.length} selected rows?`
          : `Apply ${inputChanges.length} changes?`,
        description: `${profile.name} · ${tab.database || profile.database} · ${input.schema}.${input.table} · ${profile.environment}. Changes use primary keys and original values to detect conflicts.`,
        detail: inputChanges
          .map(
            (c) =>
              `${c.kind.toUpperCase()} ${
                c.kind === 'insert'
                  ? JSON.stringify(c.values)
                  : structure?.columns
                      .filter((x) => x.primaryKey)
                      .map((x) => `${x.name}=${displayCell(c.original?.[x.name])}`)
                      .join(', ')
              }${c.kind === 'update' ? ` → ${JSON.stringify(c.values)}` : c.kind === 'delete' ? `\n${JSON.stringify(c.original).slice(0, 2000)}` : ''}`,
          )
          .join('\n'),
        label: deleteSelection ? `Delete ${inputChanges.length} rows` : 'Apply changes',
        typed: profile.environment === 'production' ? input.table : undefined,
        danger: inputChanges.some((change) => change.kind === 'delete'),
      })
    } catch (error) {
      operation.current = null
      toast.error(errorText(error))
      return
    }
    if (
      !approval ||
      !useApp.getState().workspace.tabs.some((current) => current.id === tab.id) ||
      useApp.getState().statuses[profile.id]?.state !== 'connected'
    ) {
      operation.current = null
      return
    }
    setApplying(true)
    const requestId = uid()
    operation.current = requestId
    useApp.getState().setRuntime(tab.id, { running: true, requestId, error: undefined })
    let committed = false
    try {
      const outcome = await api.applyEdits({
        connectionId: profile.id,
        database: tab.database,
        sessionId: tab.id,
        schema: input.schema,
        table: input.table,
        changes: inputChanges,
      })
      committed = true
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      setChanges({})
      setInserts([])
      setSelectedRows(new Set())
      pendingRef.current = 0
      setExactCount(null)
      useApp.getState().setRuntime(tab.id, { pendingEdits: false, result: undefined })
      toast.success(`${outcome.affectedRows} changes applied`)
      const previousSql = useApp.getState().workspace.tabs.find((item) => item.id === tab.id)?.sql || ''
      const result = await api.table(input)
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      useApp
        .getState()
        .setRuntime(tab.id, { running: false, result, transaction: result.transaction, error: undefined })
      if (previousSql === runtime?.result?.tableQuery?.editorSql) updateTableSql(result, previousSql)
      setSelectedRows(new Set())
    } catch (e) {
      await reportError(
        e,
        requestId,
        committed ? 'Changes were applied, but refreshing the table failed. ' : '',
      )
    } finally {
      operation.current = null
      setApplying(false)
    }
  }
  async function countRows() {
    if (demo || operation.current || useApp.getState().runtime[tab.id]?.running || status !== 'connected')
      return
    if (pendingRef.current) {
      toast.info('Apply or discard staged changes before counting server rows.')
      return
    }
    const requestId = uid()
    operation.current = requestId
    setCountRequest(requestId)
    setExactCount(null)
    useApp.getState().setRuntime(tab.id, { running: true, requestId, error: undefined })
    const dialect = profile.engine === 'postgres' ? 'postgres' : 'mariadb'
    try {
      const result = await api.query({
        connectionId: tab.connectionId,
        database: tab.database,
        sessionId: tab.id,
        requestId,
        sql: `SELECT COUNT(*) AS ${quoteIdentifier('row_count', dialect)} FROM ${qualifiedName(input.schema, input.table, dialect)};`,
        maxRows: 1,
        privateSession: true,
      })
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      useApp.getState().setRuntime(tab.id, { running: false, transaction: result.transaction })
      if (result.cancelled) toast.info('Exact count cancelled by the server.')
      else {
        const count = result.sets[0]?.rows[0]?.[0]
        if (typeof count === 'string' || typeof count === 'number') setExactCount(String(count))
        else throw new Error('The server did not return an exact count.')
      }
    } catch (error) {
      await reportError(error, requestId)
    } finally {
      operation.current = null
      setCountRequest(null)
    }
  }
  async function cancelCount() {
    if (!countRequest) return
    try {
      const result = await api.cancel({
        connectionId: tab.connectionId,
        sessionId: tab.id,
        requestId: countRequest,
      })
      toast.info(result.message)
    } catch (error) {
      toast.error(errorText(error))
    }
  }
  function beginEdit(row: number, column: number) {
    if (operation.current || useApp.getState().runtime[tab.id]?.running || !displaySet?.rows[row]) return
    const value = displaySet.rows[row][column]
    const binary =
      (value !== null && typeof value === 'object') ||
      binaryType(
        structure?.columns.find((item) => item.name === displaySet.columns[column].name)?.type ||
          displaySet.columns[column].type,
      )
    setEditError('')
    setEdit({
      row,
      column,
      binary,
      isNull: value === null,
      value: value !== null && typeof value === 'object' ? value.base64 : value === null ? '' : String(value),
    })
  }
  function stageEdit() {
    if (!edit || !set) return
    try {
      const name = set.columns[edit.column].name
      const value: Cell = edit.isNull ? null : edit.binary ? decodeBinary(edit.value) : edit.value
      if (pendingRef.current >= 200 && !changes[edit.row])
        throw new Error('Apply or discard this batch before staging more than 200 rows.')
      setChanges((current) => {
        const next = { ...current }
        const row = { ...next[edit.row] }
        if (JSON.stringify(value) === JSON.stringify(set.rows[edit.row][edit.column])) delete row[name]
        else row[name] = value
        if (Object.keys(row).length) next[edit.row] = row
        else delete next[edit.row]
        return next
      })
      setEdit(null)
    } catch (error) {
      setEditError(errorText(error))
    }
  }
  function stageInsert() {
    try {
      if (pendingRef.current >= 200)
        throw new Error('Apply or discard this batch before staging more than 200 rows.')
      const values: Record<string, Cell> = {}
      for (const column of structure?.columns || []) {
        if (insertNulls.has(column.name)) values[column.name] = null
        else if (column.name in insertValues)
          values[column.name] = binaryType(column.type)
            ? decodeBinary(insertValues[column.name])
            : insertValues[column.name]
      }
      setInserts((current) => [...current, values])
      setInsertValues({})
      setInsertNulls(new Set())
      setInsertOpen(false)
      setEditError('')
    } catch (error) {
      setEditError(errorText(error))
    }
  }
  const tableView = (
    <div className="query-workspace">
      <div className="toolbar">
        <span className="toolbar-title">
          <Table2 />
          {tab.table}
        </span>
        <button className={`result-tab ${view === 'data' ? 'active' : ''}`} onClick={() => setView('data')}>
          Data
        </button>
        <button
          className={`result-tab ${view === 'structure' ? 'active' : ''}`}
          onClick={() => setView('structure')}
        >
          Structure
        </button>
        <div className="toolbar-spacer" />
        {countRequest ? (
          <Button variant="outline" size="sm" onClick={() => void cancelCount()}>
            <CircleStop />
            Cancel count
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            title="Run an exact COUNT(*) for all rows in this table. May scan a large table."
            disabled={busy || demo || status !== 'connected' || pending > 0}
            onClick={() => void countRows()}
          >
            <Calculator />
            Count rows
          </Button>
        )}
        {editable && structure && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending > 0 || busy || runtime?.transaction !== 'idle'}
            onClick={() => setImportOpen(true)}
          >
            <Upload />
            Import CSV
          </Button>
        )}
        {editable && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || pending >= 200}
              onClick={() => {
                setEditError('')
                setInsertOpen(true)
              }}
            >
              <Plus />
              Insert row
            </Button>
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || demo || status !== 'connected'}
          onClick={() => void load()}
        >
          <RefreshCw className={runtime?.running ? 'spin' : ''} />
          Refresh
        </Button>
      </div>
      {pending > 0 && (
        <div className="pending-bar">
          <span>
            {pending} changes ready to apply{inserts.length ? ` · ${inserts.length} new rows` : ''}
          </span>
          <div className="toolbar-spacer" />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setChanges({})
              setInserts([])
            }}
          >
            <Undo2 />
            Discard
          </Button>
          <Button size="sm" disabled={busy || status !== 'connected'} onClick={() => void apply()}>
            <Check />
            {applying ? 'Applying…' : 'Review & apply'}
          </Button>
        </div>
      )}
      {runtime?.error && <ErrorPanel message={runtime.error} />}
      {view === 'structure' ? (
        <div className="library">
          <div className="library-header">
            <div>
              <h1>Table structure</h1>
              <p>
                {input.schema}.{input.table}
              </p>
            </div>
            <div className="toolbar-spacer" />
            <CopyButton label="Copy DDL" value={structure?.ddl || ''} />
          </div>
          {structure ? (
            <>
              <table className="data-grid">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {structure.columns.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.primaryKey ? '⌘ ' : ''}
                        {c.name}
                      </td>
                      <td>{c.type}</td>
                      <td>{c.nullable ? 'Yes' : 'No'}</td>
                      <td className="mono">{c.defaultValue ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mt-6 mb-3">Indexes & constraints</h3>
              {[...structure.indexes, ...structure.constraints].map((c, i) => (
                <div className="library-row" key={i}>
                  <Columns3 />
                  <div className="library-row-content">
                    <strong>{c.name}</strong>
                    <pre>{c.definition}</pre>
                  </div>
                </div>
              ))}
              <pre className="mono whitespace-pre-wrap mt-6">{structure.ddl}</pre>
            </>
          ) : (
            <p className="field-note">
              {demo
                ? 'Structure inspection is available for connected databases.'
                : 'Connect and refresh to load table metadata.'}
            </p>
          )}
        </div>
      ) : runtime?.running && !displaySet ? (
        <Loading text="Loading table page…" />
      ) : displaySet ? (
        <>
          <DataGrid
            serverSort
            tab={tab}
            set={displaySet}
            modified={modified}
            selectedRows={selectedRows}
            onSelectedRowsChange={setSelectedRows}
            selectionDisabled={busy}
            onDeleteSelected={() => void apply([...selectedRows].sort((a, b) => a - b))}
            deleteDisabled={
              !editable || busy || pending > 0 || status !== 'connected' || runtime?.transaction !== 'idle'
            }
            onEdit={editable && !busy ? beginEdit : undefined}
            onSort={
              demo || busy || status !== 'connected'
                ? undefined
                : (column, direction) =>
                    void guardNavigation(() => {
                      void load({ sort: column, direction, offset: 0 })
                    })
            }
            sort={sort}
            onServerFilter={
              demo || busy || status !== 'connected'
                ? undefined
                : () => void guardNavigation(() => setFilterOpen(true))
            }
          />
          {filter && (
            <div className="hint-bar">
              <Filter />
              {filter.column} {filter.operator} {filter.value}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void guardNavigation(() => {
                    void load({ filter: undefined, offset: 0 })
                  })
                }
              >
                Clear filter
              </Button>
            </div>
          )}
          <div className="results-footer">
            <span>{displaySet.rows.length} rows loaded</span>
            {exactCount !== null && (
              <span title="Exact snapshot of all table rows, ignoring the page filter">
                Exact total: {exactCount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              </span>
            )}
            {countRequest && (
              <span className="status-item">
                <Calculator />
                Counting all rows…
              </span>
            )}
            <span>{runtime?.result?.durationMs.toFixed(1)} ms</span>
            {structure?.isHypertable && !sort && (
              <span title="No automatic sort across the full history. Rows and offset pages may change order. Click a column header to sort; sorting large histories can be expensive.">
                Unsorted preview · row order may change
              </span>
            )}
            <span>
              {editable
                ? 'Double-click a cell to stage an edit'
                : profile.readOnly
                  ? 'Read-only safeguard'
                  : demo
                    ? 'Example data'
                    : 'Read-only · no reliable primary key'}
            </span>
            <div className="pagination">
              <select
                aria-label="Page size"
                disabled={busy || demo}
                value={pageSize}
                onChange={(e) =>
                  void guardNavigation(() => {
                    const limit = Number(e.target.value)
                    void load({ limit, offset: 0 })
                  })
                }
              >
                {[50, 100, 200, 500, 1000].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <span>
                {displaySet.rows.length ? offset + 1 : 0}–{offset + displaySet.rows.length}
              </span>
              <IconButton
                label="Previous page"
                disabled={offset === 0 || demo || busy}
                onClick={() =>
                  void guardNavigation(() => {
                    const next = Math.max(0, offset - pageSize)
                    void load({ offset: next })
                  })
                }
              >
                <ChevronLeft />
              </IconButton>
              <IconButton
                label="Next page"
                disabled={displaySet.rows.length < pageSize || demo || busy}
                onClick={() =>
                  void guardNavigation(() => {
                    void load({ offset: offset + pageSize })
                  })
                }
              >
                <ChevronRight />
              </IconButton>
            </div>
          </div>
          {!structure?.columns.some((c) => c.primaryKey) && !demo && (
            <div className="hint-bar">
              No primary key: row order may change between pages. Editing is disabled.
            </div>
          )}
        </>
      ) : (
        <div className="center-empty">
          <Database />
          <h3>{status === 'connected' ? 'No data loaded' : 'Connection required'}</h3>
          <p>
            Connect {profile.name} to browse {tab.table}. The connection target is fixed to this tab.
          </p>
        </div>
      )}
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) setEdit(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {edit && set?.columns[edit.column].name}</DialogTitle>
            <DialogDescription>
              This edit stays local until you review and apply it. Values are sent as parameters.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <FieldGroup>
              <Field>
                <FieldLabel>
                  Value · {set?.columns[edit.column].type}
                  {edit.binary ? ' · Base64' : ''}
                </FieldLabel>
                <textarea
                  aria-label="Cell value"
                  rows={6}
                  maxLength={edit.binary ? 2000000 : 1000000}
                  className="mono"
                  disabled={edit.isNull}
                  value={edit.value}
                  onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                />
                {edit.binary && (
                  <p className="field-note">
                    Binary bytes are edited as Base64. For example, AP+A preserves bytes 00 FF 80. An empty
                    Base64 value creates zero bytes.
                  </p>
                )}
              </Field>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={edit.isNull}
                  onChange={(e) => setEdit({ ...edit, isNull: e.target.checked })}
                />
                Set to NULL
              </label>
              {editError && <ErrorPanel message={editError} />}
              <div className="dialog-actions">
                <Button variant="outline" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
                <Button onClick={stageEdit}>Stage change</Button>
              </div>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={insertOpen} onOpenChange={setInsertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert row</DialogTitle>
            <DialogDescription>
              Enter only the values you want to set. Untouched columns use database defaults. A blank entered
              value is an empty string. Binary fields use Base64; NULL is an explicit choice.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {structure?.columns.map((c) => (
              <Field key={c.name}>
                <FieldLabel>
                  {c.name} · {c.type}
                  {c.primaryKey ? ' · primary key' : ''}
                  {binaryType(c.type) ? ' · Base64' : ''}
                </FieldLabel>
                <Input
                  aria-label={`New ${c.name}`}
                  placeholder={
                    binaryType(c.type)
                      ? 'Base64 bytes or leave untouched'
                      : c.defaultValue || 'Database default'
                  }
                  disabled={insertNulls.has(c.name)}
                  maxLength={binaryType(c.type) ? 2000000 : 1000000}
                  value={insertValues[c.name] || ''}
                  onChange={(e) => setInsertValues((v) => ({ ...v, [c.name]: e.target.value }))}
                />
                {c.nullable && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      aria-label={`New ${c.name} is NULL`}
                      checked={insertNulls.has(c.name)}
                      onChange={(event) =>
                        setInsertNulls((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(c.name)
                          else next.delete(c.name)
                          return next
                        })
                      }
                    />
                    Set to NULL
                  </label>
                )}
              </Field>
            ))}
          </FieldGroup>
          {editError && <ErrorPanel message={editError} />}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setInsertOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!Object.keys(insertValues).length && !insertNulls.size} onClick={stageInsert}>
              Stage insert
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {importOpen && structure && (
        <CsvImportDialog
          tab={tab}
          profile={profile}
          structure={structure}
          onClose={() => setImportOpen(false)}
          onBusyChange={(running) => {
            operation.current = running ? 'csv-import' : null
            useApp.getState().setRuntime(tab.id, { running })
          }}
          onImported={() => {
            setExactCount(null)
            void load()
          }}
        />
      )}
      <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Filter table on server</DialogTitle>
            <DialogDescription>
              Filter values are parameterized. Only the matching page is fetched.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Column</FieldLabel>
              <select
                aria-label="Filter column"
                value={filterColumn}
                onChange={(e) => setFilterColumn(e.target.value)}
              >
                {structure?.columns.map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel>Condition</FieldLabel>
              <select
                aria-label="Filter condition"
                value={filterOperator}
                onChange={(e) => setFilterOperator(e.target.value as typeof filterOperator)}
              >
                <option value="contains">contains</option>
                <option value="equals">equals</option>
                <option value="is null">is NULL</option>
              </select>
            </Field>
            {filterOperator !== 'is null' && (
              <Field>
                <FieldLabel>Value</FieldLabel>
                <Input
                  aria-label="Filter value"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                />
              </Field>
            )}
          </FieldGroup>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                const next = { column: filterColumn, operator: filterOperator, value: filterValue }
                void load({ filter: next, offset: 0 })
                setFilterOpen(false)
              }}
            >
              <Filter />
              Apply filter
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
  return (
    <Suspense fallback={<Loading text="Loading table editor…" />}>
      <QueryEditor
        tab={tab}
        profile={profile}
        visible={visible}
        onSave={onSave}
        resultView={queryMode ? undefined : tableView}
        disableExecute={busy || pending > 0}
        beforeExecute={() => {
          if (operation.current || pendingRef.current) {
            toast.info('Apply or discard staged changes before running SQL.')
            return false
          }
          return true
        }}
        onExecute={() => {
          setQueryMode(true)
          setSelectedRows(new Set())
          useApp.getState().setRuntime(tab.id, { tableQueryMode: true, result: undefined })
        }}
        toolbarActions={
          queryMode ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || status !== 'connected' || runtime?.transaction !== 'idle'}
              title={
                runtime?.transaction !== 'idle'
                  ? 'Commit or roll back this tab’s transaction before returning to the table.'
                  : undefined
              }
              onClick={() => void load()}
            >
              <Table2 data-icon="inline-start" />
              Return to table
            </Button>
          ) : undefined
        }
      />
    </Suspense>
  )
}
