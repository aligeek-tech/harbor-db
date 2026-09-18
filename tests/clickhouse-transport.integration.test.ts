import { createServer as httpServer, request } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, ClickHouseLogLevel } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/main/engines/clickhouse'
import { profileSchema } from '../src/shared/contracts'
import { clickhouseQuote } from '../src/shared/clickhouse'

const profile = profileSchema.parse({
    id: 'clickhouse-transport',
    name: 'Disposable ClickHouse transport',
    engine: 'clickhouse',
    host: '127.0.0.1',
    port: 18123,
    username: 'harbor',
    database: 'harbor',
    readOnly: false,
    queryTimeout: 10000,
  }),
  secrets = { password: 'harbor_test' }
const service = new ClickhouseService(),
  admin = createClient({
    url: 'http://127.0.0.1:18123',
    username: 'harbor',
    password: secrets.password,
    database: 'harbor',
    log: { level: ClickHouseLogLevel.OFF },
  })
const table = 'transport_' + randomUUID().replaceAll('-', '')
describe.skipIf(process.env.HARBOR_CLICKHOUSE !== '1')(
  'real ClickHouse HTTP transport failure boundaries',
  () => {
    beforeAll(async () => {
      await admin.command({
        query: `CREATE TABLE ${clickhouseQuote(table)} (id UInt64) ENGINE=MergeTree ORDER BY id`,
      })
    })
    afterAll(async () => {
      await service.closeAll()
      await admin.command({ query: `DROP TABLE IF EXISTS ${clickhouseQuote(table)} SYNC` })
      await admin.close()
    })
    it('keeps native private parameters out of request URLs and preserves escaped values', async () => {
      const urls: string[] = []
      const proxy = httpServer((incoming, outgoing) => {
        urls.push(incoming.url ?? '')
        const remote = request(
          {
            hostname: '127.0.0.1',
            port: 18123,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 500, response.headers)
            response.pipe(outgoing)
          },
        )
        remote.on('error', () => outgoing.destroy())
        incoming.pipe(remote)
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const id = 'clickhouse-private-url'
      try {
        expect(
          (await service.connect({ ...profile, id, port: (proxy.address() as AddressInfo).port }, secrets))
            .state,
        ).toBe('connected')
        const value = "private-probe\n\t\\N'😀"
        const result = await service.execute({
          connectionId: id,
          sessionId: 'query',
          requestId: randomUUID(),
          sql: 'SELECT {value:String}',
          parameters: [{ name: 'value', value, type: 'text', secret: true }],
          maxRows: 10,
          privateSession: true,
        })
        expect(result.sets[0].rows).toEqual([[value]])
        expect(urls.some((url) => url.includes('param_value') || url.includes('private-probe'))).toBe(false)
      } finally {
        await service.disconnect(id)
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
      }
    })
    it('marks a lost append acknowledgement uncertain and never repeats the accepted insert', async () => {
      let dropped = 0
      const proxy = httpServer((incoming, outgoing) => {
        const isInsert = new URL(incoming.url ?? '/', 'http://fixture').searchParams
          .get('query')
          ?.startsWith('INSERT INTO')
        const remote = request(
          {
            hostname: '127.0.0.1',
            port: 18123,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            if (isInsert && response.statusCode === 200) {
              response.resume()
              response.once('end', () => {
                dropped++
                outgoing.destroy()
              })
            } else {
              outgoing.writeHead(response.statusCode ?? 500, response.headers)
              response.pipe(outgoing)
            }
          },
        )
        remote.on('error', () => outgoing.destroy())
        incoming.pipe(remote)
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const id = 'clickhouse-lost-ack'
      try {
        expect(
          (await service.connect({ ...profile, id, port: (proxy.address() as AddressInfo).port }, secrets))
            .state,
        ).toBe('connected')
        const writer = await service.openImport(
          { connectionId: id, schema: 'harbor', table, columns: ['id'], consentNonTransactionalAppend: true },
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
        const result = await admin.query({
          query: `SELECT id FROM ${clickhouseQuote(table)} ORDER BY id`,
          format: 'JSONEachRow',
        })
        expect(await result.json()).toEqual([{ id: 6001 }, { id: 6002 }])
      } finally {
        await service.disconnect(id)
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
      }
    })
    it('verifies HTTPS certificates against the original target and rejects untrusted roots', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-clickhouse-tls-')),
        key = join(directory, 'key.pem'),
        cert = join(directory, 'cert.pem')
      let proxy: ReturnType<typeof httpsServer> | undefined
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
        const ca = await readFile(cert, 'utf8')
        proxy = httpsServer({ key: await readFile(key), cert: ca }, (incoming, outgoing) => {
          const remote = request(
            {
              hostname: '127.0.0.1',
              port: 18123,
              path: incoming.url,
              method: incoming.method,
              headers: incoming.headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 500, response.headers)
              response.pipe(outgoing)
            },
          )
          remote.on('error', () => outgoing.destroy())
          incoming.pipe(remote)
        })
        await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve))
        const secure = {
          ...profile,
          id: 'clickhouse-tls',
          port: (proxy.address() as AddressInfo).port,
          tls: { ...profile.tls, enabled: true, ca },
        }
        const state = await service.connect(secure, secrets)
        expect(state.state, state.error).toBe('connected')
        expect(state.transport).toBe('HTTPS')
        const rejected = await service.connect(
          { ...secure, id: 'clickhouse-tls-untrusted', tls: { ...secure.tls, ca: '' } },
          secrets,
        )
        expect(rejected.state).toBe('failed')
      } finally {
        await service.disconnect('clickhouse-tls')
        await service.disconnect('clickhouse-tls-untrusted')
        if (proxy) {
          proxy.closeAllConnections()
          await new Promise<void>((resolve) => proxy!.close(() => resolve()))
        }
        await rm(directory, { recursive: true, force: true })
      }
    })
  },
)
