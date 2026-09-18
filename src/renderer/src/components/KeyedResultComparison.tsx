import { useEffect, useRef, useState } from 'react'
import type { ResultSet } from '@shared/contracts'
import { compareKeyedResults, type KeyedComparison } from '@shared/keyed-comparison'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ErrorPanel } from './common'

export function KeyedResultComparison({ left, right }: { left: ResultSet; right: ResultSet }) {
  const [mapping, setMapping] = useState<{ left: number; right: number; key: boolean; compare: boolean }[]>(
    [],
  )
  const [limit, setLimit] = useState(1000),
    [cap, setCap] = useState(200),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0)
  const [result, setResult] = useState<KeyedComparison>(),
    [error, setError] = useState('')
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    controller.current?.abort()
    controller.current = undefined
    setBusy(false)
    setResult(undefined)
    setError('')
    setMapping(
      left.columns.slice(0, 200).map((column, index) => {
        const candidates = right.columns.flatMap((item, position) =>
          item.name === column.name ? [position] : [],
        )
        return {
          left: index,
          right: candidates.length === 1 ? candidates[0] : Math.min(index, right.columns.length - 1),
          key: !!column.key,
          compare: true,
        }
      }),
    )
    return () => {
      controller.current?.abort()
      controller.current = undefined
    }
  }, [left, right])
  async function run() {
    const current = new AbortController()
    controller.current?.abort()
    controller.current = current
    setBusy(true)
    setResult(undefined)
    setError('')
    setProgress(0)
    try {
      const compared = await compareKeyedResults(
        left,
        right,
        {
          keys: mapping.filter((pair) => pair.key),
          columns: mapping.filter((pair) => pair.compare),
          rowLimit: limit,
          maxDifferences: cap,
        },
        {
          signal: current.signal,
          yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
          progress: setProgress,
        },
      )
      if (controller.current === current) setResult(compared)
    } catch (failure) {
      if (controller.current === current) setError(errorText(failure))
    } finally {
      if (controller.current === current) setBusy(false)
    }
  }
  return (
    <section aria-label="Keyed data comparison" className="space-y-3">
      <p className="text-xs muted">
        Scope: the explicitly selected loaded result sets above, before local grid sorting/filtering. Match
        composite keys by exact value and runtime type. NULL keys form their own groups; duplicate keys are
        ambiguous and never paired arbitrarily. Decimal text, binary bytes, NULL and empty text stay distinct.
        Timestamp strings are compared as returned, without timezone conversion. Type labels are reported
        separately.
      </p>
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex gap-3">
          <label>
            Rows per result
            <Input
              aria-label="Comparison row limit"
              type="number"
              min={1}
              max={10000}
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value))
                setResult(undefined)
              }}
            />
          </label>
          <label>
            Displayed differences
            <Input
              aria-label="Comparison difference limit"
              type="number"
              min={1}
              max={500}
              value={cap}
              onChange={(event) => {
                setCap(Number(event.target.value))
                setResult(undefined)
              }}
            />
          </label>
        </div>
        <div className="max-h-52 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>Key</th>
                <th>Compare value</th>
                <th>Left column</th>
                <th>Right column</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((pair, index) => (
                <tr key={pair.left}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Key column ${index + 1}`}
                      checked={pair.key}
                      onChange={(event) => {
                        setMapping(
                          mapping.map((item, i) =>
                            i === index ? { ...item, key: event.target.checked } : item,
                          ),
                        )
                        setResult(undefined)
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare column ${index + 1}`}
                      checked={pair.compare}
                      onChange={(event) => {
                        setMapping(
                          mapping.map((item, i) =>
                            i === index ? { ...item, compare: event.target.checked } : item,
                          ),
                        )
                        setResult(undefined)
                      }}
                    />
                  </td>
                  <td>
                    #{pair.left + 1} {left.columns[pair.left].name} · {left.columns[pair.left].type}
                  </td>
                  <td>
                    <select
                      aria-label={`Right mapping ${index + 1}`}
                      value={pair.right}
                      onChange={(event) => {
                        setMapping(
                          mapping.map((item, i) =>
                            i === index ? { ...item, right: Number(event.target.value) } : item,
                          ),
                        )
                        setResult(undefined)
                      }}
                    >
                      {right.columns.map((column, position) => (
                        <option key={position} value={position}>
                          #{position + 1} {column.name} · {column.type}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button
          disabled={!mapping.some((pair) => pair.key) || !mapping.some((pair) => pair.compare)}
          onClick={() => void run()}
        >
          Compare selected keys
        </Button>
      </fieldset>
      {busy && (
        <div role="status">
          Comparing {progress.toLocaleString()} loaded rows…{' '}
          <Button variant="outline" onClick={() => controller.current?.abort()}>
            Cancel comparison
          </Button>
        </div>
      )}
      {error && <ErrorPanel message={error} />}
      {result && (
        <>
          <p role="status">
            {result.matched} matching keys · {result.changed} changed · {result.leftOnly} left only ·{' '}
            {result.rightOnly} right only · {result.duplicateKeys} duplicate key groups · {result.nullKeys}{' '}
            NULL key groups.
          </p>
          <p className="text-xs muted">
            Compared {result.leftRows} left and {result.rightRows} right rows.{' '}
            {result.complete
              ? 'All rows in the selected loaded sets were compared.'
              : 'Comparison is partial: a selected result or the comparison row limit is truncated. Missing matches may exist outside this scope.'}{' '}
            {result.displayedAllDifferences
              ? 'All detected difference groups shown.'
              : 'Only the first requested difference groups are shown.'}{' '}
            {result.metadataDifferences.length} mapped type-label differences. This does not establish
            database equivalence.
          </p>
          <div className="max-h-60 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Difference</th>
                  <th>Exact key</th>
                  <th>Left row positions</th>
                  <th>Right row positions</th>
                  <th>Changed mapped columns</th>
                  <th>Changed values (left → right)</th>
                </tr>
              </thead>
              <tbody>
                {result.differences.map((difference, index) => (
                  <tr key={index}>
                    <td>{difference.kind}</td>
                    <td className="max-w-80 break-all">{JSON.stringify(difference.key).slice(0, 1000)}</td>
                    <td>
                      {difference.leftRows
                        .slice(0, 50)
                        .map((row) => row + 1)
                        .join(', ')}
                      {difference.leftRows.length > 50 ? ' …' : ''}
                    </td>
                    <td>
                      {difference.rightRows
                        .slice(0, 50)
                        .map((row) => row + 1)
                        .join(', ')}
                      {difference.rightRows.length > 50 ? ' …' : ''}
                    </td>
                    <td>
                      {difference.changedColumns
                        .map((column) => mapping.filter((pair) => pair.compare)[column])
                        .map((pair) => `#${pair.left + 1} ${left.columns[pair.left].name}`)
                        .join(', ')}
                    </td>
                    <td className="max-w-96 break-all">
                      {difference.kind === 'changed' &&
                        difference.changedColumns.slice(0, 3).map((column) => {
                          const pair = mapping.filter((item) => item.compare)[column]
                          return (
                            <div key={column}>
                              {JSON.stringify(left.rows[difference.leftRows[0]][pair.left]).slice(0, 500)} →{' '}
                              {JSON.stringify(right.rows[difference.rightRows[0]][pair.right]).slice(0, 500)}
                            </div>
                          )
                        })}
                      {difference.changedColumns.length > 3
                        ? 'Further changed values are available at the original row positions.'
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="text-xs muted">
        No synchronization is performed. Any later write needs its own target review and conflict checks.
        Differences reference original result row positions; shown changed values at 500 characters for the
        first three columns, keys at 1,000 characters and duplicate row lists at 50 positions. Comparison uses
        complete values within its limits.
      </p>
    </section>
  )
}
