import { useMemo, useState } from 'react'
import { KeyedResultComparison } from './KeyedResultComparison'
import { Columns2 } from 'lucide-react'
import type { Cell } from '@shared/contracts'
import { compareLoadedResults } from '@shared/result-comparison'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

const valueLabel = (value: Cell | undefined) =>
  value === undefined
    ? 'MISSING'
    : value === null
      ? 'NULL'
      : typeof value === 'object'
        ? `binary(base64): ${value.base64}`
        : `${typeof value}: ${JSON.stringify(value)}`

export function ResultComparison() {
  const tabs = useApp((state) => state.workspace.tabs)
  const runtime = useApp((state) => state.runtime)
  const [open, setOpen] = useState(false)
  const [leftId, setLeft] = useState('')
  const [rightId, setRight] = useState('')
  const [mode, setMode] = useState<'position' | 'keys'>('position')
  const sets = tabs.flatMap((tab) =>
    (runtime[tab.id]?.result?.sets || []).map((set, index) => ({
      id: `${tab.id}:${index}`,
      label: `${tab.title} · result ${index + 1} · ${set.rows.length} loaded rows`,
      set,
    })),
  )
  const left = sets.find((item) => item.id === leftId)
  const right = sets.find((item) => item.id === rightId)
  const comparison = useMemo(
    () => (open && left && right ? compareLoadedResults(left.set, right.set) : null),
    [open, left?.set, right?.set],
  )
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={sets.length < 2}
        onClick={() => {
          setLeft(sets[0].id)
          setRight(sets[1].id)
          setOpen(true)
        }}
      >
        <Columns2 />
        Compare loaded results
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Compare loaded results</DialogTitle>
            <DialogDescription>
              Compare selected loaded results by position or explicitly mapped composite keys. This uses
              existing in-memory results without running queries. Local grid sorting and filters are not
              applied.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {(['Left', 'Right'] as const).map((label) => (
              <label key={label}>
                {label} result
                <select
                  aria-label={`${label} result`}
                  className="w-full"
                  value={label === 'Left' ? leftId : rightId}
                  onChange={(event) => (label === 'Left' ? setLeft : setRight)(event.target.value)}
                >
                  {sets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label>
            Comparison method
            <select
              aria-label="Comparison method"
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="position">Row and column position</option>
              <option value="keys">Explicit composite keys</option>
            </select>
          </label>
          {mode === 'keys' && left && right ? (
            <KeyedResultComparison left={left.set} right={right.set} />
          ) : comparison && left && right ? (
            <>
              <p role="status">
                {comparison.differentCells} different cells in {comparison.comparedCells.toLocaleString()}{' '}
                compared cells.{' '}
                {comparison.sameShape ? 'Same row and column counts.' : 'Row or column counts differ.'}{' '}
                {comparison.metadata.length} column metadata differences.
              </p>
              <p className="text-xs muted">
                Comparison cap: 100,000 cells; display cap: 200 differences.{' '}
                {comparison.complete
                  ? 'All loaded cells compared.'
                  : 'Comparison stopped at the cap; later cells are unverified.'}{' '}
                {comparison.displayedAllDifferences ? '' : 'Only the first 200 differences are displayed.'}{' '}
                {left.set.truncated || right.set.truncated
                  ? 'At least one source is truncated. Unloaded server rows are not compared.'
                  : 'This is a loaded-result comparison, not database equivalence.'}
              </p>
              {comparison.metadata.length > 0 && (
                <p className="text-xs">
                  Column metadata differs at positions:{' '}
                  {comparison.metadata.map((index) => index + 1).join(', ')}.
                </p>
              )}
              <div className="max-h-96 overflow-auto rounded border border-[var(--line)]">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th>Row / column</th>
                      <th>Left value</th>
                      <th>Right value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.differences.map((difference) => (
                      <tr key={`${difference.row}:${difference.column}`}>
                        <td className="p-2">
                          {difference.row + 1} / {difference.column + 1} ·{' '}
                          {left.set.columns[difference.column]?.name ||
                            right.set.columns[difference.column]?.name}
                        </td>
                        <td className="max-w-80 p-2 break-all whitespace-pre-wrap">
                          {valueLabel(difference.left).slice(0, 1000)}
                        </td>
                        <td className="max-w-80 p-2 break-all whitespace-pre-wrap">
                          {valueLabel(difference.right).slice(0, 1000)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs muted">
                Each displayed value is capped at 1,000 characters. Comparison uses the full value; use the
                original grid cell viewer for complete content.
              </p>
            </>
          ) : (
            <p>One of these result sets is no longer loaded.</p>
          )}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close comparison
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
