import { z } from 'zod'
import { queryParameterSchema, parameterDefinitionSchema } from './parameters'
import { importTargetSchema } from './imports'
import type { Cell, ColumnInfo, Engine, ResultColumn } from './contracts'

// Deliberate initial matrix, not an all-to-all compatibility assertion.
export const DATABASE_TRANSFER_ENGINES: readonly Engine[] = ['postgres', 'sqlite', 'duckdb']
export const databaseTransferSourceSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: z.string().min(1).max(255).optional(),
    sql: z.string().min(1).max(1000000),
    parameters: z.array(queryParameterSchema).max(100).optional(),
  })
  .strict()
export const previewDatabaseTransferSchema = z
  .object({ source: databaseTransferSourceSchema, target: importTargetSchema.omit({ confirm: true }) })
  .strict()
export type PreviewDatabaseTransferInput = z.infer<typeof previewDatabaseTransferSchema>
export const startDatabaseTransferSchema = z
  .object({
    token: z.string().uuid(),
    confirm: z.string().max(1200),
    consentBatchCommits: z.literal(true),
    consentRerun: z.literal(true),
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
    maxRows: z.number().int().min(1).max(1000000).default(10000),
  })
  .strict()
export type StartDatabaseTransferInput = z.infer<typeof startDatabaseTransferSchema>
export interface DatabaseTransferPreview {
  token: string
  expiresAt: string
  sourceName: string
  targetName: string
  sourceColumns: ResultColumn[]
  targetColumns: ColumnInfo[]
  rows: Cell[][]
  warnings: string[]
  confirmation: string
  sourceConsistency: string
}
export interface DatabaseTransferJob {
  id: string
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  sourceName: string
  targetName: string
  rowsRead: number
  committedRows: number
  committedBatches: number
  rolledBackRows: number
  uncertainRows: number
  bufferedRows: number
  unwrittenRows: number
  maxRows: number
  limitReached: boolean
  durationMs: number
  error?: string
  warnings: string[]
}
