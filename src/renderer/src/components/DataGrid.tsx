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
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Cell, ResultSet, WorkspaceTab } from '@shared/contracts'
import {
  compareGridRows,
  gridClipboard,
  gridColumnLabel,
  inspectCell,
  matchesGridFilter,
  type GridFilter,
  type GridSort,
} from '@shared/result-grid'
import { api } from '../lib/api'
import { cn, displayCell, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { CopyButton, IconButton } from './common'
import { GridColumnManager, GridViewOptions } from './GridControls'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
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
  const [localSorts, setLocalSorts] = useState<GridSort[]>([])
  const [localFilters, setLocalFilters] = useState<GridFilter[]>([])
  const [filterMatch, setFilterMatch] = useState<'all' | 'any'>('all')
  const [columnManager, setColumnManager] = useState(false)
  const [viewOptions, setViewOptions] = useState(false)
  const [viewer, setViewer] = useState<{ value: Cell; column: number } | null>(null)
  const [viewerMode, setViewerMode] = useState<'raw' | 'json' | 'hex'>('raw')
  const remoteSort = serverSort || !!onSort
  const sortFor = (index: number) =>
    remoteSort
      ? sort?.column === set.columns[index].name
        ? sort
        : undefined
      : localSorts.find((item) => item.index === index && item.column === set.columns[index].name)
  const chooseSort = (index: number, direction: 'asc' | 'desc', append = false) => {
    const column = set.columns[index].name
    if (remoteSort) onSort?.(column, direction)
    else
      setLocalSorts((previous) =>
        append
          ? [...previous.filter((item) => item.index !== index), { column, index, direction }].slice(-8)
          : [{ column, index, direction }],
      )
  }
  const isSorted = (index: number) => !!sortFor(index)
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
        .filter(
          (row) =>
            !localFilters.length ||
            (filterMatch === 'all'
              ? localFilters.every((condition) => matchesGridFilter(row.values, set.columns, condition))
              : localFilters.some((condition) => matchesGridFilter(row.values, set.columns, condition))),
        )
        .sort((a, b) => compareGridRows(a, b, set.columns, remoteSort ? [] : localSorts)),
    [set.rows, set.columns, filter, remoteSort, localSorts, localFilters, filterMatch],
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
  const unpinnedColumns = table.getVisibleLeafColumns()
  const visiblePinned = pinned.filter((id) => unpinnedColumns.some((column) => column.id === id))
  const visibleColumns = [
    ...visiblePinned.map((id) => table.getColumn(id)!),
    ...unpinnedColumns.filter((column) => !visiblePinned.includes(column.id)),
  ]
  const [headerHeight, setHeaderHeight] = useState(44)
  const [minimumGridHeight, setMinimumGridHeight] = useState(240)
  const showSelectionBar = checkedIndices.length > 0 || !!onDeleteSelected || !!onEdit
  useEffect(() => {
    const scroller = container.current
    const region = scroller?.parentElement
    const header = scroller?.querySelector('thead')
    if (!scroller || !region || !header) return
    const chrome = [...region.children].filter((element) => element !== scroller)
    const measure = () => {
      const measuredHeader = Math.ceil(header.getBoundingClientRect().height)
      // Centered scroll-into-view must land below the sticky header, with a full row visible.
      const minimumViewport = Math.max(128, measuredHeader * 2 + 32)
      setHeaderHeight(measuredHeader)
      setMinimumGridHeight(
        Math.ceil(
          chrome.reduce((height, element) => height + element.getBoundingClientRect().height, 0) +
            minimumViewport,
        ),
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    chrome.forEach((element) => observer.observe(element))
    measure()
    return () => observer.disconnect()
  }, [showSelectionBar])
  const virtual = useVirtualizer({
    count: model.length,
    getScrollElement: () => container.current,
    estimateSize: () => (density === 'compact' ? 25 : 31),
    overscan: 12,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
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
  async function copy(format: 'tsv' | 'csv' | 'json' = 'tsv', wholeRows = false) {
    if (!checkedIndices.length || !visibleColumns.length) return
    const cellRange = !wholeRows && selection && rangeStart !== undefined && rangeEnd !== undefined
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
    try {
      const output = gridClipboard(
        format,
        copyColumns.map((column) => set.columns[Number(column.id)]),
        copyRows.map((row) => copyColumns.map((column) => row[Number(column.id)])),
      )
      await api.copyText(output)
      toast.success(`${wholeRows ? 'Selected rows' : 'Selection'} copied as ${format.toUpperCase()}`)
    } catch (cause) {
      toast.error(errorText(cause))
    }
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
            visiblePinned
              .slice(0, visiblePinned.indexOf(id))
              .reduce((sum, p) => sum + (table.getColumn(p)?.getSize() || 0), 0),
          zIndex: 3,
          background: 'var(--raised)',
        }
      : {}
  return (
    <div className="results-content" style={{ minHeight: minimumGridHeight }}>
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
          <Button variant="outline" size="sm" onClick={() => setViewOptions(true)}>
            <Filter />
            Loaded-page view{localFilters.length ? ` (${localFilters.length})` : ''}
          </Button>
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
          <Button variant="outline" size="sm" onClick={() => setColumnManager(true)}>
            <Columns3 />
            Columns
          </Button>
          <IconButton
            label={inspector ? 'Hide inspector' : 'Show inspector'}
            onClick={() => useApp.getState().setSettings({ inspectorOpen: !inspector })}
          >
            <PanelRight />
          </IconButton>
        </div>
        <div className="hint-bar">
          {remoteSort
            ? 'Column-header sort: server-side.'
            : `Sort: loaded rows only${localSorts.length ? ` · ${localSorts.length} column priority` : ''}.`}{' '}
          Filters here cover loaded rows. Exports include all original loaded columns; JSON preserves types
          and duplicate names.
        </div>
        {showSelectionBar && (
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!checkedIndices.length}>
                  Copy
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Loaded selection · visible columns</DropdownMenuLabel>
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => void copy()}>Copy cells · TSV</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copy('csv')}>Copy cells · CSV</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copy('json')}>Copy cells · JSON</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copy('json', true)}>
                    Copy selected rows · JSON
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              disabled={!selection || !selected || !visibleColumns[selection.endCol]}
              onClick={() => {
                if (selection && selected && visibleColumns[selection.endCol]) {
                  setViewer({
                    value: selected[Number(visibleColumns[selection.endCol].id)],
                    column: Number(visibleColumns[selection.endCol].id),
                  })
                  setViewerMode('raw')
                }
              }}
            >
              View cell
            </Button>
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
          style={{ scrollPaddingTop: headerHeight }}
          tabIndex={0}
          aria-label="Query results. Arrow keys navigate; Shift selects a range; Control or Command C copies."
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
                      isSorted(Number(c.id))
                        ? sortFor(Number(c.id))?.direction === 'asc'
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
                      if (!table.getAllLeafColumns().some((column) => column.id === from) || from === c.id)
                        return
                      const list = table
                        .getAllLeafColumns()
                        .map((x) => x.id)
                        .filter((x) => x !== from)
                      list.splice(list.indexOf(c.id), 0, from)
                      setOrder(list)
                      setSelection(null)
                    }}
                  >
                    <div className="flex items-center gap-1">
                      <button
                        className="column-name flex min-w-0 items-center gap-1 text-left"
                        disabled={remoteSort && !onSort}
                        title={
                          remoteSort
                            ? 'Sort on server'
                            : 'Sort loaded rows. Shift-click adds a sort priority.'
                        }
                        onClick={(event) =>
                          chooseSort(
                            Number(c.id),
                            isSorted(Number(c.id)) && sortFor(Number(c.id))?.direction === 'asc'
                              ? 'desc'
                              : 'asc',
                            event.shiftKey,
                          )
                        }
                      >
                        {set.columns[Number(c.id)].key && <KeyRound />}
                        <span className="truncate">{set.columns[Number(c.id)].name}</span>
                        {!remoteSort && localSorts.length > 1 && isSorted(Number(c.id)) && (
                          <sup>{localSorts.findIndex((item) => item.index === Number(c.id)) + 1}</sup>
                        )}
                      </button>
                      <span className="column-sort-actions">
                        {(['asc', 'desc'] as const).map((direction) => (
                          <button
                            key={direction}
                            type="button"
                            aria-label={`Sort ${gridColumnLabel(set.columns, Number(c.id))} ${direction === 'asc' ? 'ascending' : 'descending'}`}
                            title={`${direction === 'asc' ? 'Ascending' : 'Descending'} · ${remoteSort ? 'server-side sort' : 'loaded rows only'}`}
                            aria-pressed={sortFor(Number(c.id))?.direction === direction}
                            disabled={remoteSort && !onSort}
                            onClick={(event) => chooseSort(Number(c.id), direction, event.shiftKey)}
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
                <tr
                  aria-hidden
                  style={{ height: Math.max(0, virtual.getVirtualItems()[0].start - headerHeight) }}
                >
                  <td
                    colSpan={visibleColumns.length + 2}
                    style={{
                      height: Math.max(0, virtual.getVirtualItems()[0].start - headerHeight),
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
                        virtual.getTotalSize() - (virtual.getVirtualItems().at(-1)?.end || 0) + headerHeight,
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
              <h3>{filter || localFilters.length ? 'No matching rows' : 'No rows returned'}</h3>
              <p>
                {filter || localFilters.length
                  ? 'Try a different filter. This search includes only loaded rows.'
                  : 'The statement completed without returning data rows.'}
              </p>
            </div>
          )}
        </div>
        {(filter || localFilters.length > 0) && (
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
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`View complete ${gridColumnLabel(set.columns, index)} value`}
                  onClick={() => {
                    setViewer({ value: selected[index], column: index })
                    setViewerMode('raw')
                  }}
                >
                  View
                </Button>
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
      {columnManager && (
        <GridColumnManager
          columns={set.columns}
          items={table.getAllLeafColumns().map((column) => ({
            id: column.id,
            width: column.getSize(),
            visible: column.getIsVisible(),
            pinned: pinned.includes(column.id),
          }))}
          onClose={() => setColumnManager(false)}
          onChange={(id, patch) => {
            setSelection(null)
            if (patch.visible !== undefined) table.getColumn(id)?.toggleVisibility(patch.visible)
            if (patch.width !== undefined) setWidths((current) => ({ ...current, [id]: patch.width! }))
            if (patch.pinned !== undefined)
              setPinned((current) =>
                patch.pinned
                  ? [...current.filter((item) => item !== id), id]
                  : current.filter((item) => item !== id),
              )
          }}
          onMove={(id, delta) => {
            const list = table.getAllLeafColumns().map((column) => column.id)
            const from = list.indexOf(id)
            const to = from + delta
            if (from < 0 || to < 0 || to >= list.length) return
            ;[list[from], list[to]] = [list[to], list[from]]
            setOrder(list)
            setSelection(null)
          }}
        />
      )}
      {viewOptions && (
        <GridViewOptions
          columns={set.columns}
          filters={localFilters}
          match={filterMatch}
          sorts={localSorts}
          remoteSort={remoteSort}
          onFilters={(filters, match) => {
            setLocalFilters(filters)
            setFilterMatch(match)
          }}
          onSorts={setLocalSorts}
          onClose={() => setViewOptions(false)}
        />
      )}
      {viewer && (
        <Dialog open onOpenChange={(open) => !open && setViewer(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Cell value · {gridColumnLabel(set.columns, viewer.column)}</DialogTitle>
              <DialogDescription>
                {set.columns[viewer.column].type} · complete loaded cell. Previewing never changes the value.
              </DialogDescription>
            </DialogHeader>
            <select
              aria-label="Cell viewer format"
              value={viewerMode}
              onChange={(event) => setViewerMode(event.target.value as typeof viewerMode)}
            >
              <option value="raw">
                {viewer.value && typeof viewer.value === 'object' ? 'Base64' : 'Raw / multiline'}
              </option>
              {viewer.value && typeof viewer.value === 'object' ? (
                <option value="hex">Hexadecimal</option>
              ) : (
                <option value="json">Formatted JSON</option>
              )}
            </select>
            <pre
              aria-label="Complete cell value"
              className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded border p-3"
            >
              {inspectCell(viewer.value, viewerMode)}
            </pre>
            <CopyButton value={gridClipboard('json', [set.columns[viewer.column]], [[viewer.value]])} />
            <p className="field-note">
              Copy uses typed JSON to distinguish NULL, empty text and binary values.
            </p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
