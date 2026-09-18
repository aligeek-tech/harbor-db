import type { Cell, ResultSet } from './contracts'

export function exactCell(left: Cell | undefined, right: Cell | undefined): boolean {
  if (typeof left !== typeof right) return false
  if (left && right && typeof left === 'object' && typeof right === 'object')
    return left.type === right.type && left.base64 === right.base64
  return Object.is(left, right)
}

export interface ResultDifference {
  row: number
  column: number
  left: Cell | undefined
  right: Cell | undefined
}

/** Positional comparison preserves duplicate column labels and exact driver values. */
export function compareLoadedResults(
  left: ResultSet,
  right: ResultSet,
  maxCells = 100000,
  maxDifferences = 200,
) {
  const columns = Math.max(left.columns.length, right.columns.length)
  const rows = Math.max(left.rows.length, right.rows.length)
  const metadata: number[] = []
  for (let index = 0; index < columns; index++) {
    const a = left.columns[index],
      b = right.columns[index]
    if (!a || !b || a.name !== b.name || a.type !== b.type || a.nullable !== b.nullable || a.key !== b.key)
      metadata.push(index)
  }
  const differences: ResultDifference[] = []
  let comparedCells = 0,
    differentCells = 0
  for (let row = 0; row < rows && comparedCells < maxCells; row++) {
    for (let column = 0; column < columns && comparedCells < maxCells; column++) {
      const a = left.rows[row]?.[column],
        b = right.rows[row]?.[column]
      comparedCells++
      if (!exactCell(a, b)) {
        differentCells++
        if (differences.length < maxDifferences) differences.push({ row, column, left: a, right: b })
      }
    }
  }
  return {
    metadata,
    differences,
    comparedCells,
    differentCells,
    complete: comparedCells === rows * columns,
    displayedAllDifferences: differences.length === differentCells,
    sameShape: left.rows.length === right.rows.length && left.columns.length === right.columns.length,
  }
}
