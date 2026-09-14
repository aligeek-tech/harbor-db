import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import tls from 'node:tls'
import { Client, type ClientChannel } from 'ssh2'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'

export interface Transport {
  host: string
  port: number
  tls?: tls.ConnectionOptions
  close: () => Promise<void>
}

/** Accept OpenSSH SHA256 fingerprints only. Trust is supplied by the user. */
export function verifyHostKey(key: Buffer, expected: string): boolean {
  const normalized = expected.trim().replace(/=+$/, '')
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(normalized)) return false
  const actual = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
  return timingSafeEqual(Buffer.from(actual), Buffer.from(normalized))
}

export async function tlsOptions(profile: ConnectionProfile): Promise<tls.ConnectionOptions | undefined> {
  if (!profile.tls.enabled) return undefined
  const originalHost = profile.host
  return {
    rejectUnauthorized: profile.tls.rejectUnauthorized,
    minVersion: 'TLSv1.2',
    // SNI is a DNS name, while certificate verification also supports IP SANs.
    ...(net.isIP(originalHost) ? {} : { servername: originalHost }),
    checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(originalHost, certificate),
    ...(profile.tls.ca ? { ca: profile.tls.ca } : {}),
    ...(profile.tls.cert ? { cert: profile.tls.cert } : {}),
    ...(profile.tls.keyPath ? { key: await readFile(profile.tls.keyPath) } : {}),
  }
}

export async function openTransport(profile: ConnectionProfile, secrets: Secrets = {}): Promise<Transport> {
  const ssl = await tlsOptions(profile)
  if (!profile.ssh.enabled) return { host: profile.host, port: profile.port, tls: ssl, close: async () => {} }
  if (!profile.ssh.host || !profile.ssh.username) throw new Error('SSH host and username are required.')
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(profile.ssh.hostKey.trim())) {
    throw new Error(
      'SSH host trust is required. Enter the verified SHA256 host-key fingerprint from your server administrator. Harbor never trusts an unknown key automatically.',
    )
  }
  if (!profile.ssh.privateKeyPath && !secrets.sshPassword)
    throw new Error('Enter an SSH password or select a private key.')
  const ssh = new Client()
  const sockets = new Set<Socket>()
  const channels = new Set<ClientChannel>()
  let hostKeyRejected = false
  let closed = false
  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    ssh.forwardOut('127.0.0.1', socket.remotePort ?? 0, profile.host, profile.port, (error, channel) => {
      if (error || closed || socket.destroyed) {
        socket.destroy()
        channel?.destroy()
        return
      }
      channels.add(channel)
      channel.on('error', () => socket.destroy())
      channel.once('close', () => {
        channels.delete(channel)
        socket.destroy()
      })
      socket.once('close', () => channel.destroy())
      socket.pipe(channel).pipe(socket)
    })
  })
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    for (const channel of channels) channel.destroy()
    sockets.clear()
    channels.clear()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    ssh.end()
    ssh.destroy()
  }
  ssh.on('error', () => {
    if (!closed) void close()
  })
  ssh.once('close', () => {
    if (!closed) void close()
  })
  server.on('error', () => {
    if (!closed) void close()
  })
  try {
    const privateKey = profile.ssh.privateKeyPath ? await readFile(profile.ssh.privateKeyPath) : undefined
    await new Promise<void>((resolve, reject) => {
      ssh.once('ready', resolve)
      ssh.once('error', (error) =>
        reject(
          hostKeyRejected
            ? new Error(
                'SSH host key does not match the trusted fingerprint. Verify the changed key with your server administrator before updating this profile.',
              )
            : new Error(`SSH connection failed: ${error.message}`),
        ),
      )
      ssh.once('close', () => reject(new Error('SSH connection closed before the tunnel was ready.')))
      ssh.connect({
        host: profile.ssh.host,
        port: profile.ssh.port,
        username: profile.ssh.username,
        password: secrets.sshPassword,
        privateKey,
        passphrase: secrets.passphrase,
        readyTimeout: profile.connectTimeout,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const accepted = verifyHostKey(key, profile.ssh.hostKey)
          hostKeyRejected = !accepted
          return accepted
        },
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('The local SSH forwarding socket did not open.')
    return { host: '127.0.0.1', port: address.port, tls: ssl, close }
  } catch (error) {
    await close()
    throw error
  }
}
