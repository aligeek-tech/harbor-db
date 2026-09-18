import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { searchMutationConfirmation, type SearchInput, type SearchMutationInput } from '../src/shared/search'
import { ElasticsearchService } from '../src/main/engines/elasticsearch'
import { OpenSearchService } from '../src/main/engines/opensearch'
import { SearchHttp, searchObject } from '../src/main/engines/search-http'
import { openTransport } from '../src/main/engines/transport'

const privateFile = process.env.HARBOR_SEARCH_TEST_ENV_FILE
const products = (process.env.HARBOR_SEARCH_TEST_PRODUCTS || 'elasticsearch,opensearch').split(',')
for (const product of ['elasticsearch', 'opensearch'] as const) {
  describe.skipIf(!privateFile || !products.includes(product))(`real ${product} search workflow`, () => {
    const index = 'harbor_test_' + randomUUID().replaceAll('-', '')
    let service: ElasticsearchService | OpenSearchService
    let client: SearchHttp
    let profile: ConnectionProfile
    let password: string
    async function bulk(body: string) {
      await new Promise<void>((resolve, reject) => {
        const request = (product === 'opensearch' ? https : http).request(
          {
            hostname: '127.0.0.1',
            port: product === 'opensearch' ? 19201 : 19200,
            path: '/_bulk?refresh=true',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
              Authorization: 'Basic ' + Buffer.from(profile.username + ':' + password).toString('base64'),
              'Content-Type': 'application/x-ndjson',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.once('error', reject)
            response.once('end', () => {
              const result = JSON.parse(Buffer.concat(chunks).toString())
              if (response.statusCode !== 200 || result.errors)
                reject(new Error('Disposable bulk fixture failed.'))
              else resolve()
            })
          },
        )
        request.once('error', reject)
        request.end(body)
      })
    }
    beforeAll(async () => {
      const contents = await readFile(privateFile!, 'utf8')
      const key =
        product === 'opensearch' ? 'HARBOR_OPENSEARCH_TEST_PASSWORD' : 'HARBOR_ELASTIC_TEST_PASSWORD'
      password =
        contents
          .split('\n')
          .find((line) => line.startsWith(key + '='))
          ?.slice(key.length + 1) || ''
      if (!password) throw new Error('Missing disposable search fixture credential.')
      profile = profileSchema.parse({
        id: randomUUID(),
        name: 'Disposable ' + product,
        engine: product,
        host: '127.0.0.1',
        port: product === 'opensearch' ? 19201 : 19200,
        username: product === 'opensearch' ? 'admin' : 'elastic',
        readOnly: false,
        tls: { enabled: product === 'opensearch', rejectUnauthorized: false },
        search: { auth: 'basic', pathPrefix: '' },
      })
      service = product === 'elasticsearch' ? new ElasticsearchService() : new OpenSearchService()
      const status = await service.connect(profile, { password })
      expect(status, status.error).toMatchObject({ state: 'connected' })
      client = new SearchHttp(profile, await openTransport(profile), { password })
      await client.request('PUT', '/' + index, {
        settings: { number_of_shards: 2, number_of_replicas: 0 },
        mappings: {
          properties: {
            rank: { type: 'integer' },
            label: { type: 'keyword' },
            huge: { type: 'long' },
            price: { type: 'double' },
          },
        },
        aliases: { [index + '_alias']: {} },
      })
      let body = ''
      for (let rank = 0; rank < 10003; rank++)
        body +=
          JSON.stringify({ index: { _index: index, _id: String(rank) } }) +
          '\n' +
          `{"rank":${rank},"label":"group${rank % 2}","huge":9223372036854775807,"price":0.1234567890123456789}\n`
      await bulk(body)
    }, 60000)
    afterAll(async () => {
      await service?.closeAll()
      if (client) {
        await client.request('DELETE', '/' + index).catch(() => {})
        client.close()
      }
    }, 20000)
    function search(overrides: Partial<SearchInput> = {}) {
      return service.search({
        connectionId: profile.id,
        sessionId: 'search-tab',
        requestId: randomUUID(),
        index,
        dsl: '{"query":{"match_all":{}},"sort":[{"rank":"asc"}]}',
        pageSize: 1000,
        ...overrides,
      })
    }
    function mutation(
      operation: SearchMutationInput['operation'],
      id: string,
      rest: Partial<SearchMutationInput> = {},
    ) {
      const input = {
        connectionId: profile.id,
        sessionId: 'write-tab',
        requestId: randomUUID(),
        index,
        id,
        operation,
        ...rest,
      }
      return service.mutate({ ...input, confirm: searchMutationConfirmation(input, profile) })
    }
    it('verifies distinct product identity, basic authentication and real catalog/mappings/aliases', async () => {
      const catalog = await service.catalog({ connectionId: profile.id })
      expect(catalog.engine).toBe(product)
      expect(catalog.indices).toContainEqual(
        expect.objectContaining({ name: index, aliases: [index + '_alias'], documents: '10003' }),
      )
      const mappings = await service.mappings({ connectionId: profile.id, index })
      expect(mappings.mappingsJson).toContain('"huge":{"type":"long"}')
      const wrong = product === 'elasticsearch' ? new OpenSearchService() : new ElasticsearchService()
      try {
        expect(
          await wrong.connect(
            { ...profile, engine: product === 'elasticsearch' ? 'opensearch' : 'elasticsearch' },
            { password },
          ),
        ).toMatchObject({ state: 'failed', error: expect.stringMatching(/not verified/) })
      } finally {
        await wrong.closeAll()
      }
      expect(
        await service.connect({ ...profile, id: randomUUID() }, { password: 'wrong-disposable-password' }),
      ).toMatchObject({ state: 'failed', error: expect.stringContaining('Authentication failed') })
    })
    it('keeps source numeric tokens exact and returns bounded query-wide aggregations', async () => {
      const result = await search({
        pageSize: 5,
        dsl: '{"query":{"match_all":{}},"aggs":{"labels":{"terms":{"field":"label","size":5}}}}',
      })
      expect(result.hits).toHaveLength(5)
      expect(result.hits[0].sourceJson).toContain('9223372036854775807')
      expect(result.hits[0].sourceJson).toContain('0.1234567890123456789')
      expect(result.aggregationsJson).toContain('"doc_count":5002')
      expect(result.total).toEqual({ value: '10000', relation: 'gte' })
      expect(result.hits[0].seqNo).toMatch(/^\d+$/)
      await service.closeCursor({
        connectionId: profile.id,
        sessionId: 'search-tab',
        cursor: result.nextCursor!,
      })
      const aggregation = await search({
        pageSize: 0,
        dsl: '{"aggs":{"count":{"value_count":{"field":"rank"}}}}',
      })
      expect(aggregation.hits).toEqual([])
      expect(aggregation.nextCursor).toBeUndefined()
      expect(aggregation.aggregationsJson).toContain('10003')
    })
    it('pages past10000 with PIT/search_after and excludes concurrent writes from the snapshot', async () => {
      let result = await search()
      const ids = result.hits.map((hit) => hit.id)
      expect(result.nextCursor).toBeDefined()
      await mutation('create', 'snapshot-late', { document: '{"rank":20000,"label":"late"}' })
      while (result.nextCursor) {
        result = await search({ cursor: result.nextCursor })
        ids.push(...result.hits.map((hit) => hit.id))
      }
      expect(ids).toHaveLength(10003)
      expect(new Set(ids).size).toBe(10003)
      expect(ids).not.toContain('snapshot-late')
      const live = await service.document({ connectionId: profile.id, index, id: 'snapshot-late' })
      await mutation('delete', live.id, { seqNo: live.seqNo, primaryTerm: live.primaryTerm })
    }, 30000)
    it('binds cursors to exact connection/tab/query inputs and invalidates closed snapshots', async () => {
      const result = await search({ pageSize: 2 })
      const cursor = result.nextCursor!
      await expect(search({ cursor, pageSize: 2, sessionId: 'wrong-tab' })).rejects.toThrow(
        'different search inputs',
      )
      await expect(search({ cursor, pageSize: 2, dsl: '{"query":{"match_none":{}}}' })).rejects.toThrow(
        'different search inputs',
      )
      const current = await search({ pageSize: 2 })
      await service.closeSession({ connectionId: profile.id, sessionId: 'search-tab' })
      await expect(search({ cursor: current.nextCursor, pageSize: 2 })).rejects.toThrow(/expired|different/)
    })
    it('reviews create/replace/delete and rejects stale sequence tokens without overwriting', async () => {
      expect(
        await mutation('create', 'reviewed', {
          document: '{"label":"日本語 فارسی 🌊","huge":9223372036854775807}',
        }),
      ).toMatchObject({ result: 'created' })
      await expect(mutation('create', 'reviewed', { document: '{}' })).rejects.toThrow('Conflict')
      const original = await service.document({ connectionId: profile.id, index, id: 'reviewed' })
      expect(original.sourceJson).toContain('9223372036854775807')
      expect(
        await mutation('replace', 'reviewed', {
          document: '{"label":"updated"}',
          seqNo: original.seqNo,
          primaryTerm: original.primaryTerm,
        }),
      ).toMatchObject({ result: 'updated' })
      await expect(
        mutation('delete', 'reviewed', { seqNo: original.seqNo, primaryTerm: original.primaryTerm }),
      ).rejects.toThrow('Conflict')
      expect((await service.document({ connectionId: profile.id, index, id: 'reviewed' })).sourceJson).toBe(
        '{"label":"updated"}',
      )
      const current = await service.document({ connectionId: profile.id, index, id: 'reviewed' })
      expect(
        await mutation('delete', 'reviewed', { seqNo: current.seqNo, primaryTerm: current.primaryTerm }),
      ).toMatchObject({ result: 'deleted' })
      await expect(service.document({ connectionId: profile.id, index, id: 'reviewed' })).rejects.toThrow(
        'unavailable',
      )
    }, 15000)
    it('preserves explicit routing and rejects readonly or alias writes', async () => {
      await mutation('create', 'routed', {
        document: '{"rank":-1,"label":"routed"}',
        routing: 'tenant-local',
      })
      const result = await search({ pageSize: 5, dsl: '{"query":{"term":{"label":"routed"}}}' })
      expect(result.hits[0].routing).toBe('tenant-local')
      const doc = await service.document({
        connectionId: profile.id,
        index,
        id: 'routed',
        routing: result.hits[0].routing,
      })
      await mutation('delete', 'routed', {
        routing: doc.routing,
        seqNo: doc.seqNo,
        primaryTerm: doc.primaryTerm,
      })
      await expect(
        mutation('create', 'alias-write', { index: index + '_alias', document: '{}' }),
      ).rejects.toThrow('concrete index')
      const readOnly = { ...profile, id: randomUUID(), readOnly: true }
      expect(await service.connect(readOnly, { password })).toMatchObject({ state: 'connected' })
      await expect(
        mutation('create', 'readonly', { connectionId: readOnly.id, document: '{}' }),
      ).rejects.toThrow('read-only')
    }, 15000)
    it('keeps invalid DSL, transport cancellation and strict TLS outcomes explicit', async () => {
      await expect(search({ dsl: '{"query":{"unknown_query":{}}}' })).rejects.toThrow('request failed')
      await expect(search({ dsl: '{"from":10000}' })).rejects.toThrow('controlled')
      const requestId = randomUUID()
      const waiting = search({
        requestId,
        dsl: '{"query":{"script":{"script":{"source":"long sum=0; for(int i=0;i<10000;i++){sum+=i;} return sum>0;"}}}}',
      })
      // The service claims synchronously before its first network request.
      const cancel = await service.cancel({ connectionId: profile.id, sessionId: 'search-tab', requestId })
      expect(cancel).toMatchObject({ requested: true, serverCancellationConfirmed: false })
      await expect(waiting).rejects.toThrow(/stopped|cancel/i)
      if (product === 'opensearch')
        expect(
          await service.connect(
            { ...profile, id: randomUUID(), tls: { ...profile.tls, rejectUnauthorized: true } },
            { password },
          ),
        ).toMatchObject({ state: 'failed', error: expect.stringMatching(/certificate|self.signed|verify/i) })
      expect(searchObject((await client.request('GET', '/')).body).version).toBeDefined()
    })
    it('declares API-key authentication separately and respects its index permissions', async () => {
      if (product === 'opensearch') {
        expect(
          await service.connect(
            { ...profile, id: randomUUID(), search: { auth: 'api-key', pathPrefix: '' } },
            { password: 'not-an-opensearch-api-key' },
          ),
        ).toMatchObject({ state: 'failed', error: expect.stringContaining('only for Elasticsearch') })
        return
      }
      const key = searchObject(
        (
          await client.request('POST', '/_security/api_key', {
            name: 'harbor-disposable-' + randomUUID(),
            expiration: '1h',
            role_descriptors: {
              fixture_read: {
                cluster: ['monitor'],
                indices: [{ names: [index], privileges: ['read', 'view_index_metadata'] }],
              },
            },
          })
        ).body,
      )
      if (typeof key.id !== 'string' || typeof key.encoded !== 'string')
        throw new Error('Fixture did not issue an API key.')
      try {
        const restricted = {
          ...profile,
          id: randomUUID(),
          search: { auth: 'api-key' as const, pathPrefix: '' },
        }
        expect(await service.connect(restricted, { password: key.encoded })).toMatchObject({
          state: 'connected',
        })
        expect(
          (await service.document({ connectionId: restricted.id, index, id: '1' })).sourceJson,
        ).toContain('9223372036854775807')
        await expect(
          mutation('create', 'forbidden-api-key', { connectionId: restricted.id, document: '{}' }),
        ).rejects.toThrow('Permission denied')
        await client.request('DELETE', '/_security/api_key', { ids: [key.id] })
        await expect(service.document({ connectionId: restricted.id, index, id: '1' })).rejects.toThrow(
          'Authentication failed',
        )
        expect(service.status(restricted.id).state).toBe('authentication-failed')
      } finally {
        await client.request('DELETE', '/_security/api_key', { ids: [key.id] })
      }
    })
  })
}
