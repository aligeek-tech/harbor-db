import { z } from 'zod'
const id = z.string().min(1).max(100),
  name = z.string().min(1).max(128)
export const cqlProfileSchema = z
  .object({ dataCenter: z.string().min(1).max(128).default('datacenter1') })
  .strict()
export const cqlParameterSchema = z
  .object({
    type: z.enum([
      'text',
      'ascii',
      'int',
      'smallint',
      'tinyint',
      'bigint',
      'varint',
      'decimal',
      'float',
      'double',
      'boolean',
      'uuid',
      'timeuuid',
      'timestamp',
      'date',
      'time',
      'duration',
      'inet',
      'blob',
      'null',
      'list',
      'set',
      'map',
      'tuple',
      'udt',
    ]),
    value: z.string().max(1000000),
  })
  .strict()
export const cqlTargetSchema = z.object({ connectionId: id, keyspace: name, table: name }).strict()
export const cqlTablesSchema = z.object({ connectionId: id, keyspace: name }).strict()
export const cqlSessionSchema = z.object({ connectionId: id, sessionId: id }).strict()
export const cqlExecuteSchema = cqlTargetSchema.extend({
  sessionId: id,
  requestId: id,
  cql: z.string().min(1).max(100000),
  parameters: z.array(cqlParameterSchema).max(100).default([]),
  mode: z.enum(['read', 'mutation']).default('read'),
  consistency: z.enum(['one', 'localOne', 'localQuorum', 'quorum', 'all']).default('localOne'),
  allowScan: z.boolean().default(false),
  allowFiltering: z.boolean().default(false),
  pageSize: z.number().int().min(1).max(100).default(25),
  confirm: z.string().max(600).optional(),
})
export const cqlNextSchema = cqlSessionSchema.extend({ requestId: id, cursor: z.string().uuid() })
export const cqlCancelSchema = cqlSessionSchema.extend({ requestId: id })
export type CqlExecute = z.infer<typeof cqlExecuteSchema>
export type CqlParameter = z.infer<typeof cqlParameterSchema>
export interface CqlTable {
  id: string
  keyspace: string
  name: string
  columns: { name: string; type: string; kind: string; position: number }[]
  partition: string[]
  clustering: string[]
}
export interface CqlPage {
  keyspace: string
  table: string
  columns: { name: string; type: string }[]
  rows: string[][]
  cursor?: string
  rowsRead: number
  consistency: string
  acknowledged: boolean
  applied?: boolean
  warning: string
}
export const cqlConfirmation = (connectionId: string, keyspace: string, table: string) =>
  `MUTATE CQL ${connectionId}/${keyspace}/${table}`
export const cqlQuote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export interface CqlAPI {
  cqlKeyspaces(id: string): Promise<string[]>
  cqlTables(input: z.infer<typeof cqlTablesSchema>): Promise<string[]>
  cqlStructure(input: z.infer<typeof cqlTargetSchema>): Promise<CqlTable>
  cqlExecute(input: CqlExecute): Promise<CqlPage>
  cqlNext(input: z.infer<typeof cqlNextSchema>): Promise<CqlPage>
  cqlCancel(input: z.infer<typeof cqlCancelSchema>): Promise<{ requested: boolean; message: string }>
}
