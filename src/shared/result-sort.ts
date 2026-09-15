import type { Cell } from './contracts'

// Compare decimal strings without rounding database bigint/decimal values to JS numbers.
function decimal(value: string) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value)
  if (!match || !(match[2] || match[3])) return null
  const raw = match[2] + (match[3] || '')
  const leading = raw.length - raw.replace(/^0+/, '').length
  const digits = raw.replace(/^0+/, '').replace(/0+$/, '') || '0'
  return {
    negative: match[1] === '-' && digits !== '0',
    digits,
    exponent: digits === '0' ? 0 : match[2].length - leading + Number(match[4] || 0),
  }
}
export function compareCells(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  const left = typeof a === 'object' ? a.base64 : String(a)
  const right = typeof b === 'object' ? b.base64 : String(b)
  if (numeric) {
    const x = decimal(left),
      y = decimal(right)
    if (x && y) {
      if (x.negative !== y.negative) return x.negative ? -1 : 1
      const magnitude =
        x.digits === '0'
          ? y.digits === '0'
            ? 0
            : -1
          : y.digits === '0'
            ? 1
            : x.exponent - y.exponent ||
              x.digits
                .padEnd(Math.max(x.digits.length, y.digits.length), '0')
                .localeCompare(y.digits.padEnd(Math.max(x.digits.length, y.digits.length), '0'))
      return x.negative ? -magnitude : magnitude
    }
  }
  return left.localeCompare(right)
}
