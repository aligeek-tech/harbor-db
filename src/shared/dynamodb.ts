import { z } from 'zod'
export const dynamoCredentialSchema = z
  .object({
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(4096),
    sessionToken: z.string().min(1).max(8192).optional(),
  })
  .strict()
const id = z.string().min(1).max(100)
const table = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/)
export const dynamoProfileSchema = z
  .object({
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
      .default('us-east-1'),
    accountId: z
      .string()
      .regex(/^(?:[0-9]{12})?$/)
      .default(''),
    local: z.boolean().default(true),
  })
  .strict()
export const dynamoSessionSchema = z.object({ connectionId: id, sessionId: id }).strict()
export const dynamoCatalogSchema = z.object({ connectionId: id, after: table.optional() }).strict()
export const dynamoTableSchema = z.object({ connectionId: id, table }).strict()
export const dynamoReadSchema = dynamoSessionSchema.extend({
  requestId: id,
  table,
  index: z.string().max(255).default(''),
  mode: z.enum(['query', 'scan']).default('query'),
  partition: z.string().max(400000).default('{}'),
  sortOperator: z.enum(['none', 'eq', 'lt', 'lte', 'gt', 'gte', 'between', 'begins_with']).default('none'),
  sortValues: z.string().max(400000).default('[]'),
  consistent: z.boolean().default(false),
  descending: z.boolean().default(false),
  allowScan: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(25),
})
export const dynamoNextSchema = dynamoSessionSchema.extend({ requestId: id, cursor: z.string().uuid() })
export const dynamoMutationSchema = dynamoSessionSchema.extend({
  requestId: id,
  table,
  mode: z.enum(['create', 'patch', 'delete']),
  key: z.string().max(400000).default('{}'),
  item: z.string().max(1000000).default('{}'),
  expected: z.string().max(1000000).default('{}'),
  absent: z.array(z.string().min(1).max(255)).max(50).default([]),
  remove: z.array(z.string().min(1).max(255)).max(50).default([]),
  confirm: z.string().max(600),
})
export const dynamoCancelSchema = dynamoSessionSchema.extend({ requestId: id })
export type DynamoRead = z.infer<typeof dynamoReadSchema>
export type DynamoMutation = z.infer<typeof dynamoMutationSchema>
export interface DynamoTable {
  name: string
  arn: string
  identity: string
  partition: { name: string; type: string }
  sort?: { name: string; type: string }
  indexes: {
    name: string
    global: boolean
    partition: { name: string; type: string }
    sort?: { name: string; type: string }
  }[]
  status: string
  capacityMode: string
  readCapacity?: number
  writeCapacity?: number
  local: boolean
}
export interface DynamoPage {
  table: string
  index: string
  items: string[]
  cursor?: string
  count: number
  evaluated: number
  totalEvaluated: number
  capacity: string
  pages: number
  warning: string
}
export const dynamoConfirmation = (connectionId: string, tableName: string) =>
  `MUTATE DYNAMODB ${connectionId}/${tableName}`
export interface DynamoAPI {
  dynamoTables(input: z.infer<typeof dynamoCatalogSchema>): Promise<{ tables: string[]; after?: string }>
  dynamoTable(input: z.infer<typeof dynamoTableSchema>): Promise<DynamoTable>
  dynamoRead(input: DynamoRead): Promise<DynamoPage>
  dynamoNext(input: z.infer<typeof dynamoNextSchema>): Promise<DynamoPage>
  dynamoMutate(input: DynamoMutation): Promise<{ acknowledged: boolean; capacity: string; message: string }>
  dynamoCancel(input: z.infer<typeof dynamoCancelSchema>): Promise<{ requested: boolean; message: string }>
}
