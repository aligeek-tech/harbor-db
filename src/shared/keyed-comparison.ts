import type { Cell, ResultSet } from './contracts'
import { exactCell } from './result-comparison'

export interface ColumnPair {
  left: number
  right: number
}
export interface KeyedComparisonOptions {
  keys: ColumnPair[]
  columns: ColumnPair[]
  rowLimit: number
  maxDifferences: number
}
export interface KeyedDifference {
  kind: 'left-only' | 'right-only' | 'changed' | 'duplicate'
  key: Cell[]
  leftRows: number[]
  rightRows: number[]
  changedColumns: number[]
}
export interface KeyedComparison {
  leftRows: number
  rightRows: number
  matched: number
  leftOnly: number
  rightOnly: number
  changed: number
  duplicateKeys: number
  nullKeys: number
  differences: KeyedDifference[]
  metadataDifferences: number[]
  complete: boolean
  displayedAllDifferences: boolean
}
function keyIdentity(values: Cell[]): string {
  // Explicit tags distinguish NULL, empty text, binary, booleans, and numeric-looking text.
  return JSON.stringify(
    values.map((value) =>
      value === null
        ? ['null']
        : typeof value === 'object'
          ? ['binary', value.base64]
          : [typeof value, typeof value === 'number' && Object.is(value, -0) ? '-0' : value],
    ),
  )
}
function validate(left: ResultSet, right: ResultSet, options: KeyedComparisonOptions): void {
  if (
    !Number.isInteger(options.rowLimit) ||
    options.rowLimit < 1 ||
    options.rowLimit > 10000 ||
    !Number.isInteger(options.maxDifferences) ||
    options.maxDifferences < 1 ||
    options.maxDifferences > 500
  )
    throw new Error('Comparison limits are 1–10,000 rows per result and 1–500 displayed differences.')
  if (
    !options.keys.length ||
    options.keys.length > 16 ||
    !options.columns.length ||
    options.columns.length > 200
  )
    throw new Error('Choose 1–16 key pairs and 1–200 value pairs.')
  for (const group of [options.keys, options.columns]) {
    if (
      new Set(group.map((pair) => pair.left)).size !== group.length ||
      new Set(group.map((pair) => pair.right)).size !== group.length
    )
      throw new Error('Each column position can appear only once in a mapping.')
    if (
      group.some(
        (pair) =>
          !Number.isInteger(pair.left) ||
          !Number.isInteger(pair.right) ||
          !left.columns[pair.left] ||
          !right.columns[pair.right],
      )
    )
      throw new Error('Comparison mapping refers to an absent column position.')
  }
  if (options.rowLimit * (options.keys.length + options.columns.length) * 2 > 1000000)
    throw new Error('Reduce the row or column limit to at most one million selected cells.')
}
/** Incremental comparison of explicitly selected loaded results. Never queries or mutates a database. */
export async function compareKeyedResults(
  left: ResultSet,
  right: ResultSet,
  options: KeyedComparisonOptions,
  controls: {
    signal: AbortSignal
    yield: () => Promise<void>
    progress?: (readRows: number) => void
  },
): Promise<KeyedComparison> {
  validate(left, right, options)
  const entries = new Map<string, { key: Cell[]; left: number[]; right: number[] }>()
  let scanned = 0,
    keyBytes = 0
  const checkpoint = async () => {
    if (controls.signal.aborted) throw new Error('Comparison cancelled; no database was changed.')
    controls.progress?.(scanned)
    await controls.yield()
    if (controls.signal.aborted) throw new Error('Comparison cancelled; no database was changed.')
  }
  for (const [side, set] of [
    ['left', left],
    ['right', right],
  ] as const) {
    for (let row = 0; row < Math.min(set.rows.length, options.rowLimit); row++) {
      const key = options.keys.map((pair) => set.rows[row][pair[side]])
      if (options.columns.some((pair) => set.rows[row][pair[side]] === undefined))
        throw new Error('A selected value cell is absent from its row.')
      if (key.some((value) => value === undefined))
        throw new Error('A selected key cell is absent from its row.')
      const identity = keyIdentity(key)
      keyBytes += new TextEncoder().encode(identity).byteLength
      if (keyBytes > 16 * 1024 * 1024)
        throw new Error('Key data exceeds the 16 MiB comparison bound. Select fewer rows or narrower keys.')
      const entry = entries.get(identity) || { key, left: [], right: [] }
      entry[side].push(row)
      entries.set(identity, entry)
      scanned++
      if (scanned % 100 === 0) await checkpoint()
    }
  }
  const result: KeyedComparison = {
    leftRows: Math.min(left.rows.length, options.rowLimit),
    rightRows: Math.min(right.rows.length, options.rowLimit),
    matched: 0,
    leftOnly: 0,
    rightOnly: 0,
    changed: 0,
    duplicateKeys: 0,
    nullKeys: 0,
    differences: [],
    metadataDifferences: [],
    complete:
      !left.truncated &&
      !right.truncated &&
      left.rows.length <= options.rowLimit &&
      right.rows.length <= options.rowLimit,
    displayedAllDifferences: true,
  }
  options.columns.forEach((pair, index) => {
    if (left.columns[pair.left].type !== right.columns[pair.right].type)
      result.metadataDifferences.push(index)
  })
  let visited = 0,
    totalDifferences = 0
  for (const entry of entries.values()) {
    if (visited++ % 100 === 0) await checkpoint()
    if (entry.key.some((value) => value === null)) result.nullKeys++
    let kind: KeyedDifference['kind'] | undefined,
      changedColumns: number[] = []
    if (entry.left.length > 1 || entry.right.length > 1) {
      result.duplicateKeys++
      kind = 'duplicate'
    } else if (!entry.left.length) {
      result.rightOnly++
      kind = 'right-only'
    } else if (!entry.right.length) {
      result.leftOnly++
      kind = 'left-only'
    } else {
      changedColumns = options.columns.flatMap((pair, index) =>
        exactCell(left.rows[entry.left[0]][pair.left], right.rows[entry.right[0]][pair.right]) ? [] : [index],
      )
      if (changedColumns.length) {
        result.changed++
        kind = 'changed'
      } else result.matched++
    }
    if (kind) {
      totalDifferences++
      if (result.differences.length < options.maxDifferences)
        result.differences.push({
          kind,
          key: entry.key,
          leftRows: entry.left,
          rightRows: entry.right,
          changedColumns,
        })
    }
  }
  if (controls.signal.aborted) throw new Error('Comparison cancelled; no database was changed.')
  result.displayedAllDifferences = result.differences.length === totalDifferences
  return result
}
