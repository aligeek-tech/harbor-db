import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
  type ColumnSizingState,
  type VisibilityState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  Download,
  Filter,
  KeyRound,
  PanelRight,
  Pin,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Cell, ResultSet, WorkspaceTab } from '@shared/contracts'
import { compareCells } from '@shared/result-sort'
import { api } from '../lib/api'
import { cn, displayCell, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { CopyButton, IconButton } from './common'
interface GridProps {
  set: ResultSet
  tab: WorkspaceTab
  onEdit?: (row: number, column: number) => void
  onSelectRow?: (row: number) => void
  onSort?: (column: string, direction: 'asc' | 'desc') => void
  sort?: { column: string; direction: 'asc' | 'desc' }
  serverSort?: boolean
  modified?: Set<string>
  deleted?: Set<number>
  onServerFilter?: () => void
  selectedRows?: Set<number>
  onSelectedRowsChange?: (rows: Set<number>) => void
  onDeleteSelected?: () => void
  selectionDisabled?: boolean
  deleteDisabled?: boolean
}
const noRowsSelected = new Set<number>()
const rowHeaderWidth = 74
type CellSelection = { row: number; col: number; endRow: number; endCol: number }
export function DataGrid({
  set,
  tab,
  onEdit,
  onSelectRow,
  onSort,
  sort,
  serverSort = false,
  modified,
  deleted,
  onServerFilter,
  selectedRows,
  onSelectedRowsChange,
  onDeleteSelected,
  selectionDisabled = false,
  deleteDisabled = false,
}: GridProps) {
  const [localSort, setLocalSort] = useState<{ column: string; direction: 'asc' | 'desc' }>()
  const remoteSort = serverSort || !!onSort
  const activeSort = remoteSort ? sort : localSort
  const chooseSort = (column: string, direction: 'asc' | 'desc') => {
    if (remoteSort) onSort?.(column, direction)
    else setLocalSort({ column, direction })
  }
  const inspector = useApp((s) => s.workspace.settings.inspectorOpen)
  const density = useApp((s) => s.workspace.settings.density)
  const [filter, setFilter] = useState('')
  const [selection, setSelection] = useState<CellSelection | null>(null)
  const selectionAnchor = useRef<number | null>(null)
  const [localRowSelection, setLocalRowSelection] = useState(() => ({
    source: set.rows,
    rows: new Set<number>(),
  }))
  const checkedRows =
    selectedRows ?? (localRowSelection.source === set.rows ? localRowSelection.rows : noRowsSelected)
  const checkedIndices = useMemo(
    () =>
      [...checkedRows]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < set.rows.length)
        .sort((a, b) => a - b),
    [checkedRows, set.rows.length],
  )
  const selectionLocked = selectionDisabled || (selectedRows !== undefined && !onSelectedRowsChange)
  const [widths, setWidths] = useState<ColumnSizingState>(tab.columnWidths || {})
  const [visibility, setVisibility] = useState<VisibilityState>(
    Object.fromEntries((tab.hiddenColumns || []).map((c) => [c, false])),
  )
  const [order, setOrder] = useState<string[]>([])
  const [pinned, setPinned] = useState<string[]>([])
  const container = useRef<HTMLDivElement>(null)
  const columns = useMemo<ColumnDef<Cell[]>[]>(
    () =>
      set.columns.map((c, i) => ({
        id: String(i),
        accessorFn: (row) => row[i],
        header: c.name,
        size: c.type.includes('time') ? 210 : c.name === 'id' ? 100 : 170,
        minSize: 75,
        maxSize: 700,
      })),
    [set.columns],
  )
  const filtered = useMemo(
    () =>
      set.rows
        .map((values, index) => ({ values, index }))
        .filter(
          (r) => !filter || r.values.some((v) => displayCell(v).toLowerCase().includes(filter.toLowerCase())),
        )
        .sort((a, b) => {
          if (remoteSort || !localSort) return 0
          const index = set.columns.findIndex((column) => column.name === localSort.column)
          if (index < 0) return 0
          return (
            compareCells(
              a.values[index],
              b.values[index],
              /int|numeric|decimal|float|double|real/i.test(set.columns[index].type),
            ) * (localSort.direction === 'asc' ? 1 : -1)
          )
        }),
    [set.rows, set.columns, filter, remoteSort, localSort],
  )
  const rows = useMemo(() => filtered.map((r) => r.values), [filtered])
  const filteredPositions = useMemo(
    () => new Map(filtered.map((row, position) => [row.index, position])),
    [filtered],
  )
  const visibleCheckedCount = useMemo(
    () => filtered.reduce((count, row) => count + Number(checkedRows.has(row.index)), 0),
    [filtered, checkedRows],
  )
  const allVisibleChecked = filtered.length > 0 && visibleCheckedCount === filtered.length
  function changeCheckedRows(
    next: Set<number>,
    cells: CellSelection | null = null,
    anchor: number | null = null,
  ) {
    if (selectionLocked) return
    if (selectedRows === undefined) setLocalRowSelection({ source: set.rows, rows: next })
    onSelectedRowsChange?.(next)
    setSelection(cells)
    selectionAnchor.current = anchor
  }
  function toggleCheckedRow(index: number, checked: boolean) {
    const next = new Set(checkedIndices)
    if (checked) next.add(index)
    else next.delete(index)
    changeCheckedRows(next, null, checked ? index : null)
  }
  function toggleVisibleRows(checked: boolean) {
    const next = new Set(checkedIndices)
    for (const row of filtered) {
      if (checked) next.add(row.index)
      else next.delete(row.index)
    }
    changeCheckedRows(next, null, checked ? (filtered[0]?.index ?? null) : null)
  }
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      columnSizing: widths,
      columnVisibility: visibility,
      columnOrder: order,
      columnPinning: { left: pinned, right: [] },
    },
    onColumnSizingChange: setWidths,
    onColumnVisibilityChange: setVisibility,
    onColumnOrderChange: setOrder,
    columnResizeMode: 'onChange',
  })
  const model = table.getRowModel().rows
  const visibleColumns = table.getVisibleLeafColumns()
  const virtual = useVirtualizer({
    count: model.length,
    getScrollElement: () => container.current,
    estimateSize: () => (density === 'compact' ? 25 : 31),
    overscan: 12,
    scrollMargin: 44,
  })
  useEffect(() => {
    const timeout = setTimeout(
      () =>
        useApp.getState().updateTab(tab.id, {
          columnWidths: widths,
          hiddenColumns: Object.keys(visibility).filter((k) => visibility[k] === false),
        }),
      350,
    )
    return () => clearTimeout(timeout)
  }, [widths, visibility, tab.id])
  const activeRow = selection?.endRow ?? selectionAnchor.current
  const inspectedIndex = activeRow !== null && checkedRows.has(activeRow) ? activeRow : checkedIndices[0]
  const selected = inspectedIndex === undefined ? undefined : set.rows[inspectedIndex]
  function choose(row: number, col: number, extend = false, toggle = false) {
    if (selectionLocked || !filtered[row] || !visibleColumns.length) return
    const index = filtered[row].index
    const previousAnchor = selectionAnchor.current
    const anchor =
      extend &&
      previousAnchor !== null &&
      checkedRows.has(previousAnchor) &&
      filteredPositions.has(previousAnchor)
        ? previousAnchor
        : index
    const next = new Set(toggle ? checkedIndices : [])
    if (extend) {
      const start = filteredPositions.get(anchor)!
      for (const item of filtered.slice(Math.min(start, row), Math.max(start, row) + 1)) next.add(item.index)
    } else if (toggle && next.has(index)) next.delete(index)
    else next.add(index)
    changeCheckedRows(
      next,
      toggle
        ? null
        : {
            row: anchor,
            col: extend && selection?.row === anchor ? selection.col : col,
            endRow: index,
            endCol: col,
          },
      next.has(index) ? anchor : null,
    )
    if (next.has(index)) onSelectRow?.(index)
  }
  const rangeStart = selection ? filteredPositions.get(selection.row) : undefined
  const rangeEnd = selection ? filteredPositions.get(selection.endRow) : undefined
  const isSelected = (r: number, c: number) =>
    !!selection &&
    rangeStart !== undefined &&
    rangeEnd !== undefined &&
    checkedRows.has(filtered[r]?.index) &&
    r >= Math.min(rangeStart, rangeEnd) &&
    r <= Math.max(rangeStart, rangeEnd) &&
    c >= Math.min(selection.col, selection.endCol) &&
    c <= Math.max(selection.col, selection.endCol)
  async function copy() {
    if (!checkedIndices.length || !visibleColumns.length) return
    const cellRange = selection && rangeStart !== undefined && rangeEnd !== undefined
    const copyRows = cellRange
      ? filtered
          .slice(Math.min(rangeStart, rangeEnd), Math.max(rangeStart, rangeEnd) + 1)
          .filter((row) => checkedRows.has(row.index))
          .map((row) => row.values)
      : checkedIndices.map((index) => set.rows[index])
    const copyColumns = cellRange
      ? visibleColumns.slice(
          Math.min(selection.col, selection.endCol),
          Math.max(selection.col, selection.endCol) + 1,
        )
      : visibleColumns
    if (!copyRows.length || !copyColumns.length) return
    const output = copyRows
      .map((row) => copyColumns.map((c) => displayCell(row[Number(c.id)])).join('\t'))
      .join('\n')
    await navigator.clipboard.writeText(output)
    toast.success('Selection copied')
  }
  async function exportData(format: 'csv' | 'json', scope: 'loaded results' | 'selected rows') {
    if (scope === 'selected rows' && !checkedIndices.length) return
    const exportRows = scope === 'selected rows' ? checkedIndices.map((index) => set.rows[index]) : set.rows
    try {
      const out = await api.exportResults({
        format,
        scope,
        columns: set.columns,
        rows: exportRows,
        spreadsheetSafe: true,
      })
      if (!out.cancelled) toast.success(`Exported ${exportRows.length} rows`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const stickyStyle = (id: string) =>
    pinned.includes(id)
      ? {
          position: 'sticky' as const,
          left:
            rowHeaderWidth +
            pinned
              .slice(0, pinned.indexOf(id))
              .reduce((sum, p) => sum + (table.getColumn(p)?.getSize() || 0), 0),
          zIndex: 3,
          background: 'var(--raised)',
        }
      : {}
  return (
    <div className="results-content">
      <div className="data-region">
        <div className="grid-toolbar">
          <div className="filter-input">
            <Search />
            <input
              aria-label="Filter loaded results"
              placeholder="Filter loaded results…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {onServerFilter && (
            <IconButton label="Server-side filter" onClick={onServerFilter}>
              <Filter />
            </IconButton>
          )}
          <div className="toolbar-spacer" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!set.rows.length}>
                <Download />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Export scope</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => void exportData('csv', 'loaded results')}>
                  Loaded results · CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportData('json', 'loaded results')}>
                  Loaded results · JSON
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!checkedIndices.length}
                  onSelect={() => void exportData('csv', 'selected rows')}
                >
                  Selected rows · CSV
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!checkedIndices.length}
                  onSelect={() => void exportData('json', 'selected rows')}
                >
                  Selected rows · JSON
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Show columns · drag headers to reorder</DropdownMenuLabel>
              <DropdownMenuGroup>
                {table.getAllLeafColumns().map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(v) => c.toggleVisibility(!!v)}
                  >
                    {set.columns[Number(c.id)].name}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const col = selection && visibleColumns[selection.col]?.id
                    if (col) setPinned((p) => (p.includes(col) ? p.filter((x) => x !== col) : [...p, col]))
                  }}
                >
                  <Pin />
                  Pin / unpin selected column
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {!remoteSort && localSort && <span className="field-note">Sorted loaded rows only</span>}
          <IconButton
            label={inspector ? 'Hide inspector' : 'Show inspector'}
            onClick={() => useApp.getState().setSettings({ inspectorOpen: !inspector })}
          >
            <PanelRight />
          </IconButton>
        </div>
        {(checkedIndices.length > 0 || onDeleteSelected || onEdit) && (
          <div className="grid-selection-bar">
            <span role="status">
              {checkedIndices.length} {checkedIndices.length === 1 ? 'row' : 'rows'} selected
              {checkedIndices.length > visibleCheckedCount && (
                <span className="muted">
                  {' '}
                  · {checkedIndices.length - visibleCheckedCount} hidden by filter
                </span>
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectionLocked || checkedIndices.length === 0}
              onClick={() => changeCheckedRows(new Set())}
            >
              Clear selection
            </Button>
            <div className="toolbar-spacer" />
            {onDeleteSelected && (
              <Button
                variant="destructive"
                size="sm"
                disabled={selectionLocked || deleteDisabled || checkedIndices.length === 0}
                onClick={onDeleteSelected}
              >
                <Trash2 data-icon="inline-start" />
                Delete selected
              </Button>
            )}
          </div>
        )}
        <div
          ref={container}
          className="table-scroll"
          tabIndex={0}
          aria-label="Query results. Arrow keys navigate; Shift selects a range; Control C copies."
          onKeyDown={(e) => {
            if (e.target instanceof HTMLElement && e.target.closest('input, button, select, textarea')) return
            const cursor = selection?.endRow ?? selectionAnchor.current
            const cursorPosition =
              cursor !== null && checkedRows.has(cursor) ? filteredPositions.get(cursor) : undefined
            let row = cursorPosition ?? -1,
              col = selection?.endCol ?? 0
            if (e.key === 'ArrowDown') row++
            else if (e.key === 'ArrowUp') row--
            else if (e.key === 'ArrowLeft') col--
            else if (e.key === 'ArrowRight') col++
            else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
              e.preventDefault()
              void copy()
              return
            } else if (e.key === 'Enter' && onEdit) {
              if (cursorPosition !== undefined && visibleColumns[col] && !selectionLocked) {
                e.preventDefault()
                onEdit(filtered[cursorPosition].index, Number(visibleColumns[col].id))
              }
              return
            } else return
            e.preventDefault()
            if (!rows.length || !visibleColumns.length) return
            row = Math.max(0, Math.min(row, rows.length - 1))
            col = Math.max(0, Math.min(col, visibleColumns.length - 1))
            choose(row, col, e.shiftKey)
            virtual.scrollToIndex(row)
          }}
        >
          <table
            className="data-grid"
            aria-rowcount={rows.length + 1}
            style={{ width: table.getTotalSize() + rowHeaderWidth }}
          >
            <thead>
              <tr>
                <th className="row-selection">
                  <input
                    type="checkbox"
                    className="grid-row-checkbox"
                    aria-label="Select all filtered loaded rows"
                    title={`Select or deselect all ${filtered.length} filtered rows in the loaded results`}
                    checked={allVisibleChecked}
                    ref={(node) => {
                      if (node) node.indeterminate = visibleCheckedCount > 0 && !allVisibleChecked
                    }}
                    disabled={selectionLocked || filtered.length === 0}
                    onChange={(event) => toggleVisibleRows(event.target.checked)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
                </th>
                <th className="row-number">#</th>
                {visibleColumns.map((c) => (
                  <th
                    key={c.id}
                    aria-sort={
                      activeSort?.column === set.columns[Number(c.id)].name
                        ? activeSort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    style={{ width: c.getSize(), ...stickyStyle(c.id) }}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/harbor-column', c.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      const from = e.dataTransfer.getData('text/harbor-column')
                      const list = table
                        .getAllLeafColumns()
                        .map((x) => x.id)
                        .filter((x) => x !== from)
                      list.splice(list.indexOf(c.id), 0, from)
                      setOrder(list)
                    }}
                  >
                    <div className="flex items-center gap-1">
                      <button
                        className="column-name flex min-w-0 items-center gap-1 text-left"
                        disabled={remoteSort && !onSort}
                        onClick={() =>
                          chooseSort(
                            set.columns[Number(c.id)].name,
                            activeSort?.column === set.columns[Number(c.id)].name &&
                              activeSort.direction === 'asc'
                              ? 'desc'
                              : 'asc',
                          )
                        }
                      >
                        {set.columns[Number(c.id)].key && <KeyRound />}
                        <span className="truncate">{set.columns[Number(c.id)].name}</span>
                      </button>
                      <span className="column-sort-actions">
                        {(['asc', 'desc'] as const).map((direction) => (
                          <button
                            key={direction}
                            type="button"
                            aria-label={`Sort ${set.columns[Number(c.id)].name} ${direction === 'asc' ? 'ascending' : 'descending'}`}
                            title={`${direction === 'asc' ? 'Ascending' : 'Descending'} · ${remoteSort ? 'server-side sort' : 'loaded rows only'}`}
                            aria-pressed={
                              activeSort?.column === set.columns[Number(c.id)].name &&
                              activeSort.direction === direction
                            }
                            disabled={remoteSort && !onSort}
                            onClick={() => chooseSort(set.columns[Number(c.id)].name, direction)}
                          >
                            {direction === 'asc' ? <ArrowUp /> : <ArrowDown />}
                          </button>
                        ))}
                      </span>
                    </div>
                    <small>{set.columns[Number(c.id)].type}</small>
                    <div
                      className="column-resizer"
                      onMouseDown={table
                        .getHeaderGroups()[0]
                        .headers.find((h) => h.column.id === c.id)
                        ?.getResizeHandler()}
                      onTouchStart={table
                        .getHeaderGroups()[0]
                        .headers.find((h) => h.column.id === c.id)
                        ?.getResizeHandler()}
                      onDoubleClick={() => c.resetSize()}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {virtual.getVirtualItems().length > 0 && (
                <tr aria-hidden style={{ height: Math.max(0, virtual.getVirtualItems()[0].start - 44) }}>
                  <td
                    colSpan={visibleColumns.length + 2}
                    style={{
                      height: Math.max(0, virtual.getVirtualItems()[0].start - 44),
                      padding: 0,
                      border: 0,
                    }}
                  />
                </tr>
              )}
              {virtual.getVirtualItems().map((v) => {
                const row = model[v.index]
                const originalIndex = filtered[v.index].index
                return (
                  <tr
                    key={row.id}
                    aria-rowindex={v.index + 2}
                    className={cn(
                      checkedRows.has(originalIndex) && 'selected',
                      checkedRows.has(originalIndex) && 'checked-row',
                      deleted?.has(originalIndex) && 'deleted',
                    )}
                  >
                    <td className="row-selection">
                      <input
                        type="checkbox"
                        className="grid-row-checkbox"
                        aria-label={`Select row ${originalIndex + 1}`}
                        checked={checkedRows.has(originalIndex)}
                        disabled={selectionLocked}
                        onChange={(event) => toggleCheckedRow(originalIndex, event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td
                      className="row-number"
                      onClick={(event) => choose(v.index, 0, event.shiftKey, event.ctrlKey || event.metaKey)}
                    >
                      {originalIndex + 1}
                    </td>
                    {visibleColumns.map((c, col) => {
                      const value = rows[v.index][Number(c.id)]
                      const content = displayCell(value)
                      const numeric = /int|numeric|decimal|float|double|real/.test(
                        set.columns[Number(c.id)].type,
                      )
                      return (
                        <td
                          key={c.id}
                          title={content}
                          aria-selected={isSelected(v.index, col)}
                          className={`${isSelected(v.index, col) ? 'selected-cell ' : ''}${value === null ? 'cell-null' : numeric ? 'cell-number' : ''} ${modified?.has(`${originalIndex}:${Number(c.id)}`) ? 'cell-modified' : ''} ${['delivered', 'active', 'completed', 'paid'].includes(content) ? 'success' : ['processing', 'pending'].includes(content) ? 'warning' : ''}`}
                          style={{ width: c.getSize(), ...stickyStyle(c.id) }}
                          onClick={(e) => choose(v.index, col, e.shiftKey, e.ctrlKey || e.metaKey)}
                          onDoubleClick={() => {
                            if (!selectionLocked) onEdit?.(originalIndex, Number(c.id))
                          }}
                        >
                          {content === '' ? (
                            <span className="muted" title="Empty string">
                              ''
                            </span>
                          ) : (
                            content
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {virtual.getVirtualItems().length > 0 && (
                <tr aria-hidden>
                  <td
                    colSpan={visibleColumns.length + 2}
                    style={{
                      height: Math.max(
                        0,
                        virtual.getTotalSize() - (virtual.getVirtualItems().at(-1)?.end || 0) + 44,
                      ),
                      padding: 0,
                      border: 0,
                    }}
                  />
                </tr>
              )}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="center-empty">
              <Search />
              <h3>{filter ? 'No matching rows' : 'No rows returned'}</h3>
              <p>
                {filter
                  ? 'Try a different filter. This search includes only loaded rows.'
                  : 'The statement completed without returning data rows.'}
              </p>
            </div>
          )}
        </div>
        {filter && (
          <div className="hint-bar">
            {rows.length} matching rows in {set.rows.length} loaded results
          </div>
        )}
      </div>
      {inspector && (
        <aside className="inspector">
          <div className="inspector-title">
            ROW DETAILS
            <IconButton
              label="Close inspector"
              onClick={() => useApp.getState().setSettings({ inspectorOpen: false })}
            >
              <PanelRight />
            </IconButton>
          </div>
          {selected ? (
            set.columns.map((column, index) => (
              <div className="inspector-field" key={index}>
                <label>
                  <span>{column.name}</span>
                  <small>{column.type}</small>
                </label>
                <CopyButton value={displayCell(selected[index])} />
                <div className={`inspector-value ${selected[index] === null ? 'muted' : ''}`}>
                  {displayCell(selected[index]) || "''"}
                </div>
              </div>
            ))
          ) : (
            <p className="field-note">Select a cell to inspect its complete value.</p>
          )}
        </aside>
      )}
    </div>
  )
}
