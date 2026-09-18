import { z } from 'zod'
import type { ResultSet } from './contracts'

const name = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('\0'))
export const sqlAdminTargetSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: name.optional(),
    schema: name.optional(),
    table: name.optional(),
  })
  .strict()
export type SqlAdminTarget = z.infer<typeof sqlAdminTargetSchema>
export const sqlAdminKindSchema = z.enum([
  'sessions',
  'health',
  'partitions',
  'routines',
  'events',
  'query-statistics',
  'permissions',
  'index-usage',
  'timescale',
])
export type SqlAdminKind = z.infer<typeof sqlAdminKindSchema>
export const inspectSqlAdministrationSchema = sqlAdminTargetSchema
  .extend({ kind: sqlAdminKindSchema, includeQueryText: z.boolean().default(false) })
  .strict()
export type InspectSqlAdministrationInput = z.infer<typeof inspectSqlAdministrationSchema>
export const sqlAdminActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session'),
      mode: z.enum(['cancel', 'terminate']),
      sessionId: z.string().regex(/^[1-9]\d{0,19}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('privilege'),
      mode: z.enum(['grant', 'revoke']),
      principal: name,
      host: name.optional(),
      privileges: z
        .array(z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER']))
        .min(1)
        .max(6)
        .refine((items) => new Set(items).size === items.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal('timescale-policy'),
      mode: z.enum(['add', 'remove']),
      policy: z.enum(['retention', 'compression']),
      ageHours: z.number().int().min(1).max(876000).optional(),
      initialStart: z.iso.datetime({ offset: true }).optional(),
      scheduleHours: z.number().int().min(1).max(8760).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('timescale-job'),
      jobId: z.number().int().min(1).max(2147483647),
      scheduled: z.boolean(),
      scheduleHours: z.number().int().min(1).max(8760),
      nextStart: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
])
export type SqlAdminAction = z.infer<typeof sqlAdminActionSchema>
export const previewSqlAdministrationSchema = z
  .object({ target: sqlAdminTargetSchema, action: sqlAdminActionSchema })
  .strict()
export type PreviewSqlAdministrationInput = z.infer<typeof previewSqlAdministrationSchema>
export const executeSqlAdministrationSchema = z
  .object({ token: z.string().uuid(), confirm: z.string().max(1200) })
  .strict()
export type ExecuteSqlAdministrationInput = z.infer<typeof executeSqlAdministrationSchema>
export interface SqlAdminInspection {
  engine: 'postgres' | 'mysql' | 'mariadb'
  kind: SqlAdminKind
  sets: ResultSet[]
  warnings: string[]
  available: boolean
  durationMs: number
  sessions?: {
    id: string
    user: string
    database: string
    client: string
    state: string
    startedAt?: string
    queryStartedAt?: string
  }[]
}
export interface SqlAdminPreview {
  token: string
  expiresAt: string
  engine: 'postgres' | 'mysql' | 'mariadb'
  target: SqlAdminTarget
  statements: string[]
  warnings: string[]
  blockedReasons: string[]
  confirmation: string
  identity: { name: string; value: string }[]
}
export interface SqlAdminResult {
  state: 'committed' | 'requested' | 'not-applied' | 'rolled-back' | 'unknown'
  message: string
  statements: string[]
  warnings: string[]
  sets: ResultSet[]
}
