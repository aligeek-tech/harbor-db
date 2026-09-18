import net, { type AddressInfo, type Socket } from 'node:net'
import tls from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { OracleService } from '../src/main/engines/oracle'
import oracledb from 'oracledb'
import { profileSchema } from '../src/shared/contracts'

const profile = profileSchema.parse({
  id: 'oracle-transport',
  name: 'Oracle transport fixture',
  engine: 'oracle',
  host: '127.0.0.1',
  port: 25421,
  username: 'HARBOR_VERIFY',
  database: 'FREEPDB1',
  schema: 'HARBOR_VERIFY',
  readOnly: false,
  queryTimeout: 10000,
})
let password = ''
describe.skipIf(process.env.HARBOR_ORACLE !== '1')('real Oracle Thin transport boundaries', () => {
  beforeAll(async () => {
    const path = process.env.HARBOR_ORACLE_FIXTURE_ENV
    if (!path) throw new Error('Disposable Oracle credential file required.')
    password = /^ORACLE_TEST_PASSWORD=(.+)$/m.exec(await readFile(path, 'utf8'))?.[1] ?? ''
  })
  it('validates native TCPS hostname/CA trust with a real Oracle wire session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-oracle-tls-')),
      key = join(directory, 'key.pem'),
      cert = join(directory, 'cert.pem'),
      sockets = new Set<Socket>(),
      service = new OracleService()
    let proxy: tls.Server | undefined
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
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-keyout',
          key,
          '-out',
          cert,
        ],
        { stdio: 'ignore' },
      )
      const pem = await readFile(cert, 'utf8')
      proxy = tls.createServer({ key: await readFile(key), cert: pem }, (socket) => {
        sockets.add(socket)
        const remote = net.connect(25421, '127.0.0.1')
        sockets.add(remote)
        socket.on('error', () => remote.destroy())
        remote.on('error', () => socket.destroy())
        socket.on('close', () => {
          sockets.delete(socket)
          remote.destroy()
        })
        remote.on('close', () => {
          sockets.delete(remote)
          socket.destroy()
        })
        socket.pipe(remote).pipe(socket)
      })
      proxy.on('tlsClientError', () => {})
      await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve))
      const port = (proxy.address() as AddressInfo).port
      const trusted = {
        ...profile,
        port,
        tls: { enabled: true, rejectUnauthorized: true, ca: pem, cert: pem, keyPath: key },
      }
      const status = await service.connect(trusted, { password })
      expect(status.state, status.error).toBe('connected')
      expect(
        (
          await service.execute({
            connectionId: profile.id,
            sessionId: 'tls',
            requestId: randomUUID(),
            sql: 'SELECT 1 FROM DUAL',
            maxRows: 10,
            privateSession: false,
          })
        ).sets[0].rows,
      ).toEqual([['1']])
      const untrusted = await service.connect(
        {
          ...profile,
          id: 'oracle-untrusted',
          port,
          tls: { enabled: true, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
        },
        { password },
      )
      expect(untrusted.state).toBe('failed')
    } finally {
      await service.closeAll()
      for (const socket of sockets) socket.destroy()
      if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  it('closes a broken tab instead of silently reconnecting or restoring its transaction', async () => {
    const sockets = new Set<Socket>(),
      service = new OracleService()
    let connections = 0
    const proxy = net.createServer((socket) => {
      connections++
      sockets.add(socket)
      const remote = net.connect(25421, '127.0.0.1')
      sockets.add(remote)
      socket.on('error', () => remote.destroy())
      remote.on('error', () => socket.destroy())
      socket.once('close', () => {
        sockets.delete(socket)
        remote.destroy()
      })
      remote.once('close', () => {
        sockets.delete(remote)
        socket.destroy()
      })
      socket.pipe(remote).pipe(socket)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      expect(
        (await service.connect({ ...profile, port: (proxy.address() as AddressInfo).port }, { password }))
          .state,
      ).toBe('connected')
      await service.transaction({ connectionId: profile.id, sessionId: 'lost', action: 'begin' })
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const count = connections
      const query = {
        connectionId: profile.id,
        sessionId: 'lost',
        requestId: randomUUID(),
        sql: 'SELECT 1 FROM DUAL',
        maxRows: 10,
        privateSession: false,
      }
      await expect(service.execute(query)).rejects.toThrow('Oracle')
      expect(service.getSessionState({ connectionId: profile.id, sessionId: 'lost' })).toMatchObject({
        state: 'failed',
        connected: false,
        running: false,
      })
      await expect(service.execute(query)).rejects.toThrow('lost')
      expect(connections).toBe(count)
    } finally {
      await service.closeAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })
  it('uses the native round-trip/deadline cancellation and keeps credentials out of errors', async () => {
    const service = new OracleService()
    try {
      const status = await service.connect({ ...profile, queryTimeout: 1000 }, { password })
      expect(status.state, status.error).toBe('connected')
      const start = performance.now()
      await expect(
        service.execute({
          connectionId: profile.id,
          sessionId: 'timeout',
          requestId: randomUUID(),
          sql: 'BEGIN DBMS_SESSION.SLEEP(30); END;',
          maxRows: 10,
          privateSession: true,
          confirm: profile.name,
        }),
      ).rejects.toThrow('Oracle')
      expect(performance.now() - start).toBeLessThan(8000)
      const wrong = await service.connect(
        { ...profile, id: 'bad-auth' },
        { password: 'invalid-private-password' },
      )
      expect(wrong.state).toBe('failed')
      expect(wrong.error).not.toContain('invalid-private-password')
    } finally {
      await service.closeAll()
    }
  }, 15000)
  it('reports a lost COMMIT acknowledgement as uncertain without replaying the accepted batch', async () => {
    const table = 'ACK_' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
      admin = await oracledb.getConnection({
        user: profile.username,
        password,
        connectString: '127.0.0.1:25421/FREEPDB1',
      }),
      service = new OracleService(),
      sockets = new Set<Socket>()
    let dropped = 0
    const proxy = net.createServer((socket) => {
      const remote = net.connect(25421, '127.0.0.1')
      sockets.add(socket)
      sockets.add(remote)
      let pending = Buffer.alloc(0),
        dropReply = false
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 8) {
          // TNS v12+ uses four-byte lengths; the initial handshake uses two.
          const short = pending.readUInt16BE(0),
            size = short || pending.readUInt32BE(0)
          if (size < 8 || size > 1024 * 1024) {
            socket.destroy()
            remote.destroy()
            return
          }
          if (pending.length < size) break
          const packet = pending.subarray(0, size)
          pending = pending.subarray(size)
          // Native TTC function header: message 3, function 14 (COMMIT).
          if (packet[4] === 6 && packet[10] === 3 && packet[11] === 14) dropReply = true
          remote.write(packet)
        }
      })
      remote.on('data', (chunk) => {
        if (dropReply) {
          dropped++
          socket.destroy()
          remote.destroy()
        } else socket.write(chunk)
      })
      socket.on('error', () => remote.destroy())
      remote.on('error', () => socket.destroy())
      socket.on('close', () => {
        sockets.delete(socket)
        remote.destroy()
      })
      remote.on('close', () => {
        sockets.delete(remote)
        socket.destroy()
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      await admin.execute(`CREATE TABLE "${table}" (ID NUMBER(20) PRIMARY KEY)`)
      const status = await service.connect(
        { ...profile, id: 'oracle-commit-ack', port: (proxy.address() as AddressInfo).port },
        { password },
      )
      expect(status.state, status.error).toBe('connected')
      const writer = await service.openImport(
        { connectionId: 'oracle-commit-ack', schema: profile.schema, table, columns: ['ID'] },
        new AbortController().signal,
      )
      try {
        await expect(writer.writeBatch([['6001'], ['6002']])).rejects.toMatchObject({
          outcome: 'uncertain',
          rows: 2,
        })
      } finally {
        await writer.close()
      }
      expect(dropped).toBe(1)
      const rows = await admin.execute(
        'SELECT ID FROM "' + table + '" ORDER BY ID',
        {},
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      )
      expect(rows.rows).toEqual([[6001], [6002]])
    } finally {
      await service.closeAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      try {
        await admin.execute(`DROP TABLE "${table}" PURGE`)
      } finally {
        await admin.close()
      }
    }
  }, 30000)
})
