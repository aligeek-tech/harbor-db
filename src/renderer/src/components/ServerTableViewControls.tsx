import { useState } from 'react'
import type { TableInput, TableStructure } from '@shared/contracts'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

type Filters = NonNullable<TableInput['filters']>
type Sorts = NonNullable<TableInput['sorts']>
const operators: Filters['conditions'][number]['operator'][] = [
  'contains',
  'equals',
  'not equals',
  'greater than',
  'less than',
  'is null',
  'is not null',
]

export function ServerTableViewControls({
  structure,
  filters,
  sorts,
  filter,
  sort,
  onApply,
  onClose,
}: {
  structure: TableStructure
  filters?: TableInput['filters']
  sorts?: TableInput['sorts']
  filter?: TableInput['filter']
  sort?: { column: string; direction: 'asc' | 'desc' }
  onApply: (view: { filters: TableInput['filters']; sorts: TableInput['sorts'] }) => void
  onClose: () => void
}) {
  const [draftFilters, setDraftFilters] = useState<Filters>(
    filters || { match: 'all', conditions: filter ? [filter] : [] },
  )
  const [draftSorts, setDraftSorts] = useState<Sorts>(sorts || (sort ? [sort] : []))
  const options = structure.columns.map((column) => (
    <option key={column.name} value={column.name}>
      {column.name} · {column.type}
    </option>
  ))
  const valid =
    draftFilters.conditions.every((condition) =>
      structure.columns.some((column) => column.name === condition.column),
    ) && draftSorts.every((sort) => structure.columns.some((column) => column.name === sort.column))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Filter and sort table on server</DialogTitle>
          <DialogDescription>
            Apply fetches the first matching page from the database. Values use native parameters; column
            names must belong to this table. Server filters and sorts can scan many rows, even with a page
            limit.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <strong>Server filters</strong>
          <select
            aria-label="Server filter match"
            value={draftFilters.match}
            onChange={(event) =>
              setDraftFilters({ ...draftFilters, match: event.target.value as Filters['match'] })
            }
          >
            <option value="all">Match all conditions (AND)</option>
            <option value="any">Match any condition (OR)</option>
          </select>
        </div>
        {draftFilters.conditions.map((condition, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`Server filter ${index + 1} column`}
              value={condition.column}
              onChange={(event) =>
                setDraftFilters({
                  ...draftFilters,
                  conditions: draftFilters.conditions.map((item, position) =>
                    position === index ? { ...item, column: event.target.value } : item,
                  ),
                })
              }
            >
              {options}
            </select>
            <select
              aria-label={`Server filter ${index + 1} operator`}
              value={condition.operator}
              onChange={(event) =>
                setDraftFilters({
                  ...draftFilters,
                  conditions: draftFilters.conditions.map((item, position) =>
                    position === index
                      ? { ...item, operator: event.target.value as typeof condition.operator }
                      : item,
                  ),
                })
              }
            >
              {operators.map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
            {!condition.operator.startsWith('is ') && (
              <Input
                aria-label={`Server filter ${index + 1} value`}
                maxLength={10000}
                className="w-40"
                value={condition.value}
                onChange={(event) =>
                  setDraftFilters({
                    ...draftFilters,
                    conditions: draftFilters.conditions.map((item, position) =>
                      position === index ? { ...item, value: event.target.value } : item,
                    ),
                  })
                }
              />
            )}
            <Button
              variant="ghost"
              aria-label={`Remove server filter ${index + 1}`}
              onClick={() =>
                setDraftFilters({
                  ...draftFilters,
                  conditions: draftFilters.conditions.filter((_, position) => position !== index),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={!structure.columns.length || draftFilters.conditions.length >= 20}
          onClick={() =>
            setDraftFilters({
              ...draftFilters,
              conditions: [
                ...draftFilters.conditions,
                { column: structure.columns[0].name, operator: 'equals', value: '' },
              ],
            })
          }
        >
          Add server filter
        </Button>
        <p className="field-note">
          A blank comparison value means an empty string. Choose is null to match SQL NULL. Comparisons follow
          database types and collation; contains treats % and _ literally.
        </p>
        <strong>Server sort priority</strong>
        {draftSorts.map((sort, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <span>{index + 1}.</span>
            <select
              aria-label={`Server sort ${index + 1} column`}
              value={sort.column}
              onChange={(event) =>
                setDraftSorts(
                  draftSorts.map((item, position) =>
                    position === index ? { ...item, column: event.target.value } : item,
                  ),
                )
              }
            >
              {structure.columns.map((column) => (
                <option
                  key={column.name}
                  value={column.name}
                  disabled={draftSorts.some(
                    (item, position) => position !== index && item.column === column.name,
                  )}
                >
                  {column.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Server sort ${index + 1} direction`}
              value={sort.direction}
              onChange={(event) =>
                setDraftSorts(
                  draftSorts.map((item, position) =>
                    position === index ? { ...item, direction: event.target.value as 'asc' | 'desc' } : item,
                  ),
                )
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <Button
              variant="ghost"
              disabled={index === 0}
              aria-label={`Raise server sort ${index + 1} priority`}
              onClick={() => {
                const next = [...draftSorts]
                ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                setDraftSorts(next)
              }}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              aria-label={`Remove server sort ${index + 1}`}
              onClick={() => setDraftSorts(draftSorts.filter((_, position) => position !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={draftSorts.length >= Math.min(8, structure.columns.length)}
          onClick={() => {
            const column = structure.columns.find(
              (column) => !draftSorts.some((sort) => sort.column === column.name),
            )
            if (column) setDraftSorts([...draftSorts, { column: column.name, direction: 'asc' }])
          }}
        >
          Add server sort
        </Button>
        <p className="field-note">
          Sorts apply in the listed priority. Primary-key columns provide deterministic ties where available.
          A column-header sort replaces this priority list.
        </p>
        {!valid && (
          <p role="alert" className="danger">
            A configured column is no longer available. Remove it or refresh the table structure.
          </p>
        )}
        <div className="dialog-actions">
          <Button
            variant="outline"
            onClick={() => {
              setDraftFilters({ match: 'all', conditions: [] })
              setDraftSorts([])
            }}
          >
            Reset server view
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() =>
              onApply({
                filters: draftFilters.conditions.length ? draftFilters : undefined,
                sorts: draftSorts.length ? draftSorts : undefined,
              })
            }
          >
            Apply server view
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
