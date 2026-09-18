import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { openDb2Transport } from '../src/main/engines/db2-transport'

it('Db2 TLS bridge enforces CA/original-host trust before forwarding bytes (generic TLS peer, not native Db2)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-db2-tls-'))
  const sockets = new Set<net.Socket>()
  let server: tls.Server | undefined
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    )
    const cert = await readFile(join(directory, 'cert.pem'), 'utf8'),
      key = await readFile(join(directory, 'key.pem'), 'utf8')
    const received: string[] = []
    server = tls.createServer({ key, cert }, (socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('data', (data) => {
        received.push(data.toString())
        socket.end(data)
      })
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server!.listen(0, '::', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture port')
    const base = profileSchema.parse({
      id: 'bridge',
      name: 'bridge',
      engine: 'db2',
      host: 'localhost',
      port: address.port,
      database: 'SAMPLE',
      username: 'reader',
      schema: 'HARBOR',
      connectTimeout: 1000,
      tls: { enabled: true, rejectUnauthorized: true, ca: cert },
    })
    for (const [profile, accepted] of [
      [base, true],
      [{ ...base, tls: { ...base.tls, ca: '' } }, false],
      [{ ...base, host: '127.0.0.1' }, false],
    ] as const) {
      const bridge = await openDb2Transport(profile, {})
      try {
        const result = await new Promise<string>((resolve, reject) => {
          const socket = net.connect({ host: bridge.host, port: bridge.port })
          let text = ''
          socket.setTimeout(2000, () => {
            socket.destroy()
            reject(new Error('Fixture timeout'))
          })
          socket.on('connect', () => socket.write('probe'))
          socket.on('data', (data) => {
            text += data.toString()
          })
          socket.on('error', () => {})
          socket.once('close', () => resolve(text))
        })
        expect(result).toBe(accepted ? 'probe' : '')
      } finally {
        await bridge.close()
      }
    }
    expect(received).toEqual(['probe'])
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
