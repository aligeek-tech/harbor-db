import { afterEach, expect, it } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import { profileSchema } from '../src/shared/contracts'
import { TrinoHttp } from '../src/main/engines/trino-http'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address() as { port: number }
  const profile = profileSchema.parse({ id: 'protocol', name: 'Protocol', engine: 'trino', host: '127.0.0.1', port: address.port, username: 'fixture', queryTimeout: 1000 })
  const client = new TrinoHttp(profile, { host: profile.host, port: profile.port, close: async () => {} }, {})
  cleanup.push(() => client.close())
  return { server, profile, client }
}

it('keeps duplicate names, exact nested numbers, binary and native error locations without data leakage', async () => {
  const { client } = await fixture((_request, response) => response.end('{"id":"q1","columns":[{"name":"a","type":"decimal(38,18)"},{"name":"a","type":"array(bigint)"},{"name":"b","type":"varbinary"}],"data":[[12345678901234567890.123456789012345678,[9223372036854775807],"AP8="]],"stats":{"state":"FINISHED","processedRows":9007199254740993}}'))
  const result = await client.request('POST', '/v1/statement', { sql: 'SELECT synthetic' })
  expect(result?.rows).toEqual([['12345678901234567890.123456789012345678','[9223372036854775807]',{ type: 'binary', base64: 'AP8=' }]])
  expect(result?.processedRows).toBe('9007199254740993')
  expect(result?.columns?.map((column) => column.name)).toEqual(['a','a','b'])
})

it.each(['http://attacker.invalid/v1/statement/q/1','http://127.0.0.1:1/v1/statement/q/1','/v1/statement/q/1'])('rejects an untrusted continuation %s before any follow request', async (uri) => {
  let requests = 0
  const { client } = await fixture((_request, response) => { requests++; response.end(JSON.stringify({ id: 'q1', nextUri: uri })) })
  await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow(/continuation/)
  expect(requests).toBe(1)
})

it('never follows a redirect or replays a submitted statement after socket loss', async () => {
  let requests = 0
  const { client } = await fixture((request, response) => { requests++; if (requests === 1) { response.writeHead(307, { Location: 'http://attacker.invalid/' }); response.end() } else request.socket.destroy() })
  await expect(client.request('POST', '/v1/statement', { sql: 'INSERT synthetic' })).rejects.toThrow(/HTTP 307/)
  expect(requests).toBe(1)
  await expect(client.request('POST', '/v1/statement', { sql: 'INSERT other_synthetic' })).rejects.toThrow(/may have completed/)
  expect(requests).toBe(2)
})

it('bounds the native response, refuses spooling/compression and suppresses server messages', async () => {
  let mode = 0
  const { client } = await fixture((_request, response) => {
    if (mode === 0) response.end('x'.repeat(8 * 1024 * 1024 + 1))
    else if (mode === 1) response.end(JSON.stringify({ id: 'q', data: { segments: [{ uri: 'https://storage.invalid/private' }] } }))
    else if (mode === 2) { response.setHeader('Content-Encoding', 'gzip'); response.end('data') }
    else response.end(JSON.stringify({ id: 'q', error: { errorName: 'PERMISSION_DENIED', message: 'secret result and password', errorLocation: { lineNumber: 3, columnNumber: 8 } } }))
  })
  await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow(/exceeded 8 MiB/)
  mode++; await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow(/spooled/)
  mode++; await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow(/uncompressed/)
  mode++; await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow('Trino PERMISSION_DENIED at line 3, column 8.')
})

it('requires verified TLS before authenticating and validates coordinator cursor authority', async () => {
  const { client, profile } = await fixture((_request, response) => response.end())
  expect(() => new TrinoHttp({ ...profile, trino: { auth: 'basic', timeZone: 'UTC' } }, { host: profile.host, port: profile.port, close: async () => {} }, { password: 'synthetic' })).toThrow(/verified TLS/)
  const origin = `http://${profile.host}:${profile.port}`
  expect(client.continuation(`${origin}/v1/statement/queued/q1/token/0`)).toBe('/v1/statement/queued/q1/token/0')
  for (const suffix of ['/v1/statement/q?a=b','/v1/statement/q#hash','/v1/statement/%2e%2e/private','/other/q']) expect(() => client.continuation(origin + suffix)).toThrow()
})


it('omits malformed response data from parser failures', async () => {
  const { client } = await fixture((_request, response) => response.end('{"private-data":"sensitive-value" BAD}'))
  await expect(client.request('POST', '/v1/statement', { sql: 'SELECT 1' })).rejects.toThrow('Trino returned invalid bounded JSON; response contents are omitted.')
})
