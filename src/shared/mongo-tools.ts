import { z } from 'zod'
import type { ConnectionStatus } from './contracts'

export const mongoToolTargetSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: z.string().min(1).max(255),
    collection: z.string().min(1).max(255),
  })
  .strict()
export type MongoToolTarget = z.infer<typeof mongoToolTargetSchema>
const fieldSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes('\0') && !value.startsWith('$') && !value.split('.').some((part) => !part),
    'Use an ordinary document field path.',
  )
export const mongoIndexSpecSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(127)
      .refine(
        (value) => !value.includes('\0') && value !== '*' && value !== '_id_',
        'Choose a non-reserved exact index name.',
      ),
    keys: z
      .array(
        z
          .object({
            field: fieldSchema,
            direction: z.union([
              z.literal(1),
              z.literal(-1),
              z.literal('hashed'),
              z.literal('text'),
              z.literal('2dsphere'),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    unique: z.boolean().default(false),
    sparse: z.boolean().default(false),
    hidden: z.boolean().default(false),
    expireAfterSeconds: z.number().int().min(0).max(2147483647).optional(),
    partialFilter: z.string().min(1).max(100000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.keys.map((key) => key.field)).size !== value.keys.length)
      context.addIssue({ code: 'custom', message: 'Index fields must be unique and ordered.' })
    if (value.unique && value.keys.some((key) => key.direction === 'hashed'))
      context.addIssue({ code: 'custom', message: 'MongoDB does not support unique hashed indexes.' })
    if (value.sparse && value.partialFilter)
      context.addIssue({ code: 'custom', message: 'Choose either sparse indexing or a partial filter.' })
    if (
      value.expireAfterSeconds !== undefined &&
      (value.keys.length !== 1 ||
        ![1, -1].includes(value.keys[0].direction as number) ||
        value.keys[0].field === '_id')
    )
      context.addIssue({
        code: 'custom',
        message: 'TTL requires one ordinary ascending/descending field other than _id.',
      })
  })
export type MongoIndexSpec = z.infer<typeof mongoIndexSpecSchema>
export const mongoIndexPreviewSchema = z.discriminatedUnion('operation', [
  mongoToolTargetSchema.extend({ operation: z.literal('create'), spec: mongoIndexSpecSchema }).strict(),
  mongoToolTargetSchema
    .extend({
      operation: z.literal('drop'),
      name: z
        .string()
        .min(1)
        .max(255)
        .refine(
          (name) => !['_id_', '*'].includes(name) && !name.includes('\0'),
          'Dropping the _id index or all indexes is unavailable.',
        ),
    })
    .strict(),
])
export type MongoIndexPreviewInput = z.infer<typeof mongoIndexPreviewSchema>
export const mongoIndexExecuteSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    token: z.string().uuid(),
    confirm: z.string().max(2000),
  })
  .strict()
export type MongoIndexExecuteInput = z.infer<typeof mongoIndexExecuteSchema>
export interface MongoIndexInfo {
  name: string
  keys: { field: string; direction: string }[]
  unique: boolean
  sparse: boolean
  hidden: boolean
  expireAfterSeconds?: string
  definitionJson: string
}
export interface MongoIndexCatalog {
  database: string
  collection: string
  indexes: MongoIndexInfo[]
  collectionJson: string
  warnings: string[]
}
export interface MongoIndexPreview {
  token: string
  expiresAt: string
  target: MongoToolTarget
  operation: 'create' | 'drop'
  name: string
  command: string
  confirmation: string
  warnings: string[]
}
export interface MongoIndexResult {
  operation: 'create' | 'drop'
  name: string
  acknowledged: boolean
  warnings: string[]
}
export interface MongoTopology {
  status: ConnectionStatus
  type: string
  setName?: string
  readPreference: string
  primary?: string
  writable: boolean
  observedAt: string
  servers: { address: string; type: string; roundTripMs?: number; reachable: boolean }[]
  warnings: string[]
}

export function mongoIndexConfirmation(
  input: MongoIndexPreviewInput,
  profile: { name: string; environment: string },
): string {
  const name = input.operation === 'create' ? input.spec.name : input.name
  const ttl = input.operation === 'create' && input.spec.expireAfterSeconds !== undefined
  return `${input.operation.toUpperCase()} ${ttl ? 'TTL ' : ''}INDEX ${input.database}.${input.collection}/${name}${profile.environment.toLowerCase() === 'production' ? ` on ${profile.name}` : ''}`
}
