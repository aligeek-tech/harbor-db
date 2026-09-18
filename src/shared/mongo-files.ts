import { z } from 'zod'
import { mongoToolTargetSchema, type MongoToolTarget } from './mongo-tools'
export const mongoFileExportSchema = mongoToolTargetSchema
  .extend({
    mode: z.enum(['find', 'aggregate']),
    query: z.string().min(1).max(1000000),
    maxDocuments: z.number().int().min(1).max(1000000).default(10000),
    consentRerun: z.literal(true),
  })
  .strict()
export const mongoFileImportSchema = z
  .object({
    token: z.string().uuid(),
    confirm: z.string().max(1600),
    consentIndividualWrites: z.literal(true),
    maxDocuments: z.number().int().min(1).max(1000000).default(10000),
  })
  .strict()
export type MongoFileExportInput = z.infer<typeof mongoFileExportSchema>
export type MongoFileImportInput = z.infer<typeof mongoFileImportSchema>
export interface MongoFilePreview {
  token: string
  target: MongoToolTarget
  name: string
  bytes: number
  documents: string[]
  previewTruncated: boolean
  confirmation: string
  expiresAt: string
  warnings: string[]
}
export interface MongoFileJob {
  id: string
  kind: 'import' | 'export'
  target: MongoToolTarget
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  documentsRead: number
  acknowledgedDocuments: number
  uncertainDocuments: number
  bytes: number
  lastLine: number
  limited: boolean
  durationMs: number
  error?: string
  outputPath?: string
  partialPath?: string
  warnings: string[]
}
export interface MongoFileAPI {
  chooseMongoImport(target: MongoToolTarget): Promise<MongoFilePreview | null>
  startMongoImport(input: MongoFileImportInput): Promise<MongoFileJob>
  startMongoExport(input: MongoFileExportInput): Promise<MongoFileJob | null>
  mongoFileJob(id: string): Promise<MongoFileJob>
  cancelMongoFileJob(id: string): Promise<MongoFileJob>
}
export function mongoFileConfirmation(target: MongoToolTarget): string {
  return `INSERT DOCUMENTS ${target.connectionId}/${target.database}/${target.collection}`
}
export const MONGO_FILE_WARNINGS = [
  'UTF-8 JSONL: one canonical BSON Extended JSON document per line; maximum 1 MB per document. Nested fields and BSON types are preserved without column mapping.',
  'Imports insert only into an existing ordinary collection. Existing _id values are preserved; duplicate IDs stop the job. Each acknowledged document is committed independently, with no rollback or automatic retry.',
  'A preview validates only its bounded sample. Later malformed documents, validation rules, permissions or network failures can leave a partially completed import. Cancel waits for the current write outcome.',
]
