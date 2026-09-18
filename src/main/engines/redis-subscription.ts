import net from 'node:net'
import tls from 'node:tls'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import { openTransport } from './transport'

type Reply = Buffer | number | null | Reply[]
const MAX_FRAME = 128 * 1024
const MAX_BULK = 65536
/** Dedicated RESP2 subscriber: reject oversized length headers before accumulating payloads. */
export class BoundedRedisReplies {
  private pending = Buffer.alloc(0)
  push(chunk: Buffer): Reply[] {
    if (this.pending.length + chunk.length > MAX_FRAME)
      throw new Error('Subscription frame exceeded the 128 KiB wire limit. Capture stopped.')
    this.pending = Buffer.concat([this.pending, chunk])
    const replies: Reply[] = []
    while (this.pending.length) {
      const result = this.parse(0, 0)
      if (!result) break
      replies.push(result.value)
      this.pending = this.pending.subarray(result.end)
    }
    return replies
  }
  private parse(offset: number, depth: number): { value: Reply; end: number } | undefined {
    if (depth > 3) throw new Error('Invalid subscription response nesting.')
    const marker = this.pending[offset]
    const newline = this.pending.indexOf('\r\n', offset + 1)
    if (newline < 0) {
      if (this.pending.length - offset > 1000) throw new Error('Invalid subscription response header.')
      return
    }
    const header = this.pending.subarray(offset + 1, newline).toString('utf8'),
      start = newline + 2
    if (marker === 45)
      throw new Error(
        'Redis rejected the subscription or authentication. Check data-node and channel ACL permissions.',
      )
    if (marker === 43) return { value: Buffer.from(header), end: start }
    if (marker === 58) {
      if (!/^-?\d+$/.test(header)) throw new Error('Invalid subscription count.')
      return { value: Number(header), end: start }
    }
    if ((marker !== 36 && marker !== 42) || !/^-?\d+$/.test(header))
      throw new Error('Invalid subscription wire response.')
    const length = Number(header)
    if (length === -1) return { value: null, end: start }
    if (!Number.isSafeInteger(length) || length < 0 || length > (marker === 36 ? MAX_BULK : 16))
      throw new Error(
        'Subscription message exceeds the 64 KiB payload limit. Capture stopped before reading its full payload.',
      )
    if (marker === 36) {
      if (this.pending.length < start + length + 2) return
      if (this.pending[start + length] !== 13 || this.pending[start + length + 1] !== 10)
        throw new Error('Invalid subscription payload boundary.')
      return { value: Buffer.from(this.pending.subarray(start, start + length)), end: start + length + 2 }
    }
    const values: Reply[] = []
    let end = start
    for (let index = 0; index < length; index++) {
      const result = this.parse(end, depth + 1)
      if (!result) return
      values.push(result.value)
      end = result.end
    }
    return { value: values, end }
  }
}
function command(args: string[]): Buffer {
  return Buffer.concat([
    Buffer.from(`*${args.length}\r\n`),
    ...args.flatMap((arg) => {
      const value = Buffer.from(arg)
      return [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')]
    }),
  ])
}

export async function openRedisSubscription(
  profile: ConnectionProfile,
  secrets: Secrets,
  channel: string,
  onMessage: (message: Buffer) => void,
  onFailure: (reason: string) => void,
): Promise<{ close(): Promise<void> }> {
  const transport = await openTransport(profile, secrets)
  let socket: net.Socket | undefined,
    closing = false
  const close = async () => {
    if (closing) return
    closing = true
    socket?.destroy()
    await transport.close()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const decoder = new BoundedRedisReplies()
      const steps: string[][] = []
      if (secrets.password !== undefined)
        steps.push(
          profile.username ? ['AUTH', profile.username, secrets.password] : ['AUTH', secrets.password],
        )
      if (profile.redis.mode !== 'cluster' && profile.redisDb !== 0)
        steps.push(['SELECT', String(profile.redisDb)])
      steps.push(['SUBSCRIBE', channel])
      let subscribed = false
      const deadline = setTimeout(() => fail('Subscription connection timed out.'), profile.connectTimeout)
      deadline.unref()
      const fail = (reason: string) => {
        clearTimeout(deadline)
        if (closing) return
        onFailure(reason)
        reject(new Error(reason))
        void close()
      }
      const send = () => {
        const next = steps.shift()
        if (next) socket!.write(command(next))
      }
      socket = transport.tls
        ? tls.connect({ ...transport.tls, host: transport.host, port: transport.port }, send)
        : net.connect({ host: transport.host, port: transport.port }, send)
      socket.on('error', () =>
        fail('The subscription socket failed. Messages may have been missed; reconnect explicitly.'),
      )
      socket.on('close', () =>
        fail('The subscription socket closed. Messages may have been missed; reconnect explicitly.'),
      )
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const reply of decoder.push(chunk)) {
            if (closing) break
            if (!subscribed) {
              if (
                Array.isArray(reply) &&
                Buffer.isBuffer(reply[0]) &&
                reply[0].toString() === 'subscribe' &&
                Buffer.isBuffer(reply[1]) &&
                reply[1].toString() === channel
              ) {
                subscribed = true
                clearTimeout(deadline)
                resolve()
              } else if (Buffer.isBuffer(reply) && reply.toString() === 'OK') send()
              else throw new Error('Unexpected subscription handshake response.')
            } else if (
              Array.isArray(reply) &&
              Buffer.isBuffer(reply[0]) &&
              reply[0].toString() === 'message' &&
              Buffer.isBuffer(reply[1]) &&
              reply[1].toString() === channel &&
              Buffer.isBuffer(reply[2])
            )
              onMessage(reply[2])
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : 'Subscription response failed.')
        }
      })
    })
    return { close }
  } catch (error) {
    await close()
    throw error
  }
}
