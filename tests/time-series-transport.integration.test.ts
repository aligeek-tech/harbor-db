import { it, expect } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { profileSchema } from '../src/shared/contracts'
import { seriesQuerySchema } from '../src/shared/time-series'
import { TimeSeriesService } from '../src/main/engines/time-series'
const fixture = process.env.HARBOR_TIME_SERIES_FIXTURE
it.skipIf(!fixture)(
  'real Influx via verified TLS; rejects unknown CA/hostname and cancels only a matching local request',
  async () => {
    const directory = dirname(fixture!),
      secrets = JSON.parse(await readFile(fixture!, 'utf8')),
      ca = await readFile(join(directory, 'tls-cert.pem'), 'utf8'),
      key = await readFile(join(directory, 'tls-key.pem'), 'utf8'),
      service = new TimeSeriesService()
    let pause = false,
      arrived: () => void = () => {}
    const received = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const server = https.createServer({ cert: ca, key }, (req, res) => {
      if (pause && req.url?.startsWith('/api/v2/query')) {
        arrived()
        return
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: 18086, path: req.url, method: req.method, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode || 502, reply.headers)
          reply.pipe(res)
        },
      )
      upstream.on('error', () => res.destroy())
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const profile = profileSchema.parse({
      id: 'influx-tls',
      name: 'influx TLS',
      engine: 'influxdb',
      host: '127.0.0.1',
      port,
      timeSeries: { orgId: secrets.influxOrgId },
      tls: { enabled: true, ca, rejectUnauthorized: true },
    })
    try {
      expect(await service.connect(profile, { password: secrets.influxToken })).toMatchObject({
        state: 'connected',
      })
      expect(
        await service.connect(
          { ...profile, id: 'bad-ca', tls: { ...profile.tls, ca: '' } },
          { password: secrets.influxToken },
        ),
      ).toMatchObject({ state: 'failed' })
      expect(
        await service.connect(
          { ...profile, id: 'bad-host', host: 'localhost' },
          { password: secrets.influxToken },
        ),
      ).toMatchObject({ state: 'failed' })
      const query = seriesQuerySchema.parse({
        connectionId: profile.id,
        sessionId: 'tab',
        requestId: crypto.randomUUID(),
        source: 'metrics',
        measurement: 'harbor_exact',
        field: 'unsigned',
        start: '2026-01-01T00:00:00Z',
        stop: '2026-01-02T00:00:00Z',
      })
      const result = await service.query(query)
      expect(result.sets.flatMap((s) => s.rows).flat()).toContain('18446744073709551615')
      pause = true
      query.requestId = crypto.randomUUID()
      const pending = service.query(query)
      const rejected = expect(pending).rejects.toThrow(/unconfirmed|cancelled|interrupted/i)
      await received
      expect(service.cancel({ ...query, sessionId: 'different-tab' }).requested).toBe(false)
      expect(service.cancel(query)).toMatchObject({
        requested: true,
        message: expect.stringContaining('unconfirmed'),
      })
      await rejected
    } finally {
      await service.closeAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  15000,
)
