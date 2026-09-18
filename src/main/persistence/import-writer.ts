import { isSafeNumber, splitNumber } from 'lossless-json'
import type { Cell, ColumnInfo, Engine } from '../../shared/contracts'
import type { ImportTarget } from '../../shared/imports'

export interface ImportWriter {
  columns: ColumnInfo[]
  commitModel?: 'transaction' | 'append'
  warnings?: string[]
  writeBatch(rows: Cell[][]): Promise<void>
  close(): Promise<void>
}
export interface ImportBackend {
  openImport(
    target: ImportTarget & { columns: string[]; consentNonTransactionalAppend?: true },
    signal: AbortSignal,
  ): Promise<ImportWriter>
}
/** Only static, value-free errors cross this boundary. Never include driver text. */
export class ImportBatchError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rolled-back' | 'uncertain',
    readonly rows: number,
  ) {
    super(message)
    this.name = 'ImportBatchError'
  }
}

/** Reject known silent numeric narrowing before any row in a batch is written. */
export function validateImportNumber(value: Cell, column: ColumnInfo, engine: Engine): void {
  if (value === null || typeof value === 'object' || typeof value === 'boolean') return
  const raw = String(value)
    .replace(/^\+/, '')
    .replace(/^(-?)\./, '$10.')
    .replace(/\.$/, '.0')
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return
  const declared = column.type.toLowerCase()
  if (/^(?:real|float(?:4|8)?|double(?: precision)?)(?:\s*\(|$)/.test(declared)) {
    const number = Number(raw)
    const singlePrecision =
      engine === 'postgres'
        ? /^(?:real|float4)$/.test(declared)
        : engine === 'duckdb'
          ? /^(?:real|float|float4)$/.test(declared)
          : false
    if (!isSafeNumber(raw) || !Number.isFinite(number) || (singlePrecision && Math.fround(number) !== number))
      throw new Error(
        'The floating-point destination would round the source value. Choose an exact DECIMAL or TEXT destination.',
      )
    return
  }
  if (engine === 'sqlite') {
    if (!declared || /char|clob|text|blob/.test(declared)) return
    if (/^-?\d+$/.test(raw)) {
      const integer = BigInt(raw)
      if (
        integer >= -9223372036854775808n &&
        integer <= 9223372036854775807n &&
        !/real|floa|doub/.test(declared)
      )
        return
    }
    if (!isSafeNumber(raw))
      throw new Error(
        'SQLite numeric affinity would round a source value. Choose a TEXT destination for exact decimal or out-of-range integer text.',
      )
    return
  }
  const decimal = /^(?:numeric|decimal)\s*\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(declared)
  if (!decimal) return
  const { digits, exponent } = splitNumber(raw)
  const significant = digits.replace(/0+$/, '')
  if (!significant) return
  const precision = Number(decimal[1]),
    scale = Number(decimal[2] ?? 0)
  if (exponent > precision - scale - 1 || exponent - (significant.length - 1) < -scale)
    throw new Error(
      'The source value does not fit the destination DECIMAL precision/scale exactly. No rounding was permitted.',
    )
}
