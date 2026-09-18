import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { Server, utils } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'

const integration = process.env.HARBOR_MYSQL === '1'
const caPath = process.env.HARBOR_MYSQL_TLS_CA
const profile = profileSchema.parse({
  id: 'mysql-transport',
  name: 'Disposable MySQL transport',
  engine: 'mysql',
  host: '127.0.0.1',
  port: 13307,
  username: 'harbor',
  database: 'harbor',
  readOnly: true,
})
const secrets = { password: 'harbor_test', sshPassword: 'disposable-ssh-password' }
const service = new SqlService()
let ssh: Server | undefined
let sshPort = 0
let fingerprint = ''
let channelsOpened = 0

describe.skipIf(!integration)('real MySQL transport', () => {
  beforeAll(async () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).privateKey
    const parsed = utils.parseKey(privateKey)
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture SSH key.')
    fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    ssh = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {})
      client.on('authentication', (context) =>
        context.method === 'password' &&
        context.username === 'harbor' &&
        context.password === secrets.sshPassword
          ? context.accept()
          : context.reject(),
      )
      client.on('tcpip', (accept, reject, info) => {
        // Route only these two fixture names to the disposable loopback database.
        if (!['127.0.0.1', 'wrong-host.local'].includes(info.destIP) || info.destPort !== 13307) {
          reject()
          return
        }
        const channel = accept()
        channelsOpened++
        const remote = net.connect({ host: '127.0.0.1', port: 13307 })
        channel.on('error', () => remote.destroy())
        channel.once('close', () => remote.destroy())
        remote.on('error', () => channel.destroy())
        remote.once('close', () => channel.destroy())
        remote.pipe(channel).pipe(remote)
      })
    })
    await new Promise<void>((resolve) => ssh!.listen(0, '127.0.0.1', resolve))
    sshPort = (ssh.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    await service.closeAll()
    if (ssh) await new Promise<void>((resolve) => ssh!.close(() => resolve()))
  })

  function sshProfile(id: string) {
    return {
      ...profile,
      id,
      ssh: {
        ...profile.ssh,
        enabled: true,
        host: '127.0.0.1',
        port: sshPort,
        username: 'harbor',
        hostKey: fingerprint,
      },
    }
  }
  async function check(id: string) {
    const result = await service.execute({
      connectionId: id,
      sessionId: 'query',
      requestId: crypto.randomUUID(),
      sql: 'SELECT 42 AS answer',
      maxRows: 10,
      privateSession: true,
    })
    expect(result.sets[0].rows).toEqual([['42']])
    await service.disconnect(id)
  }

  it('executes MySQL through a pinned SSH tunnel and rejects changed host identity', async () => {
    const tunneled = sshProfile('mysql-ssh')
    const state = await service.connect(tunneled, secrets)
    expect(state.state, state.error).toBe('connected')
    expect(state.transport).toBe('SSH tunnel')
    await check(tunneled.id)
    const rejected = await service.connect(
      {
        ...tunneled,
        id: 'mysql-ssh-untrusted',
        ssh: { ...tunneled.ssh, hostKey: `SHA256:${'A'.repeat(43)}` },
      },
      secrets,
    )
    expect(rejected.state).toBe('failed')
    expect(rejected.error).toContain('does not match')
  })

  it.skipIf(!caPath)('verifies TLS identity and rejects an untrusted certificate', async () => {
    const secure = {
      ...profile,
      id: 'mysql-tls',
      tls: { ...profile.tls, enabled: true, ca: readFileSync(caPath!, 'utf8') },
    }
    const state = await service.connect(secure, secrets)
    expect(state.state, state.error).toBe('connected')
    expect(state.transport).toBe('TLS')
    await check(secure.id)
    const rejected = await service.connect(
      { ...secure, id: 'mysql-tls-untrusted', tls: { ...secure.tls, ca: '' } },
      secrets,
    )
    expect(rejected.state).toBe('failed')
    expect(rejected.error).toMatch(/certificate|self.signed/i)
  })

  it.skipIf(!caPath)('verifies the original MySQL TLS host across SSH forwarding', async () => {
    const tunneled = sshProfile('mysql-ssh-tls')
    const secure = { ...tunneled, tls: { ...profile.tls, enabled: true, ca: readFileSync(caPath!, 'utf8') } }
    const state = await service.connect(secure, secrets)
    expect(state.state, state.error).toBe('connected')
    await check(secure.id)
    const rejected = await service.connect(
      { ...secure, id: 'mysql-ssh-tls-wrong-host', host: 'wrong-host.local' },
      secrets,
    )
    expect(rejected.state).toBe('failed')
    expect(rejected.error).toMatch(/hostname|IP|altnames/i)
  })

  it.skipIf(!caPath)('closes a running TLS tab through its original SSH channel without hidden authentication', async () => {
    const before = channelsOpened
    const profile = sshProfile('mysql-close-original-wire')
    const secure = { ...profile, tls: { ...profile.tls, enabled: true, ca: readFileSync(caPath!, 'utf8') } }
    expect(await service.connect(secure, secrets)).toMatchObject({ state: 'connected' })
    const result = service.execute({ connectionId: secure.id, sessionId: 'long', requestId: crypto.randomUUID(), sql: 'SELECT SLEEP(10)', maxRows: 1, privateSession: true }).then(() => 'completed', () => 'closed')
    await expect.poll(() => service.getSessionState({ connectionId: secure.id, sessionId: 'long' }).running).toBe(true)
    await service.closeSession({ connectionId: secure.id, sessionId: 'long' })
    expect(await result).toBe('closed')
    await service.disconnect(secure.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(channelsOpened - before).toBe(2)
  })
})
