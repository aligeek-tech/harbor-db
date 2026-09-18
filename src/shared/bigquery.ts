import { z } from 'zod'

export const bigQueryProfileSchema = z.object({
  location: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/).default('US'),
  maximumBytesBilled: z.string().regex(/^[1-9]\d{0,15}$/).default('100000000'),
}).strict()
export const bigQueryEstimateInputSchema = z.object({
  connectionId: z.string().min(1), database: z.string().min(1).max(255), sql: z.string().min(1).max(1_000_000),
}).strict()
export interface BigQueryEstimate { processedBytes: string; maximumBytesBilled: string; location: string; cacheCaveat: string }
