import { z } from 'zod'

export const searchProfileSchema = z
  .object({
    auth: z.enum(['none', 'basic', 'api-key']).default('basic'),
    pathPrefix: z.string().max(1024).default(''),
  })
  .strict()
const context = {
  connectionId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  requestId: z.string().min(1).max(100),
}
const index = z.string().min(1).max(255)
export const searchInputSchema = z
  .object({
    ...context,
    index,
    dsl: z.string().max(1000000),
    pageSize: z.number().int().min(0).max(1000).default(200),
    cursor: z.string().uuid().optional(),
  })
  .strict()
export type SearchInput = z.infer<typeof searchInputSchema>
export const searchDocumentSchema = z
  .object({
    connectionId: context.connectionId,
    index,
    id: z.string().min(1).max(512),
    routing: z.string().max(512).optional(),
  })
  .strict()
export type SearchDocumentInput = z.infer<typeof searchDocumentSchema>
export const searchMutationSchema = searchDocumentSchema
  .extend({
    sessionId: context.sessionId,
    requestId: context.requestId,
    operation: z.enum(['create', 'replace', 'delete']),
    document: z.string().max(1000000).optional(),
    seqNo: z.string().regex(/^\d+$/).optional(),
    primaryTerm: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    confirm: z.string().max(2000),
  })
  .strict()
export type SearchMutationInput = z.infer<typeof searchMutationSchema>
export function searchMutationConfirmation(
  input: Pick<SearchMutationInput, 'operation' | 'index' | 'id'>,
  profile: { name: string; environment: string },
): string {
  return `${input.operation.toUpperCase()} ${input.index}/${input.id}${profile.environment.toLowerCase() === 'production' ? ` on ${profile.name}` : ''}`
}
export interface SearchHit {
  index: string
  id: string
  sourceJson: string
  fieldsJson?: string
  score: string | null
  seqNo?: string
  primaryTerm?: string
  routing?: string
}
export interface SearchResult {
  requestId: string
  hits: SearchHit[]
  aggregationsJson?: string
  total: { value: string; relation: 'eq' | 'gte' | 'unknown' }
  tookMs: number
  durationMs: number
  timedOut: boolean
  partial: boolean
  shardFailures: number
  nextCursor?: string
  cursorExpiresAt?: string
  warnings: string[]
}
export interface SearchCatalog {
  engine: 'elasticsearch' | 'opensearch'
  version: string
  indices: { name: string; health: string; status: string; documents: string; aliases: string[] }[]
  health?: { status: string; timedOut: boolean; nodes: number }
  warnings: string[]
}
export interface SearchMapping {
  index: string
  mappingsJson: string
  aliasesJson: string
  warnings: string[]
}
export interface SearchMutationResult {
  requestId: string
  result: 'created' | 'updated' | 'deleted'
  index: string
  id: string
  seqNo?: string
  primaryTerm?: string
  warnings: string[]
}
export interface SearchCancelResult {
  requested: boolean
  serverCancellationConfirmed: boolean
  message: string
}
