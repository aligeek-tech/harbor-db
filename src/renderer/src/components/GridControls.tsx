import { useState } from 'react'
import type { ResultColumn } from '@shared/contracts'
import { gridColumnLabel, gridFilterOperators, type GridFilter, type GridSort } from '@shared/result-grid'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

export function GridColumnManager({
  columns,
  items,
  onChange,
  onMove,
  onClose,
}: {
  columns: ResultColumn[]
  items: { id: string; width: number; visible: boolean; pinned: boolean }[]
  onChange: (id: string, patch: { width?: number; visible?: boolean; pinned?: boolean }) => void
  onMove: (id: string, delta: number) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const matches = items.filter((item) =>
    `${columns[Number(item.id)].name} ${columns[Number(item.id)].type}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Result columns</DialogTitle>
          <DialogDescription>
            Search, resize, reorder, hide or pin the loaded result columns. Duplicate names keep their
            original column number. Pinned columns appear first.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search result columns"
          placeholder="Column name or type…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex flex-col gap-3">
          {matches.map((item) => {
            const label = gridColumnLabel(columns, Number(item.id))
            const position = items.findIndex((column) => column.id === item.id)
            return (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 rounded border p-3"
                aria-label={`Column settings ${label}`}
              >
                <span className="min-w-32 flex-1">
                  {label}
                  <small className="muted block">{columns[Number(item.id)].type}</small>
                </span>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={item.visible}
                    onChange={(event) => onChange(item.id, { visible: event.target.checked })}
                    aria-label={`Show ${label}`}
                  />
                  Show
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={item.pinned}
                    onChange={(event) => onChange(item.id, { pinned: event.target.checked })}
                    aria-label={`Pin ${label}`}
                  />
                  Pin
                </label>
                <label className="field-note">
                  Width
                  <Input
                    type="number"
                    min={75}
                    max={700}
                    className="w-20"
                    aria-label={`Width ${label}`}
                    value={item.width}
                    onChange={(event) => {
                      const width = Number(event.target.value)
                      if (width >= 75 && width <= 700) onChange(item.id, { width })
                    }}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${label} left`}
                  disabled={position === 0}
                  onClick={() => onMove(item.id, -1)}
                >
                  ←
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${label} right`}
                  disabled={position === items.length - 1}
                  onClick={() => onMove(item.id, 1)}
                >
                  →
                </Button>
              </div>
            )
          })}
        </div>
        {!matches.length && <p role="status">No matching columns.</p>}
      </DialogContent>
    </Dialog>
  )
}

export function GridViewOptions({
  columns,
  filters,
  match,
  sorts,
  remoteSort,
  onFilters,
  onSorts,
  onClose,
}: {
  columns: ResultColumn[]
  filters: GridFilter[]
  match: 'all' | 'any'
  sorts: GridSort[]
  remoteSort: boolean
  onFilters: (filters: GridFilter[], match: 'all' | 'any') => void
  onSorts: (sorts: GridSort[]) => void
  onClose: () => void
}) {
  const columnOptions = columns.map((column, index) => (
    <option key={index} value={index}>
      {gridColumnLabel(columns, index)}
    </option>
  ))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Loaded-page view</DialogTitle>
          <DialogDescription>
            These filters and sorts affect only rows already loaded. They do not fetch rows or change data.
            Server-side filters are separate.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <strong>Filters</strong>
          <select
            aria-label="Loaded filter match"
            value={match}
            onChange={(event) => onFilters(filters, event.target.value as 'all' | 'any')}
          >
            <option value="all">Match all conditions</option>
            <option value="any">Match any condition</option>
          </select>
        </div>
        {filters.map((filter, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Loaded filter ${index + 1} column`}
              value={filter.index}
              onChange={(event) =>
                onFilters(
                  filters.map((item, position) =>
                    position === index ? { ...item, index: Number(event.target.value) } : item,
                  ),
                  match,
                )
              }
            >
              {columnOptions}
            </select>
            <select
              aria-label={`Loaded filter ${index + 1} operator`}
              value={filter.operator}
              onChange={(event) =>
                onFilters(
                  filters.map((item, position) =>
                    position === index
                      ? { ...item, operator: event.target.value as GridFilter['operator'] }
                      : item,
                  ),
                  match,
                )
              }
            >
              {gridFilterOperators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
            {!filter.operator.startsWith('is ') && (
              <Input
                className="w-44"
                aria-label={`Loaded filter ${index + 1} value`}
                value={filter.value}
                onChange={(event) =>
                  onFilters(
                    filters.map((item, position) =>
                      position === index ? { ...item, value: event.target.value } : item,
                    ),
                    match,
                  )
                }
              />
            )}
            <Button
              variant="ghost"
              aria-label={`Remove loaded filter ${index + 1}`}
              onClick={() =>
                onFilters(
                  filters.filter((_, position) => position !== index),
                  match,
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={!columns.length || filters.length >= 20}
          onClick={() => onFilters([...filters, { index: 0, operator: 'contains', value: '' }], match)}
        >
          Add loaded filter
        </Button>
        <p className="field-note">
          NULL is different from an empty string. Numeric column comparisons preserve decimal precision; text
          contains matching ignores case.
        </p>
        <strong>Sort priority</strong>
        {remoteSort ? (
          <p className="field-note">
            This table uses server-side sorting through its column headers. The loaded-page filters above
            remain local.
          </p>
        ) : (
          <>
            {sorts.map((sort, index) => (
              <div className="flex items-center gap-2" key={sort.index}>
                <span>{index + 1}.</span>
                <select
                  aria-label={`Loaded sort ${index + 1} column`}
                  value={sort.index}
                  onChange={(event) => {
                    const selected = Number(event.target.value)
                    onSorts(
                      sorts
                        .map((item, position) =>
                          position === index
                            ? { ...item, index: selected, column: columns[selected].name }
                            : item,
                        )
                        .filter(
                          (item, position, all) =>
                            all.findIndex((other) => other.index === item.index) === position,
                        ),
                    )
                  }}
                >
                  {columnOptions}
                </select>
                <select
                  aria-label={`Loaded sort ${index + 1} direction`}
                  value={sort.direction}
                  onChange={(event) =>
                    onSorts(
                      sorts.map((item, position) =>
                        position === index
                          ? { ...item, direction: event.target.value as 'asc' | 'desc' }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <Button
                  variant="ghost"
                  aria-label={`Remove loaded sort ${index + 1}`}
                  onClick={() => onSorts(sorts.filter((_, position) => position !== index))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={sorts.length >= Math.min(8, columns.length)}
              onClick={() => {
                const index = columns.findIndex(
                  (_, position) => !sorts.some((sort) => sort.index === position),
                )
                if (index >= 0) onSorts([...sorts, { index, column: columns[index].name, direction: 'asc' }])
              }}
            >
              Add loaded sort
            </Button>
          </>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              onFilters([], 'all')
              onSorts([])
            }}
          >
            Reset loaded-page view
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
