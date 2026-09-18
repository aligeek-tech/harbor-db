import { z } from 'zod'
import type { Cell } from './contracts'
import { parameterDefinitionSchema } from './parameters'

export const importOptionsSchema = z
  .object({
    format: z.enum(['csv', 'jsonl']),
    encoding: z.enum(['utf8', 'utf16le']).default('utf8'),
    delimiter: z.enum([',', ';', '\t', '|']).default(','),
    header: z.boolean().default(true),
    nullToken: z.string().max(32).default('\\N'),
  })
  .strict()
export type ImportOptions = z.infer<typeof importOptionsSchema>
export interface ImportPreview {
  sourceId: string
  name: string
  bytes: number
  options: ImportOptions
  columns: string[]
  rows: Cell[][]
  lineNumbers: number[]
  warnings: string[]
}
export const importTargetSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: z.string().min(1).max(255).optional(),
    schema: z.string().min(1).max(255),
    table: z.string().min(1).max(255),
    confirm: z.string().max(1200).optional(),
  })
  .strict()
export type ImportTarget = z.infer<typeof importTargetSchema>
export function importTargetConfirmation(target: ImportTarget): string {
  return `IMPORT ${target.connectionId}/${target.database ?? '(default)'}/${target.schema}/${target.table}`
}
export const startImportSchema = importTargetSchema
  .extend({
    sourceId: z.string().uuid(),
    mapping: z
      .array(
        z
          .object({
            source: z.number().int().min(0).max(199),
            target: z.string().min(1).max(255),
            type: parameterDefinitionSchema.shape.type,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    batchSize: z.number().int().min(1).max(500).default(100),
    errorPolicy: z.enum(['stop', 'skip-invalid']).default('stop'),
    consentBatchCommits: z.literal(true),
    consentNonTransactionalAppend: z.literal(true).optional(),
  })
  .strict()
export type StartImportInput = z.infer<typeof startImportSchema>
export interface ImportJobSnapshot {
  commitModel?: 'transaction' | 'append'
  id: string
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  rowsRead: number
  committedRows: number
  rolledBackRows: number
  uncertainRows: number
  skippedRows: number
  committedBatches: number
  bytesRead: number
  fileBytes: number
  lastLine: number
  durationMs: number
  issues: { line: number; message: string }[]
  error?: string
  warnings: string[]
}
