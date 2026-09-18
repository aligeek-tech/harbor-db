import { z } from 'zod'
export const analyticsFormatSchema = z.enum(['csv', 'json', 'parquet'])
export interface AnalyticsFileGrant {
  token: string
  name: string
  bytes: number
  format: z.infer<typeof analyticsFormatSchema>
}
export const analyticsReadSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(100),
    requestId: z.string().min(1).max(100),
    token: z.string().uuid(),
  })
  .strict()
export const analyticsImportSchema = analyticsReadSchema.extend({
  schema: z.string().min(1).max(255),
  table: z.string().min(1).max(255),
  confirm: z.string().min(1).max(600),
})
