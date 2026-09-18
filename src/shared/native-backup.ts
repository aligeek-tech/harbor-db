import { z } from 'zod'

export const nativeBackupToolSchema = z.enum(['pg_dump', 'pg_restore'])
export type NativeBackupToolKind = z.infer<typeof nativeBackupToolSchema>
export interface NativeBackupTool {
  id: string
  kind: NativeBackupToolKind
  path: string
  name: string
  version: string
  major: number
  sha256: string
}
export interface NativeBackupArchive {
  id: string
  path: string
  name: string
  bytes: number
  sha256: string
}
const base = {
  connectionId: z.string().min(1).max(100),
  toolId: z.string().uuid(),
  maxDurationSeconds: z.number().int().min(10).max(7200).default(1800),
}
export const previewNativeBackupSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...base,
      mode: z.literal('backup'),
      maxBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(100 * 1024 ** 3)
        .default(1024 ** 3),
    })
    .strict(),
  z
    .object({
      ...base,
      mode: z.literal('restore'),
      archiveId: z.string().uuid(),
      newDatabase: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,62}$/)
        .refine((value) => !['postgres', 'template0', 'template1'].includes(value)),
      trustArchive: z.literal(true),
    })
    .strict(),
])
export type PreviewNativeBackupInput = z.infer<typeof previewNativeBackupSchema>
export const startNativeBackupSchema = z
  .object({ token: z.string().uuid(), confirm: z.string().max(1200) })
  .strict()
export type StartNativeBackupInput = z.infer<typeof startNativeBackupSchema>
export interface NativeBackupPreview {
  token: string
  mode: 'backup' | 'restore'
  expiresAt: string
  confirmation: string
  target: {
    connectionId: string
    profile: string
    host: string
    port: number
    database: string
    user: string
    serverVersion: string
  }
  tool: NativeBackupTool
  archive?: NativeBackupArchive
  commands: string[]
  warnings: string[]
  blockedReasons: string[]
  archiveSummary?: {
    sourceVersion: string
    writerVersion: string
    entries: number
    preview: string[]
    truncated: boolean
  }
}
export interface NativeBackupJob {
  id: string
  mode: 'backup' | 'restore'
  connectionId: string
  state: 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown'
  phase: 'preparing' | 'dumping' | 'creating-database' | 'restoring' | 'verifying' | 'finalizing' | 'finished'
  bytes: number
  durationMs: number
  message: string
  outputPath?: string
  partialPath?: string
  database?: string
  sha256?: string
  warnings: string[]
  details: string[]
  verification?: { tables: number; views: number; indexes: number; constraints: number; routines: number }
}
