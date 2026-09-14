import { createHash, generateKeyPairSync } from 'node:crypto'
import net from 'node:net'
import type { DetailedPeerCertificate } from 'node:tls'
import { Server, utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { openTransport, tlsOptions, verifyHostKey } from '../src/main/engines/transport'

const profile = profileSchema.parse({
  id: 'transport-test',
  name: 'Transport test',
  engine: 'postgres',
  host: 'database.internal',
  port: 5432,
})

describe('SSH host identity', () => {
  it('accepts only the pinned OpenSSH SHA256 fingerprint', () => {
    const key = Buffer.from('test host public key')
    const expected = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    expect(verifyHostKey(key, expected)).toBe(true)
    expect(verifyHostKey(key, `${expected}=`)).toBe(true)
    expect(verifyHostKey(Buffer.from('changed host public key'), expected)).toBe(false)
    expect(verifyHostKey(key, '')).toBe(false)
    expect(verifyHostKey(key, 'trust-any-host')).toBe(false)
  })
  it('refuses to start an unverified tunnel', async () => {
    await expect(
      openTransport(
        { ...profile, ssh: { ...profile.ssh, enabled: true, host: 'ssh.internal', username: 'developer' } },
        { sshPassword: 'session-only' },
      ),
    ).rejects.toThrow('host trust is required')
  })
  it('forwards real TCP bytes through a pinned SSH server and closes the local listener', async () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey
    const parsed = utils.parseKey(privateKey)
    if (parsed instanceof Error || Array.isArray(parsed))
      throw new Error('Unable to generate SSH fixture key.')
    const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    const echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as net.AddressInfo).port
    const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {})
      client.on('authentication', (context) =>
        context.method === 'password' && context.username === 'harbor' && context.password === 'test-password'
          ? context.accept()
          : context.reject(),
      )
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== echoPort) {
          reject()
          return
        }
        const channel = accept()
        const remote = net.connect({ host: info.destIP, port: info.destPort })
        channel.on('error', () => remote.destroy())
        channel.once('close', () => remote.destroy())
        remote.on('error', () => channel.destroy())
        remote.pipe(channel).pipe(remote)
      })
    })
    await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve))
    const sshPort = (ssh.address() as net.AddressInfo).port
    let transport: Awaited<ReturnType<typeof openTransport>> | undefined
    try {
      const target = {
        ...profile,
        host: '127.0.0.1',
        port: echoPort,
        ssh: {
          ...profile.ssh,
          enabled: true,
          host: '127.0.0.1',
          port: sshPort,
          username: 'harbor',
          hostKey: fingerprint,
        },
      }
      transport = await openTransport(target, { sshPassword: 'test-password' })
      expect(transport.host).toBe('127.0.0.1')
      const payload = Buffer.from([0, 255, 1, 2, 3])
      const response = await new Promise<Buffer>((resolve, reject) => {
        const socket = net.connect({ host: transport!.host, port: transport!.port }, () =>
          socket.write(payload),
        )
        socket.on('error', reject)
        socket.once('data', (bytes) => {
          socket.destroy()
          resolve(bytes)
        })
        socket.setTimeout(3000, () => {
          socket.destroy()
          reject(new Error('Echo timed out.'))
        })
      })
      expect(response).toEqual(payload)
      const tunnelPort = transport.port
      await transport.close()
      const closed = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: tunnelPort })
        socket.once('connect', () => {
          socket.destroy()
          resolve(false)
        })
        socket.once('error', () => resolve(true))
      })
      expect(closed).toBe(true)
      await expect(
        openTransport(
          { ...target, ssh: { ...target.ssh, hostKey: `SHA256:${'A'.repeat(43)}` } },
          { sshPassword: 'test-password' },
        ),
      ).rejects.toThrow('does not match')
    } finally {
      await transport?.close()
      await Promise.all([
        new Promise<void>((resolve) => ssh.close(() => resolve())),
        new Promise<void>((resolve) => echo.close(() => resolve())),
      ])
    }
  }, 15000)
})

describe('TLS transport identity', () => {
  it('verifies the original database host when a client connects through localhost', async () => {
    const options = await tlsOptions({ ...profile, tls: { ...profile.tls, enabled: true } })
    expect(options?.servername).toBe('database.internal')
    expect(options?.rejectUnauthorized).toBe(true)
    const valid = {
      subjectaltname: 'DNS:database.internal',
      subject: { CN: 'database.internal' },
    } as DetailedPeerCertificate
    const invalid = {
      subjectaltname: 'DNS:localhost',
      subject: { CN: 'localhost' },
    } as DetailedPeerCertificate
    expect(options!.checkServerIdentity!('127.0.0.1', valid)).toBeUndefined()
    expect(options!.checkServerIdentity!('127.0.0.1', invalid)).toBeInstanceOf(Error)
  })
  it('supports IP SAN verification without sending an IP SNI name', async () => {
    const options = await tlsOptions({
      ...profile,
      host: '127.0.0.1',
      tls: { ...profile.tls, enabled: true },
    })
    expect(options?.servername).toBeUndefined()
    const certificate = { subjectaltname: 'IP Address:127.0.0.1', subject: {} } as DetailedPeerCertificate
    expect(options!.checkServerIdentity!('localhost', certificate)).toBeUndefined()
  })
  it('keeps a verification override confined to its connection', async () => {
    const dev = await tlsOptions({
      ...profile,
      tls: { ...profile.tls, enabled: true, rejectUnauthorized: false },
    })
    const secure = await tlsOptions({ ...profile, tls: { ...profile.tls, enabled: true } })
    expect(dev?.rejectUnauthorized).toBe(false)
    expect(secure?.rejectUnauthorized).toBe(true)
  })
  it('leaves direct non-TLS connections unchanged', async () => {
    const transport = await openTransport(profile)
    expect(transport.host).toBe(profile.host)
    expect(transport.port).toBe(5432)
    expect(transport.tls).toBeUndefined()
    await transport.close()
  })
})
