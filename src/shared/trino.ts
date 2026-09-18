import { z } from 'zod'
import type { Cell, ResultColumn } from './contracts'

export const trinoProfileSchema = z.object({
  auth: z.enum(['none', 'basic', 'bearer']).default('none'),
  timeZone: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+/:.-]+$/).default('UTC'),
}).strict()

export interface TrinoProgress {
  requestId: string
  queryId?: string
  phase: string
  pages: number
  rowsReceived: number
  processedRows?: string
  processedBytes?: string
  elapsedMs: number
  cancellation: 'none' | 'requested' | 'acknowledged' | 'unconfirmed'
}
export interface TrinoPage {
  id: string
  nextUri?: string
  columns?: ResultColumn[]
  rows: Cell[][]
  phase: string
  processedRows?: string
  processedBytes?: string
  updateType?: string
  updateCount?: string
  transaction?: string
  clearTransaction: boolean
}
