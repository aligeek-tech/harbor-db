import { z } from 'zod'
import type { Cell } from './contracts'
export const redisStreamGroupsSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    keyBase64: z.string().max(100000),
    group: z.string().max(1000).optional(),
  })
  .strict()
export type RedisStreamGroupsInput = z.infer<typeof redisStreamGroupsSchema>
export interface RedisStreamGroups {
  kind: 'groups' | 'consumers'
  rows: Cell[][]
  truncated: boolean
}
export const redisSubscribeSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    channel: z.string().min(1).max(1000),
    seconds: z.number().int().min(1).max(60).default(30),
  })
  .strict()
export type RedisSubscribeInput = z.infer<typeof redisSubscribeSchema>
export interface RedisSubscription {
  id: string
  connectionId: string
  channel: string
  state: 'running' | 'stopped' | 'failed'
  reason?: string
  expiresAt: string
  messages: { sequence: number; at: string; value: Cell; bytes: number; truncated: boolean }[]
  bytes: number
}
