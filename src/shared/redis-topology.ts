import { z } from 'zod'

export const redisEndpointSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^\s/@?#]+$/, 'Enter a hostname or IP address, without credentials or a URL.'),
    port: z.number().int().min(1).max(65535),
  })
  .strict()
export const redisTopologySchema = z
  .object({
    mode: z.enum(['standalone', 'cluster', 'sentinel']).default('standalone'),
    seeds: z.array(redisEndpointSchema).max(10).default([]),
    serviceName: z.string().trim().max(255).default(''),
    sentinelUsername: z.string().max(255).default(''),
    // Discovery endpoints are untrusted until mapped or explicitly allowed by the profile.
    addressMap: z
      .array(
        z
          .object({
            discovered: z.string().min(1).max(300),
            host: redisEndpointSchema.shape.host,
            port: redisEndpointSchema.shape.port,
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()

export interface RedisTopologySnapshot {
  mode: 'standalone' | 'cluster' | 'sentinel'
  serviceName?: string
  nodes: { address: string; role: 'primary' | 'replica' | 'sentinel'; ready: boolean; slots?: number }[]
  checkedAt: string
  limitations: string[]
}

/** Redis CRC16/XMODEM, including binary keys and the first nonempty hash tag. */
export function redisHashSlot(input: Uint8Array): number {
  const open = input.indexOf(123)
  const close = open < 0 ? -1 : input.indexOf(125, open + 1)
  const bytes = open >= 0 && close > open + 1 ? input.subarray(open + 1, close) : input
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  return crc % 16384
}
