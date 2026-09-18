import net from 'node:net'
import tls from 'node:tls'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import { openTransport, type Transport } from './transport'

/** The native CLI sees only this loopback bridge; Node enforces the original-host TLS policy. */
export async function openDb2Transport(profile: ConnectionProfile, secrets: Secrets): Promise<Transport> {
  const transport = await openTransport(profile, secrets)
  if (!transport.tls) return transport
  const sockets = new Set<net.Socket>()
  let closed = false
  const server = net.createServer((local) => {
    if (closed || sockets.size >= 12) {
      local.destroy()
      return
    }
    local.pause()
    sockets.add(local)
    const remote = tls.connect({ ...transport.tls, host: transport.host, port: transport.port })
    sockets.add(remote)
    const timer = setTimeout(() => {
      local.destroy()
      remote.destroy()
    }, profile.connectTimeout)
    const close = () => {
      clearTimeout(timer)
      local.destroy()
      remote.destroy()
      sockets.delete(local)
      sockets.delete(remote)
    }
    local.on('error', close)
    remote.on('error', close)
    local.once('close', close)
    remote.once('close', close)
    remote.once('secureConnect', () => {
      clearTimeout(timer)
      if (!remote.authorized) {
        close()
        return
      }
      local.pipe(remote).pipe(local)
      local.resume()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Db2 TLS bridge did not bind loopback.')
    server.on('error', () => {
      for (const socket of sockets) socket.destroy()
    })
    return {
      host: '127.0.0.1',
      port: address.port,
      close: async () => {
        if (closed) return
        closed = true
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await transport.close()
      },
    }
  } catch (error) {
    await transport.close()
    throw error
  }
}
