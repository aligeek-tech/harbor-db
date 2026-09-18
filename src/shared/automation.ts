import { z } from 'zod'
import { importOptionsSchema, importTargetSchema } from './imports'
import { parameterDefinitionSchema } from './parameters'

export const automationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z
    .object({
      kind: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
])

const commonTarget = { connectionId: z.string().min(1).max(100) }
export const automationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('report'), ...commonTarget, reportId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      kind: z.literal('export'),
      ...commonTarget,
      database: z.string().min(1).max(255).optional(),
      sql: z.string().min(1).max(1_000_000),
      format: z.enum(['csv', 'jsonl']),
      spreadsheetSafe: z.boolean(),
      outputDirectory: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('import'),
      ...commonTarget,
      target: importTargetSchema.omit({ confirm: true }),
      options: importOptionsSchema,
      mapping: z
        .array(
          z
            .object({
              source: z.number().int().min(0).max(199),
              target: z.string().min(1).max(255),
              type: parameterDefinitionSchema.shape.type,
            })
            .strict(),
        )
        .min(1)
        .max(200),
      batchSize: z.number().int().min(1).max(500).default(100),
      errorPolicy: z.enum(['stop', 'skip-invalid']).default('stop'),
    })
    .strict(),
])

export const automationLimitsSchema = z
  .object({
    maxDurationMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    maxRows: z.number().int().min(1).max(10_000_000).default(100_000),
    maxOutputBytes: z.number().int().min(1_024).max(10_737_418_240).default(268_435_456),
  })
  .strict()

export const automationDefinitionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    enabled: z.boolean().default(false),
    schedule: automationScheduleSchema,
    target: automationTargetSchema,
    limits: automationLimitsSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nextRunAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      definition.target.kind === 'import' &&
      definition.target.target.connectionId !== definition.target.connectionId
    )
      context.addIssue({
        code: 'custom',
        path: ['target', 'target', 'connectionId'],
        message: 'The reviewed import destination must use the reusable task connection.',
      })
  })

export const automationRunSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    state: z.enum([
      'running',
      'completed',
      'failed',
      'cancelled',
      'needs-review',
      'desktop-unavailable',
    ]),
    code: z.enum([
      'started',
      'completed',
      'failed',
      'cancelled',
      'fresh-import-review-required',
      'desktop-runtime-unavailable',
      'resource-limit',
      'schedule-zone-mismatch',
    ]),
    trigger: z.enum(['manual', 'schedule', 'startup-audit']),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().optional(),
    rows: z.number().int().min(0).optional(),
    bytes: z.number().int().min(0).optional(),
    message: z.string().max(2000),
  })
  .strict()

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>
export type AutomationTarget = z.infer<typeof automationTargetSchema>
export type AutomationRun = z.infer<typeof automationRunSchema>

export function automationHostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

export function nextDailyRun(
  schedule: Extract<AutomationDefinition['schedule'], { kind: 'daily' }>,
  after: Date,
): string {
  const hostTimeZone = automationHostTimeZone()
  if (schedule.timeZone !== hostTimeZone)
    throw new Error(
      `This daily schedule was reviewed for ${schedule.timeZone}, but the desktop now uses ${hostTimeZone}. Review and save the schedule again.`,
    )
  // Calendar math uses the explicitly matching host zone and is recalculated after every run/DST change.
  const candidate = new Date(after)
  candidate.setHours(schedule.hour, schedule.minute, 0, 0)
  if (candidate.getTime() <= after.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate.toISOString()
}
