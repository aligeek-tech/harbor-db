import { z } from 'zod'

export const vectorEngineSchema = z.enum(['qdrant', 'milvus', 'weaviate', 'pinecone'])
export type VectorEngine = z.infer<typeof vectorEngineSchema>

const target = {
  connectionId: z.string().min(1).max(100),
  collection: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/),
  namespace: z.string().max(255).optional(),
}
export const vectorSearchSchema = z
  .object({
    ...target,
    requestId: z.string().uuid(),
    vector: z.array(z.number().finite()).min(1).max(4096),
    filterJson: z.string().max(65536).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    includeVectors: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value.filter || {})).byteLength > 64 * 1024)
      context.addIssue({ code: 'custom', path: ['filter'], message: 'Filter exceeds 64 KiB.' })
  })

export const vectorMutateSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...target,
      action: z.literal('upsert'),
      id: z.union([z.string().min(1).max(512), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
      vector: z.array(z.number().finite()).min(1).max(4096),
      payloadJson: z.string().max(1_000_000).optional(),
      payload: z.record(z.string(), z.unknown()).default({}),
      confirm: z.string().max(1024),
    })
    .strict(),
  z
    .object({
      ...target,
      action: z.literal('delete'),
      id: z.union([z.string().min(1).max(512), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
      confirm: z.string().max(1024),
    })
    .strict(),
])

export interface VectorCollection {
  name: string
  dimension?: number
  metric?: string
  records?: number
  namespaces?: { name: string; records?: number }[]
  status?: string
  details: Record<string, string | number | boolean | null>
}
export interface VectorHit {
  id: string
  score?: number
  payload: Record<string, unknown>
  vector?: number[]
}
export interface VectorSearchResult {
  hits: VectorHit[]
  truncated: boolean
  durationMs: number
  usage?: Record<string, number>
  warnings: string[]
}
export interface VectorMutationResult {
  action: 'upsert' | 'delete'
  acknowledged: boolean
  warning?: string
}
export type VectorSearchInput = z.infer<typeof vectorSearchSchema>
export type VectorMutationInput = z.infer<typeof vectorMutateSchema>

export function vectorConfirmation(input: Pick<VectorMutationInput, 'connectionId' | 'collection' | 'namespace'>) {
  return `VECTOR ${input.connectionId}/${input.collection}/${input.namespace || '(default)'}`
}
