import net, { type Socket } from 'node:net'
import tls from 'node:tls'
import { Transform, type TransformCallback } from 'node:stream'
import type { ConnectionProfile } from '../../shared/contracts'
import type { Transport } from './transport'
/** Enforce uncompressed protocol-v4 response frames before a driver receives their bodies. */
export class CqlFrameBound extends Transform {
  private header = Buffer.alloc(0)
  private remaining = 0
  _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (this.remaining) {
          const length = Math.min(this.remaining, chunk.length - offset)
          this.push(chunk.subarray(offset, offset + length))
          this.remaining -= length
          offset += length
          continue
        }
        const needed = 9 - this.header.length,
          take = Math.min(needed, chunk.length - offset)
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + take)])
        offset += take
        if (this.header.length === 9) {
          const length = this.header.readInt32BE(5)
          if (this.header[0] !== 0x84 || this.header[1]! & 1 || length < 0 || length > 8 * 1024 * 1024)
            throw new Error('CQL requires uncompressed protocol v4 responses bounded to 8 MiB.')
          this.remaining = length
          this.push(this.header)
          this.header = Buffer.alloc(0)
        }
      }
      done()
    } catch (error) {
      done(error as Error)
    }
  }
  _flush(done: TransformCallback) {
    done(
      this.header.length || this.remaining ? new Error('CQL response frame ended prematurely.') : undefined,
    )
  }
}
export interface CqlBridge {
  port: number
  close: () => Promise<void>
}
export async function cqlBridge(profile: ConnectionProfile, transport: Transport): Promise<CqlBridge> {
  const sockets = new Set<Socket>()
  let closed = false
  const server = net.createServer((client) => {
    if (closed || sockets.size >= 8) {
      client.destroy()
      return
    }
    sockets.add(client)
    const upstream = transport.tls
      ? tls.connect({ host: transport.host, port: transport.port, ...transport.tls })
      : net.connect({ host: transport.host, port: transport.port })
    sockets.add(upstream)
    const bound = new CqlFrameBound()
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => upstream.destroy(new Error('CQL connection deadline exceeded')),
      profile.connectTimeout,
    )
    const finish = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      client.destroy()
      upstream.destroy()
      bound.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', finish)
    upstream.on('error', finish)
    bound.on('error', finish)
    client.once('close', finish)
    upstream.once('close', finish)
    upstream.once(transport.tls ? 'secureConnect' : 'connect', () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      client.pipe(upstream)
      upstream.pipe(bound).pipe(client)
    })
  })
  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  server.on('error', () => void close())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new Error('CQL local transport did not start.')
  }
  return { port: address.port, close }
}
