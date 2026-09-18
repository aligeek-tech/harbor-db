import { describe, expect, it } from 'vitest'
import { VectorService } from '../src/main/engines/vector'
import { profileSchema } from '../src/shared/contracts'
import { vectorConfirmation } from '../src/shared/vector'

const qdrantPort = Number(process.env.HARBOR_VECTOR_QDRANT_PORT || 0)
const weaviatePort = Number(process.env.HARBOR_VECTOR_WEAVIATE_PORT || 0)
const milvusPort = Number(process.env.HARBOR_VECTOR_MILVUS_PORT || 0)

describe.skipIf(!qdrantPort)('Qdrant live REST contract', () => {
  it('discovers configuration, filters bounded vectors and performs reviewed one-point mutations', async () => {
    const service = new VectorService()
    const profile = profileSchema.parse({
      id: 'live-qdrant', name: 'Live Qdrant', engine: 'qdrant', host: '127.0.0.1',
      port: qdrantPort, readOnly: false,
      tls: { enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    })
    const status = await service.connect(profile)
    expect(status).toMatchObject({ state: 'connected', version: '1.19.1' })
    expect(await service.collections(profile.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'harbor_articles', dimension: 3, metric: 'Cosine', records: 3 }),
    ]))
    const result = await service.search({
      connectionId: profile.id, collection: 'harbor_articles', requestId: crypto.randomUUID(),
      vector: [1, 0, 0], filter: { must: [{ key: 'category', match: { value: 'docs' } }] },
      limit: 2, includeVectors: true,
    })
    expect(result.hits.map((hit) => hit.id)).toEqual(['1', '2'])
    expect(result.hits.every((hit) => hit.vector?.length === 3)).toBe(true)
    const target = { connectionId: profile.id, collection: 'harbor_articles' }
    await service.mutate({ ...target, action: 'upsert', id: 4, vector: [0.9, 0.1, 0], payload: { title: 'temporary', category: 'docs' }, confirm: vectorConfirmation(target) })
    expect((await service.collections(profile.id)).find((item) => item.name === 'harbor_articles')?.records).toBe(4)
    await service.mutate({ ...target, action: 'delete', id: 4, confirm: vectorConfirmation(target) })
    await service.closeAll()
  })
})

describe.skipIf(!weaviatePort)('Weaviate live REST/GraphQL contract', () => {
  it('discovers schema, runs bounded nearVector and performs reviewed object mutation', async () => {
    const service = new VectorService()
    const profile = profileSchema.parse({
      id: 'live-weaviate', name: 'Live Weaviate', engine: 'weaviate', host: '127.0.0.1',
      port: weaviatePort, readOnly: false,
      tls: { enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    })
    const status = await service.connect(profile)
    expect(status.state).toBe('connected')
    expect(await service.collections(profile.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'HarborArticle', metric: 'cosine' }),
    ]))
    const result = await service.search({ connectionId: profile.id, collection: 'HarborArticle', requestId: crypto.randomUUID(), vector: [1, 0, 0], limit: 2, includeVectors: true })
    expect(result.hits[0]).toMatchObject({ payload: { title: 'alpha' }, vector: [1, 0, 0] })
    const id = crypto.randomUUID(), target = { connectionId: profile.id, collection: 'HarborArticle' }
    await service.mutate({ ...target, action: 'upsert', id, vector: [0.9, 0.1, 0], payload: { title: 'temporary', category: 'docs' }, confirm: vectorConfirmation(target) })
    await service.mutate({ ...target, action: 'delete', id, confirm: vectorConfirmation(target) })
    await service.closeAll()
  })
})

describe.skipIf(!milvusPort)('Milvus live REST v2 contract', () => {
  it('discovers schema, applies an explicit scalar filter, and performs reviewed one-point mutations', async () => {
    const service = new VectorService()
    const profile = profileSchema.parse({
      id: 'live-milvus', name: 'Live Milvus', engine: 'milvus', host: '127.0.0.1',
      port: milvusPort, database: 'default', readOnly: false,
      tls: { enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    })
    const status = await service.connect(profile)
    expect(status).toMatchObject({ state: 'connected', version: 'Milvus REST v2' })
    expect(await service.collections(profile.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'harbor_articles', dimension: 3 }),
    ]))
    const target = { connectionId: profile.id, collection: 'harbor_articles' }
    await service.mutate({ ...target, action: 'delete', id: 4, confirm: vectorConfirmation(target) })
    await expect.poll(async () => (await service.search({ connectionId: profile.id, collection: target.collection, requestId: crypto.randomUUID(), vector: [1, 0, 0], filter: { expression: 'id == 4' }, limit: 1, includeVectors: false })).hits, { timeout: 5_000, interval: 100 }).toHaveLength(0)
    const result = await service.search({
      connectionId: profile.id, collection: 'harbor_articles', requestId: crypto.randomUUID(),
      vector: [1, 0, 0], filter: { expression: 'category == "docs"' }, limit: 2,
      includeVectors: true,
    })
    expect(result.hits.map((hit) => hit.id)).toEqual(['1', '2'])
    expect(result.hits.every((hit) => hit.vector?.length === 3)).toBe(true)
    await service.mutate({ ...target, action: 'upsert', id: 4, vector: [0.95, 0.05, 0], payload: { title: 'temporary', category: 'docs' }, confirm: vectorConfirmation(target) })
    await expect.poll(async () => (await service.search({ connectionId: profile.id, collection: target.collection, requestId: crypto.randomUUID(), vector: [1, 0, 0], filter: { expression: 'id == 4' }, limit: 1, includeVectors: false })).hits[0], { timeout: 5_000, interval: 100 }).toMatchObject({ id: '4', payload: { title: 'temporary' } })
    await service.mutate({ ...target, action: 'delete', id: 4, confirm: vectorConfirmation(target) })
    await expect.poll(async () => (await service.search({ connectionId: profile.id, collection: target.collection, requestId: crypto.randomUUID(), vector: [1, 0, 0], filter: { expression: 'id == 4' }, limit: 1, includeVectors: false })).hits, { timeout: 5_000, interval: 100 }).toHaveLength(0)
    await service.closeAll()
  })
})
