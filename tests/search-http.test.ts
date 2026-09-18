import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import { profileSchema } from '../src/shared/contracts'
import { parseSearchDsl, searchIndex } from '../src/main/engines/search-cluster'
import { SearchHttp, searchJson, encodeSearchJson, searchPrefix } from '../src/main/engines/search-http'
let server: http.Server | undefined
let client: SearchHttp | undefined
async function start(handler: http.RequestListener) {
  server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const profile = profileSchema.parse({
    id: 'test',
    name: 'test',
    engine: 'elasticsearch',
    host: '127.0.0.1',
    port: address.port,
    search: { auth: 'none' },
    queryTimeout: 1000,
  })
  client = new SearchHttp(profile, { host: '127.0.0.1', port: address.port, close: async () => {} }, {})
  return client
}
afterEach(async () => {
  client?.close()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  server = undefined
  client = undefined
})
describe('bounded search HTTP transport and exact DSL', () => {
  it('retains unsafe integer/decimal JSON tokens and rejects duplicate keys', () => {
    const raw = '{"n":9223372036854775807,"price":0.1234567890123456789}'
    expect(encodeSearchJson(searchJson(raw))).toBe(raw)
    expect(() => searchJson('{"x":1,"x":2}')).toThrow('duplicate')
  })
  it('rejects traversal, encoded separators and unexpected cluster/index scopes', () => {
    for (const path of ['http://host', '//host', '/a/../b', '/a?x', '/a#x', '/a%2fb', '/a\\b'])
      expect(() => searchPrefix(path)).toThrow()
    expect(searchPrefix('/proxy/search/')).toBe('/proxy/search')
    for (const index of ['remote:index', 'foo/bar', 'x?api', '_all'])
      expect(() => searchIndex(index)).toThrow()
    for (const index of ['a,b', 'a*', '.system']) expect(() => searchIndex(index, true)).toThrow('concrete')
  })
  it('enforces cursor-owned fields, hit counts and nested aggregation bounds', () => {
    for (const field of ['from', 'pit', 'search_after', 'collapse'])
      expect(() => parseSearchDsl(JSON.stringify({ [field]: 1 }), 10)).toThrow('controlled')
    expect(() => parseSearchDsl('{"size":1000}', 10)).toThrow('page-size')
    expect(() => parseSearchDsl('{"aggs":{"x":{"terms":{"field":"x","size":1001}}}}', 10)).toThrow('1000')
    expect(() =>
      parseSearchDsl(
        '{"aggs":{"x":{"terms":{"field":"x","size":1000},"aggs":{"y":{"terms":{"field":"y","size":1000}}}}}}',
        10,
      ),
    ).toThrow('10000')
  })
  it('refuses redirects without following or forwarding authorization', async () => {
    let requests = 0
    const transport = await start((_request, response) => {
      requests++
      response.writeHead(302, { Location: 'http://127.0.0.1:1/private' })
      response.end('{}')
    })
    await expect(transport.request('GET', '/')).rejects.toThrow('Redirect refused')
    expect(requests).toBe(1)
  })
  it('rejects response bodies above8MiB before JSON is returned', async () => {
    const transport = await start((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"data":"' + 'x'.repeat(8 * 1024 * 1024) + '"}')
    })
    await expect(transport.request('GET', '/')).rejects.toThrow(/8 MiB|aborted/)
  })
  it('reports deadline and HTTP abort without claiming server cancellation', async () => {
    const transport = await start(() => {})
    await expect(transport.request('GET', '/', undefined, undefined, 25)).rejects.toThrow(
      'completion is unconfirmed',
    )
    const controller = new AbortController()
    const request = transport.request('GET', '/', undefined, controller.signal)
    controller.abort()
    await expect(request).rejects.toThrow('Server cancellation is not confirmed')
  })
  it('does not expose arbitrary error response contents or accept invalid UTF8', async () => {
    const transport = await start((request, response) => {
      if (request.url === '/invalid') {
        response.end(Buffer.from([255]))
      } else {
        response.writeHead(401)
        response.end('{"error":{"type":"security_exception","reason":"password=never-copy-me"}}')
      }
    })
    await expect(transport.request('GET', '/')).rejects.toThrow('Authentication failed')
    await expect(transport.request('GET', '/')).rejects.not.toThrow('never-copy-me')
    await expect(transport.request('GET', '/invalid')).rejects.toThrow()
  })
})
