import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudJson, exact } from '../src/main/engines/cloud-json'

const clients: CloudJson[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  vi.restoreAllMocks()
})
function fixture(payload: Buffer, encoding = 'identity', status = 200, gzip = false) {
  const observed: https.RequestOptions[] = []
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    observed.push(options)
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void }
    request.end = () =>
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), {
          headers: { 'content-encoding': encoding, location: 'https://other.invalid/' },
          statusCode: status,
        })
        callback(response)
        response.end(payload)
      })
    request.destroy = (error) => {
      if (error) request.emit('error', error)
    }
    return request
  }) as typeof https.request)
  const client = new CloudJson('synthetic.googleapis.com', 'synthetic-token', 1000, {}, undefined, gzip)
  clients.push(client)
  return { client, observed }
}

it('decodes bounded gzip while preserving exact numeric JSON tokens and verified fixed TLS target', async () => {
  const { client, observed } = fixture(gzipSync('{"integer":9223372036854775807}'), 'gzip', 200, true)
  expect(exact((await client.request('POST', '/api', { value: 1 })).integer)).toBe('9223372036854775807')
  expect(observed[0]).toMatchObject({
    host: 'synthetic.googleapis.com',
    port: 443,
    path: '/api',
    headers: { 'Accept-Encoding': 'gzip' },
  })
  expect((observed[0].agent as https.Agent).options.rejectUnauthorized).toBe(true)
})

it('rejects a compressed expansion above the decoded page bound', async () => {
  const { client } = fixture(gzipSync('{"value":"' + 'x'.repeat(33 * 1024 * 1024) + '"}'), 'gzip', 200, true)
  await expect(client.request('GET', '/api')).rejects.toThrow('Provider page exceeds 32 MiB')
})

it('refuses redirects without forwarding authorization or replaying the request', async () => {
  const { client, observed } = fixture(Buffer.from('{}'), 'identity', 302)
  await expect(client.request('GET', '/api')).rejects.toThrow('HTTP 302')
  expect(observed).toHaveLength(1)
})

it('omits malformed JSON and provider error bodies from errors', async () => {
  const { client } = fixture(Buffer.from('{"secret":"never-copy-canary", broken'))
  await expect(client.request('GET', '/api')).rejects.toThrow('response contents are omitted')
  await expect(client.request('GET', '/api')).rejects.not.toThrow('never-copy-canary')
})

it('rejects unexpected compression and cancellation before network dispatch', async () => {
  const { client, observed } = fixture(gzipSync('{}'), 'gzip')
  await expect(client.request('GET', '/api')).rejects.toThrow('unsupported content encoding')
  const controller = new AbortController()
  controller.abort()
  await expect(client.request('POST', '/api', {}, controller.signal)).rejects.toThrow('before dispatch')
  expect(observed).toHaveLength(1)
})
