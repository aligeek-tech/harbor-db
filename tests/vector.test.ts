import { describe, expect, it, vi } from 'vitest'
import { VectorService } from '../src/main/engines/vector'
import { profileSchema } from '../src/shared/contracts'
import { vectorConfirmation } from '../src/shared/vector'

const profile = (engine: 'qdrant' | 'milvus' | 'weaviate' | 'pinecone') =>
  profileSchema.parse({
    id: engine,
    name: engine,
    engine,
    host: engine === 'pinecone' ? 'api.pinecone.io' : '127.0.0.1',
    port: engine === 'qdrant' ? 6333 : engine === 'milvus' ? 19530 : engine === 'weaviate' ? 8080 : 443,
    database: engine === 'milvus' ? 'default' : '',
    readOnly: false,
    tls: { enabled: engine === 'pinecone', rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
  })

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('bounded vector provider adapter', () => {
  it('uses Qdrant collection/query APIs, hides vectors by default and guards mutations', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/') return response({ version: '1.14.1' })
      if (path === '/collections') return response({ result: { collections: [{ name: 'docs' }] } })
      if (path === '/collections/docs') return response({ result: { status: 'green', points_count: 10, indexed_vectors_count: 9, segments_count: 2, config: { params: { vectors: { size: 3, distance: 'Cosine' } } } } })
      if (path.endsWith('/points/query')) return response({ result: { points: [{ id: 1, score: 0.9, payload: { title: 'a' }, vector: [1, 2, 3] }] } })
      if (path.endsWith('/points')) return response({ status: 'ok' })
      throw new Error(`unexpected ${path} ${init?.method}`)
    })
    const service = new VectorService(fetcher)
    await service.connect(profile('qdrant'), { password: 'QDRANT_PRIVATE' })
    expect(await service.collections('qdrant')).toMatchObject([{ name: 'docs', dimension: 3, metric: 'Cosine', records: 10 }])
    const result = await service.search({ connectionId: 'qdrant', collection: 'docs', requestId: crypto.randomUUID(), vector: [0.1, 0.2, 0.3], limit: 10, includeVectors: false })
    expect(result.hits[0]).toEqual({ id: '1', score: 0.9, payload: { title: 'a' } })
    const mutation = { connectionId: 'qdrant', collection: 'docs', action: 'upsert' as const, id: 1, vector: [1, 2, 3], payload: {}, confirm: '' }
    await expect(service.mutate(mutation)).rejects.toThrow('exact visible')
    await expect(service.mutate({ ...mutation, confirm: vectorConfirmation(mutation) })).resolves.toMatchObject({ acknowledged: true })
    const queryCall = fetcher.mock.calls.find(([url]) => String(url).includes('/points/query'))!
    expect(JSON.parse(String(queryCall[1]!.body))).toMatchObject({ limit: 10, with_vector: false })
    expect(queryCall[1]!.headers).toMatchObject({ 'api-key': 'QDRANT_PRIVATE' })
  })

  it('uses Milvus REST v2 schema/search endpoints and sends only explicit scalar expressions', async () => {
    const paths: string[] = []
    const service = new VectorService(async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path)
      if (path.endsWith('/collections/list')) return response({ code: 0, data: ['items'] })
      if (path.endsWith('/collections/describe')) return response({ code: 0, data: { fields: [{ fieldName: 'id', dataType: 'Int64', isPrimary: true }, { fieldName: 'embedding', dataType: 'FloatVector', elementTypeParams: { dim: '2' } }], shardsNum: 1 } })
      if (path.endsWith('/entities/search')) {
        expect(JSON.parse(String(init!.body))).toMatchObject({ collectionName: 'items', filter: 'price > 10', limit: 5 })
        return response({ code: 0, data: [{ id: 7, distance: 0.2, title: 'bounded' }] })
      }
      throw new Error(`unexpected ${path}`)
    })
    await service.connect(profile('milvus'))
    expect(await service.collections('milvus')).toMatchObject([{ name: 'items', dimension: 2 }])
    const result = await service.search({ connectionId: 'milvus', collection: 'items', requestId: crypto.randomUUID(), vector: [1, 2], filter: { expression: 'price > 10' }, limit: 5, includeVectors: false })
    expect(result.hits[0]?.id).toBe('7')
    expect(paths.every((path) => path.startsWith('/v2/vectordb/'))).toBe(true)
  })

  it('checks Weaviate version/schema and treats unsupported filter translation explicitly', async () => {
    const service = new VectorService(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/meta') return response({ version: '1.39.0' })
      if (path === '/v1/schema') return response({ classes: [{ class: 'Article', vectorizer: 'none', vectorIndexType: 'hnsw', vectorIndexConfig: { distance: 'cosine' }, properties: [{ name: 'title' }] }] })
      if (path === '/v1/graphql') {
        expect(String(init!.body)).toContain('nearVector')
        return response({ data: { Get: { Article: [{ title: 'a', _additional: { id: crypto.randomUUID(), distance: 0.1 } }] } } })
      }
      throw new Error(`unexpected ${path}`)
    })
    await service.connect(profile('weaviate'))
    await service.collections('weaviate')
    await expect(service.search({ connectionId: 'weaviate', collection: 'Article', requestId: crypto.randomUUID(), vector: [1, 2], filter: { title: 'x' }, limit: 2, includeVectors: false })).rejects.toThrow('no query was sent')
    const result = await service.search({ connectionId: 'weaviate', collection: 'Article', requestId: crypto.randomUUID(), vector: [1, 2], limit: 2, includeVectors: false })
    expect(result.hits[0]?.payload).toEqual({ title: 'a' })
  })

  it('discovers Pinecone index hosts, scopes keys, reports usage and never simulates enumeration', async () => {
    const key = 'PINECONE_PRIVATE'
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      expect(init!.headers).toMatchObject({ 'Api-Key': key, 'X-Pinecone-Api-Version': '2025-04' })
      if (parsed.hostname === 'api.pinecone.io' && parsed.pathname === '/indexes') return response({ indexes: [{ name: 'docs', dimension: 2, metric: 'cosine', host: 'docs.example.pinecone.io', status: { ready: true, state: 'Ready' } }] })
      if (parsed.host === 'docs.example.pinecone.io' && parsed.pathname === '/query') return response({ matches: [{ id: 'a', score: 0.8, metadata: { source: 'x' } }], usage: { readUnits: 1 } })
      throw new Error(`unexpected ${parsed.href}`)
    })
    const service = new VectorService(fetcher)
    await service.connect(profile('pinecone'), { password: key })
    expect(await service.collections('pinecone')).toMatchObject([{ name: 'docs', dimension: 2, metric: 'cosine' }])
    const result = await service.search({ connectionId: 'pinecone', collection: 'docs', namespace: 'tenant-a', requestId: crypto.randomUUID(), vector: [1, 2], limit: 3, includeVectors: false })
    expect(result.usage).toEqual({ readUnits: 1 })
    expect(result.warnings[0]).toContain('does not guarantee')
    expect(JSON.stringify(result)).not.toContain(key)
  })
})


describe('vector release safety boundaries', () => {
  it('preserves uint64 ids and nested numeric lexemes without replaying rounded JSON', async () => {
    let submitted = ''
    const service = new VectorService(async (url, init) => {
      if(new URL(String(url)).pathname === '/') return response({version:'1'})
      if(String(url).includes('/query')) return new Response('{"result":{"points":[{"id":18446744073709551615,"score":0.25,"payload":{"n":9223372036854775807,"decimal":0.123456789012345678901,"a":[-0,1e30]},"vector":[1,0]}]}}')
      submitted = String(init?.body);return response({status:'ok'})
    })
    await service.connect(profile('qdrant'))
    const target={connectionId:'qdrant',collection:'docs'}
    const result=await service.search({...target,requestId:crypto.randomUUID(),vector:[1,0],limit:1,includeVectors:true})
    expect(result.hits[0]).toMatchObject({id:'18446744073709551615',score:0.25,vector:[1,0],payload:{n:'9223372036854775807',decimal:'0.123456789012345678901',a:['-0','1e30']}})
    await service.mutate({...target,action:'upsert',id:result.hits[0].id,vector:[1,0],payload:{},payloadJson:'{"n":9223372036854775807,"decimal":0.123456789012345678901}',confirm:vectorConfirmation(target)})
    expect(submitted).toContain('"id":18446744073709551615')
    expect(submitted).toContain('"n":9223372036854775807')
    expect(submitted).toContain('0.123456789012345678901')
    await expect(service.mutate({...target,action:'delete',id:Number.MAX_SAFE_INTEGER+1,confirm:vectorConfirmation(target)})).rejects.toThrow()
    await service.closeAll()
  })
  it('omits provider errors and rejects Pinecone credential redirection', async () => {
    const service=new VectorService(async url=>String(url).endsWith('/')?response({version:'1'}):new Response('CANARY_SECRET',{status:500}))
    await service.connect(profile('qdrant'))
    await expect(service.search({connectionId:'qdrant',collection:'docs',requestId:crypto.randomUUID(),vector:[1],limit:1,includeVectors:false})).rejects.toThrow('Provider details omitted')
    const fetcher=vi.fn(async()=>response({indexes:[{name:'docs',host:'attacker.example'}]}))
    const pine=new VectorService(fetcher);await pine.connect(profile('pinecone'),{password:'PRIVATE'})
    await expect(pine.search({connectionId:'pinecone',collection:'docs',requestId:crypto.randomUUID(),vector:[1],limit:1,includeVectors:false})).rejects.toThrow('host is unavailable or invalid')
    expect(fetcher.mock.calls.length).toBe(2)
    await expect(pine.connect({...profile('pinecone'),host:'attacker.example'},{password:'PRIVATE'})).rejects.toThrow('control plane')
  })
  it('aborts external-signal searches at their deadline and disconnects mutation requests', async () => {
    vi.useFakeTimers()
    try {
      const service=new VectorService(async(url,init)=>{
        if(new URL(String(url)).pathname==='/')return response({version:'1'})
        return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('raw SECRET')),{once:true}))
      })
      await service.connect({...profile('qdrant'),queryTimeout:1000})
      const search=service.search({connectionId:'qdrant',collection:'docs',requestId:crypto.randomUUID(),vector:[1],limit:1,includeVectors:false})
      const assertion=expect(search).rejects.toThrow('deadline exceeded')
      await vi.advanceTimersByTimeAsync(1001);await assertion
      const target={connectionId:'qdrant',collection:'docs'}
      const mutate=service.mutate({...target,action:'delete',id:'1',confirm:vectorConfirmation(target)})
      const denied=expect(mutate).rejects.toThrow('outcome may be uncertain')
      await service.disconnect('qdrant');await denied
    } finally {vi.useRealTimers()}
  })
  it('never issues an unfiltered Milvus request for malformed filters', async () => {
    const fetcher=vi.fn(async(url)=>String(url).includes('describe')?response({code:0,data:{fields:[{name:'id',type:'Int64',primaryKey:true},{name:'v',type:'FloatVector'}]}}):response({code:0,data:[]}))
    const service=new VectorService(fetcher);await service.connect(profile('milvus'))
    await expect(service.search({connectionId:'milvus',collection:'docs',requestId:crypto.randomUUID(),vector:[1],filter:{wrong:'x'},limit:1,includeVectors:false})).rejects.toThrow('no query was sent')
    expect(fetcher.mock.calls.some(([url])=>String(url).includes('entities/search'))).toBe(false)
  })
})
