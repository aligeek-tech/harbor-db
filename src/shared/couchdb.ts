import { z } from 'zod'
const id = z.string().min(1).max(100)
export const couchTargetSchema = z.object({ connectionId: id, database: z.string().min(1).max(255) }).strict()
export const couchReadSchema = couchTargetSchema
  .extend({
    sessionId: id,
    requestId: id,
    selector: z.string().min(1).max(1000000),
    pageSize: z.number().int().min(1).max(100).default(25),
    allowScan: z.boolean().default(false),
    index: z.string().max(255).optional(),
    cursor: z.string().uuid().optional(),
  })
  .strict()
export const couchDocumentSchema = couchTargetSchema
  .extend({ id: z.string().min(1).max(1000), revision: z.string().max(128).optional() })
  .strict()
export const couchMutationSchema = couchTargetSchema
  .extend({
    id: z.string().min(1).max(1000),
    action: z.enum(['create', 'replace', 'delete']),
    revision: z.string().max(128).optional(),
    source: z.string().max(1000000).optional(),
    confirm: z.string().max(1800),
  })
  .strict()
export const couchSessionSchema = z.object({ connectionId: id, sessionId: id }).strict()
export const couchCancelSchema = couchSessionSchema.extend({ requestId: id }).strict()
export type CouchReadInput = z.infer<typeof couchReadSchema>
export type CouchDocumentInput = z.infer<typeof couchDocumentSchema>
export type CouchMutationInput = z.infer<typeof couchMutationSchema>
export interface CouchDocument {
  id: string
  revision: string
  source: string
  conflicts: string[]
  attachmentNames: string[]
}
export interface CouchPage {
  documents: CouchDocument[]
  cursor?: string
  warning?: string
  examined?: string
  durationMs: number
}
export function couchConfirmation(
  input:
    | CouchMutationInput
    | { connectionId: string; database: string; id: string; action: string; revision?: string },
): string {
  return `${input.action.toUpperCase()} ${input.connectionId}/${input.database}/${input.id} @ ${input.revision || 'new'}`
}
export interface CouchAPI {
  couchDatabases(id: string): Promise<string[]>
  couchRead(input: CouchReadInput): Promise<CouchPage>
  couchDocument(input: CouchDocumentInput): Promise<CouchDocument>
  couchMutate(input: CouchMutationInput): Promise<{ id: string; revision: string }>
  couchCancel(input: z.infer<typeof couchCancelSchema>): Promise<void>
}
