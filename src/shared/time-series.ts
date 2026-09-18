import { z } from 'zod'
import type { Cell, ResultColumn } from './contracts'
export const timeSeriesProfileSchema = z
  .object({ generation: z.literal('2-flux').default('2-flux'), orgId: z.string().max(64).default('') })
  .strict()
const name = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32), 'Control characters are not allowed.')
export function instantNanos(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match) throw new Error('Use an explicit UTC timestamp with up to nine fractional digits.')
  const millis = Date.parse(match[1] + 'Z')
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1])
    throw new Error('Invalid UTC calendar date.')
  return BigInt(millis) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'))
}
const instant = z.string().refine((v) => {
  try {
    instantNanos(v)
    return true
  } catch {
    return false
  }
}, 'Use a valid UTC timestamp with up to nine fractional digits.')
const orderedRange = (v: { start: string; stop: string }) => {
  try {
    return instantNanos(v.stop) > instantNanos(v.start)
  } catch {
    return false
  }
}
const target = {
  connectionId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100),
  requestId: z.string().uuid(),
}
const range = { start: instant, stop: instant }
export const seriesDraftSchema = z
  .object({
    source: z.string().max(255),
    measurement: z.string().max(255),
    field: z.string().max(255),
    start: z.string().max(64),
    stop: z.string().max(64),
    tags: z.string().max(65536),
    aggregate: z.enum(['none', 'mean', 'sum', 'min', 'max', 'count', 'first', 'last']),
    interval: z.string().max(32),
    limit: z.number().int().min(0).max(1000),
    mode: z.enum(['browse', 'sql']),
  })
  .strict()
export const seriesCatalogSchema = z.object({ connectionId: target.connectionId }).strict()
export const seriesInspectSchema = z
  .object({ ...target, source: name, measurement: z.string().max(255).default(''), ...range })
  .strict()
  .refine(orderedRange, 'Stop must follow start.')
export const seriesQuerySchema = z
  .object({
    ...target,
    ...range,
    source: name,
    measurement: z.string().max(255).default(''),
    field: z.string().max(255).default(''),
    tags: z
      .array(z.object({ key: name, value: z.string().max(4096) }).strict())
      .max(10)
      .default([]),
    aggregate: z.enum(['none', 'mean', 'sum', 'min', 'max', 'count', 'first', 'last']).default('none'),
    interval: z
      .string()
      .regex(/^[1-9]\d{0,4}(?:s|m|h|d)$/)
      .default('1m'),
    limit: z.number().int().min(1).max(1000).default(200),
    mode: z.enum(['browse', 'sql']).default('browse'),
    sql: z.string().max(12000).default(''),
    confirm: z.string().max(300).default(''),
  })
  .strict()
  .refine(orderedRange, 'Stop must follow start.')
export const seriesCancelSchema = z.object(target).strict()
export type SeriesQuery = z.infer<typeof seriesQuerySchema>
export type SeriesInspect = z.infer<typeof seriesInspectSchema>
export interface SeriesSource {
  name: string
  id?: string
  timestamp?: string
  partition?: string
  details: Record<string, string>
}
export interface SeriesInspection {
  measurements: string[]
  fields: { name: string; type: string; designated?: boolean }[]
  details: Record<string, string>
  limited: boolean
}
export interface SeriesSet {
  columns: ResultColumn[]
  rows: Cell[][]
  group: Record<string, string>
}
export interface SeriesResult {
  sets: SeriesSet[]
  query: string
  rows: number
  truncated: boolean
  durationMs: number
  message: string
}
export const seriesConfirmation = (id: string) => `EXECUTE QUESTDB ${id}`
export interface TimeSeriesAPI {
  seriesCatalog(input: z.infer<typeof seriesCatalogSchema>): Promise<SeriesSource[]>
  seriesInspect(input: SeriesInspect): Promise<SeriesInspection>
  seriesQuery(input: SeriesQuery): Promise<SeriesResult>
  seriesCancel(input: z.infer<typeof seriesCancelSchema>): Promise<{ requested: boolean; message: string }>
}
// Generated Flux only: no imports, network functions, script fragments or credentials from the renderer.
export const fluxString = (value: string) => {
  if (value.includes('${') || [...value].some((c) => c.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(c)))
    throw new Error(
      'Flux interpolation and unsupported control characters are not accepted in names or tag values.',
    )
  return JSON.stringify(value)
}
export function fluxBrowse(input: SeriesQuery): string {
  if (!input.measurement) throw new Error('Choose an explicit measurement.')
  const predicates = [
    `r._measurement == ${fluxString(input.measurement)}`,
    ...(input.field ? [`r._field == ${fluxString(input.field)}`] : []),
    ...input.tags.map((t) => `r[${fluxString(t.key)}] == ${fluxString(t.value)}`),
  ]
  return `from(bucket: ${fluxString(input.source)}) |> range(start: time(v: ${fluxString(input.start)}), stop: time(v: ${fluxString(input.stop)})) |> filter(fn: (r) => ${predicates.join(' and ')})${input.aggregate === 'none' ? '' : ` |> aggregateWindow(every: ${input.interval}, fn: ${input.aggregate}, createEmpty: false)`} |> limit(n: ${input.limit + 1})`
}
export const questIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
export const questLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'"
