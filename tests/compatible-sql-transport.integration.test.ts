import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { Server, utils } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompatibleSqlService } from '../src/main/engines/compatible-sql'
import { profileSchema } from '../src/shared/contracts'
import { isCompatibleSqlEngine } from '../src/shared/compatible-sql'

const requested = process.env.HARBOR_COMPATIBLE ?? ''
const enabled = isCompatibleSqlEngine(requested) && requested !== 'redshift'
const engine = enabled && isCompatibleSqlEngine(requested) ? requested : 'yugabytedb'
const pgWire = engine === 'yugabytedb' || engine === 'cockroachdb'
const nativeCa = process.env.HARBOR_COMPATIBLE_TLS_CA
  ? readFileSync(process.env.HARBOR_COMPATIBLE_TLS_CA, 'utf8')
  : ''
const port = { cockroachdb: 26258, yugabytedb: 15435, tidb: 14000, vitess: 15306, redshift: 5439 }[engine]
const database = {
  cockroachdb: 'defaultdb',
  yugabytedb: 'yugabyte',
  tidb: 'test',
  vitess: 'harbor',
  redshift: '',
}[engine]
const profile = profileSchema.parse({
  id: 'compatible-transport',
  name: 'Disposable transport',
  engine,
  host: '127.0.0.1',
  port,
  database,
  username: engine === 'yugabytedb' ? 'yugabyte' : 'root',
  readOnly: true,
  ...(nativeCa ? { tls: { enabled: true, rejectUnauthorized: true, ca: nativeCa } } : {}),
})
const service = new CompatibleSqlService()
const sockets = new Set<net.Socket>()
const forwardedSockets: net.Socket[] = []
let ssh: Server | undefined, gateway: net.Server | undefined
let sshPort = 0,
  gatewayPort = 0,
  fingerprint = '',
  ca = '',
  directory = '',
  channelCount = 0
const secrets = { sshPassword: 'disposable-transport-only' }
function track(socket: net.Socket) {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  return socket
}

describe.skipIf(!enabled)(`real ${engine} native queries through local transport fixtures`, () => {
  beforeAll(async () => {
    if (pgWire) {
      directory = mkdtempSync(join(tmpdir(), 'harbor-compatible-tls-'))
      const config = join(directory, 'openssl.cnf'),
        key = join(directory, 'key.pem'),
        cert = join(directory, 'cert.pem')
      writeFileSync(
        config,
        '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Harbor disposable gateway\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1\n',
      )
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
          '-keyout',
          key,
          '-out',
          cert,
          '-config',
          config,
        ],
        { stdio: 'ignore' },
      )
      ca = readFileSync(cert, 'utf8')
      const context = tls.createSecureContext({ cert: ca, key: readFileSync(key), minVersion: 'TLSv1.2' })
      // Real TLS terminator, not a fake database. Only SSLRequest is handled here;
      // decrypted native protocol reaches the actual disposable product unchanged.
      gateway = net.createServer((socket) => {
        track(socket)
        let prelude = Buffer.alloc(0)
        const receive = (chunk: Buffer) => {
          prelude = Buffer.concat([prelude, chunk])
          if (prelude.length < 8) return
          socket.off('data', receive)
          if (prelude.length !== 8 || prelude.readInt32BE(0) !== 8 || prelude.readInt32BE(4) !== 80877103) {
            socket.destroy()
            return
          }
          socket.write('S')
          const secure = track(new tls.TLSSocket(socket, { isServer: true, secureContext: context }))
          const native = track(net.connect({ host: '127.0.0.1', port }))
          secure.once('close', () => native.destroy())
          native.once('close', () => secure.destroy())
          secure.pipe(native).pipe(secure)
        }
        socket.on('data', receive)
      })
      await new Promise<void>((resolve) => gateway!.listen(0, '127.0.0.1', resolve))
      gatewayPort = (gateway.address() as net.AddressInfo).port
    }
    const key = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey
    const parsed = utils.parseKey(key)
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid disposable SSH host key')
    fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    ssh = new Server({ hostKeys: [key] }, (client) => {
      client.on('error', () => {})
      client.on('authentication', (auth) =>
        auth.method === 'password' && auth.username === 'harbor' && auth.password === secrets.sshPassword
          ? auth.accept()
          : auth.reject(),
      )
      client.on('tcpip', (accept, reject, info) => {
        if (
          !['127.0.0.1', 'wrong-host.invalid'].includes(info.destIP) ||
          ![port, gatewayPort].includes(info.destPort)
        ) {
          reject()
          return
        }
        channelCount++
        const channel = accept(),
          remote = track(net.connect({ host: '127.0.0.1', port: info.destPort }))
        forwardedSockets.push(remote)
        channel.on('error', () => remote.destroy())
        channel.once('close', () => remote.destroy())
        remote.once('close', () => channel.destroy())
        remote.pipe(channel).pipe(remote)
      })
    })
    await new Promise<void>((resolve) => ssh!.listen(0, '127.0.0.1', resolve))
    sshPort = (ssh.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    await service.closeAll()
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      ssh && new Promise<void>((resolve) => ssh!.close(() => resolve())),
      gateway && new Promise<void>((resolve) => gateway!.close(() => resolve())),
    ])
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
  const tunneled = () => ({
    ...profile,
    ssh: {
      ...profile.ssh,
      enabled: true,
      host: '127.0.0.1',
      port: sshPort,
      username: 'harbor',
      hostKey: fingerprint,
    },
  })
  async function check(id: string) {
    const result = await service.execute({
      connectionId: id,
      sessionId: 'query',
      requestId: randomUUID(),
      sql: `SELECT CAST('9007199254740993' AS ${pgWire ? 'BIGINT' : 'SIGNED'}) AS exact_value`,
      maxRows: 1,
      privateSession: true,
    })
    expect(result.sets[0].rows).toEqual([['9007199254740993']])
    await service.disconnect(id)
  }
  it('uses pinned SSH for real product queries and refuses changed host keys', async () => {
    const p = tunneled(),
      connected = await service.connect(p, secrets)
    expect(connected.state, connected.error).toBe('connected')
    await check(p.id)
    const rejected = await service.connect(
      { ...p, ssh: { ...p.ssh, hostKey: `SHA256:${'A'.repeat(43)}` } },
      secrets,
    )
    expect(rejected.state).toBe('failed')
    expect(rejected.error).toMatch(/does not match/)
  })
  it.skipIf(!pgWire)(
    'verifies actual TLS gateway trust and original hostname across SSH, with a native product behind it',
    async () => {
      const p = {
        ...profile,
        port: gatewayPort,
        tls: { ...profile.tls, enabled: true, rejectUnauthorized: true, ca },
      }
      const connected = await service.connect(p)
      expect(connected.state, connected.error).toBe('connected')
      await check(p.id)
      const untrusted = await service.connect({ ...p, tls: { ...p.tls, ca: '' } })
      expect(untrusted.state).toBe('failed')
      expect(untrusted.error).toMatch(/certificate|self.signed/i)
      const sshTls = { ...p, ssh: tunneled().ssh }
      const forwarded = await service.connect(sshTls, secrets)
      expect(forwarded.state, forwarded.error).toBe('connected')
      await check(p.id)
      const wrongHost = await service.connect({ ...sshTls, host: 'wrong-host.invalid' }, secrets)
      expect(wrongHost.state).toBe('failed')
      expect(wrongHost.error).toMatch(/hostname|IP|altnames/i)
    },
  )
  it('cancels the existing native wire without authenticating a hidden KILL session', async () => {
    const before = channelCount,
      p = { ...tunneled(), id: 'transport-cancel' }
    const connected = await service.connect(p, secrets)
    expect(connected.state, connected.error).toBe('connected')
    const requestId = randomUUID()
    const running = service
      .execute({
        connectionId: p.id,
        sessionId: 'cancel',
        requestId,
        sql: pgWire ? 'SELECT pg_sleep(10)' : 'SELECT SLEEP(10)',
        maxRows: 1,
        privateSession: true,
      })
      .then(
        () => 'unexpected success',
        (error: Error) => error.message,
      )
    for (
      let attempt = 0;
      attempt < 100 && !service.getSessionState({ connectionId: p.id, sessionId: 'cancel' }).running;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.getSessionState({ connectionId: p.id, sessionId: 'cancel' }).running).toBe(true)
    expect((await service.cancel({ connectionId: p.id, sessionId: 'cancel', requestId })).requested).toBe(
      true,
    )
    expect(await running).toMatch(/Cancellation|session.*closed|session ended/)
    await service.disconnect(p.id)
    expect(channelCount - before).toBe(2) // one metadata session, one tab session
  })
  it.skipIf(!nativeCa)('verifies native server TLS trust and the original host across SSH', async () => {
    const connected = await service.connect(profile)
    expect(connected.state, connected.error).toBe('connected')
    expect(connected.transport).toContain('TLS')
    await check(profile.id)
    const untrusted = await service.connect({ ...profile, tls: { ...profile.tls, ca: '' } })
    expect(untrusted.state).toBe('failed')
    expect(untrusted.error).toMatch(/certificate|self.signed/i)
    const wrongHost = await service.connect({ ...tunneled(), host: 'wrong-host.invalid' }, secrets)
    expect(wrongHost.state).toBe('failed')
    expect(wrongHost.error).toMatch(/hostname|IP|altnames/i)
  })
  it('makes metadata transport loss visible and never reconnects implicitly for another tab', async () => {
    const p = { ...tunneled(), id: 'metadata-loss' }
    const connected = await service.connect(p, secrets)
    expect(connected.state, connected.error).toBe('connected')
    const before = channelCount
    forwardedSockets.at(-1)!.destroy()
    for (let attempt = 0; attempt < 100 && service.status(p.id).state !== 'failed'; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.status(p.id).state).toBe('failed')
    expect(service.getSessionState({ connectionId: p.id, sessionId: 'new-tab' }).connected).toBe(false)
    await expect(
      service.execute({
        connectionId: p.id,
        sessionId: 'new-tab',
        requestId: randomUUID(),
        sql: 'SELECT 1',
        maxRows: 1,
        privateSession: true,
      }),
    ).rejects.toThrow(/Reconnect explicitly/)
    expect(channelCount).toBe(before)
    expect((await service.connect(p, secrets)).state).toBe('connected')
    await check(p.id)
  })
})
