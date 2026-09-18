import { z } from 'zod'
const id = z.string().min(1).max(100)
export const neoParameterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(100),
    type: z.enum(['string', 'integer', 'float', 'boolean', 'null', 'date', 'datetime', 'duration', 'json']),
    value: z.string().max(1000000),
  })
  .strict()
export const neoQuerySchema = z
  .object({
    connectionId: id,
    sessionId: id,
    requestId: id,
    database: z.string().min(1).max(255),
    cypher: z.string().min(1).max(1000000),
    parameters: z.array(neoParameterSchema).max(100).default([]),
    mode: z.enum(['read', 'mutation']).default('read'),
    pageSize: z.number().int().min(1).max(100).default(25),
    confirm: z.string().max(500).optional(),
  })
  .strict()
export const neoNextSchema = z
  .object({ connectionId: id, sessionId: id, requestId: id, cursor: z.string().uuid() })
  .strict()
export const neoSessionSchema = z.object({ connectionId: id, sessionId: id }).strict()
export const neoCancelSchema = neoSessionSchema.extend({ requestId: id }).strict()
export type NeoParameter = z.infer<typeof neoParameterSchema>
export type NeoQueryInput = z.infer<typeof neoQuerySchema>
export type NeoNextInput = z.infer<typeof neoNextSchema>
export interface NeoCell {
  type: string
  value: string | null
}
export interface NeoNode {
  id: string
  labels: string[]
  properties: string
}
export interface NeoRelationship {
  id: string
  type: string
  start: string
  end: string
  properties: string
}
export interface NeoPage {
  database: string
  columns: string[]
  rows: NeoCell[][]
  cursor?: string
  nodes: NeoNode[]
  relationships: NeoRelationship[]
  graphTruncated: boolean
  durationMs: number
  rowsRead: number
  mutationAcknowledged: boolean
  counters?: Record<string, number>
  warning: string
}
export function neoConfirmation(connectionId: string, database: string) {
  return `MUTATE NEO4J ${connectionId}/${database}`
}
export interface NeoAPI {
  neoDatabases(id: string): Promise<string[]>
  neoQuery(input: NeoQueryInput): Promise<NeoPage>
  neoNext(input: NeoNextInput): Promise<NeoPage>
  neoCancel(input: z.infer<typeof neoCancelSchema>): Promise<{ requested: boolean; message: string }>
}
