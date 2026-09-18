import type { ConnectionAdapter } from './adapter'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  vectorConfirmation,
  vectorMutateSchema,
  vectorSearchSchema,
  type VectorCollection,
  type VectorMutationInput,
  type VectorMutationResult,
  type VectorSearchInput,
  type VectorSearchResult,
} from '../../shared/vector'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
interface Session { profile: ConnectionProfile; apiKey?: string; status: ConnectionStatus; pineconeHosts: Map<string, string>; weaviateProperties: Map<string, string[]>; milvusFields: Map<string, { primary: string; vector: string }> }

export class VectorService implements ConnectionAdapter {
  private sessions = new Map<string, Session>()
  private statuses = new Map<string, ConnectionStatus>()
  private requests = new Map<string, AbortController>()
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async connect(profile: ConnectionProfile, secrets?: Secrets): Promise<ConnectionStatus> {
    if (!['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine))
      throw new Error('This is not a vector database profile.')
    if (profile.engine === 'pinecone' && !secrets?.password)
      throw new Error('Pinecone requires a project-scoped API key.')
    const started = performance.now()
    const session: Session = { profile: structuredClone(profile), apiKey: secrets?.password, status: { state: 'connecting' }, pineconeHosts: new Map(), weaviateProperties: new Map(), milvusFields: new Map() }
    this.statuses.set(profile.id, session.status)
    try {
      const version = await this.probe(session)
      session.status = { state: 'connected', version, durationMs: Math.round(performance.now() - started), transport: this.base(profile) }
      this.sessions.set(profile.id, session)
      this.statuses.set(profile.id, session.status)
      return { ...session.status }
    } catch (error) {
      const status: ConnectionStatus = { state: /401|403|unauthorized|forbidden|api.?key/i.test(message(error)) ? 'authentication-failed' : 'failed', durationMs: Math.round(performance.now() - started), error: safeError(error, secrets?.password) }
      this.statuses.set(profile.id, status)
      throw new Error(status.error)
    }
  }

  status(id: string): ConnectionStatus { return { ...(this.statuses.get(id) || { state: 'disconnected' }) } }
  async disconnect(id: string): Promise<void> { for (const [key, request] of this.requests) if (key.startsWith(`${id}:`)) { request.abort(); this.requests.delete(key) }; this.sessions.delete(id); this.statuses.set(id, { state: 'disconnected' }) }
  async closeAll(): Promise<void> { for (const request of this.requests.values()) request.abort(); this.requests.clear(); this.sessions.clear(); this.statuses.clear() }

  async collections(connectionId: string): Promise<VectorCollection[]> {
    const session = this.session(connectionId)
    if (session.profile.engine === 'qdrant') {
      const body = await this.request(session, '/collections') as { result?: { collections?: { name?: string }[] } }
      return Promise.all((body.result?.collections || []).slice(0, 1000).flatMap((item) => item.name ? [this.qdrantCollection(session, item.name)] : []))
    }
    if (session.profile.engine === 'milvus') {
      const listed = await this.request(session, '/v2/vectordb/collections/list', { method: 'POST', body: { dbName: session.profile.database || 'default' } }) as { data?: string[] | { collectionNames?: string[] } }
      const names = Array.isArray(listed.data) ? listed.data : listed.data?.collectionNames || []
      return Promise.all(names.slice(0, 1000).map((name) => this.milvusCollection(session, name)))
    }
    if (session.profile.engine === 'weaviate') {
      const schema = await this.request(session, '/v1/schema') as { classes?: Record<string, unknown>[] }
      return (schema.classes || []).slice(0, 1000).flatMap((item) => {
        const name = typeof item.class === 'string' ? item.class : ''
        if (!name) return []
        const properties = Array.isArray(item.properties) ? item.properties.flatMap((property) => typeof (property as { name?: unknown }).name === 'string' ? [(property as { name: string }).name] : []) : []
        session.weaviateProperties.set(name, properties.filter(identifier).slice(0, 100))
        const vector = object(item.vectorIndexConfig)
        return [{ name, metric: string(vector.distance), details: { vectorizer: string(item.vectorizer), vectorIndexType: string(item.vectorIndexType), properties: properties.length } }]
      })
    }
    const body = await this.request(session, '/indexes') as { indexes?: Record<string, unknown>[] }
    return (body.indexes || []).slice(0, 1000).flatMap((item) => {
      const name = string(item.name), host = string(item.host)
      if (!name || !host) return []
      session.pineconeHosts.set(name, host)
      return [{ name, dimension: number(item.dimension), metric: string(item.metric), status: string(object(item.status).state), details: { host, ready: Boolean(object(item.status).ready), visibility: 'Record enumeration depends on serverless index support; search remains bounded.' } }]
    })
  }

  async search(raw: VectorSearchInput): Promise<VectorSearchResult> {
    const input = vectorSearchSchema.parse(raw), session = this.session(input.connectionId)
    const controller = new AbortController(), key = `${input.connectionId}:${input.requestId}`
    if (this.requests.has(key)) throw new Error('This vector request is already running.')
    this.requests.set(key, controller)
    const started = performance.now(), warnings: string[] = []
    try {
      let body: unknown, hits: Record<string, unknown>[] = [], usage: Record<string, number> | undefined
      if (session.profile.engine === 'qdrant') {
        body = await this.request(session, `/collections/${encodeURIComponent(input.collection)}/points/query`, { method: 'POST', body: { query: input.vector, filter: input.filter, limit: input.limit, with_payload: true, with_vector: input.includeVectors }, signal: controller.signal })
        hits = (object(object(body).result).points as Record<string, unknown>[] | undefined) || []
      } else if (session.profile.engine === 'milvus') {
        const expression = typeof input.filter?.expression === 'string' ? input.filter.expression : undefined
        if (input.filter && !expression) warnings.push('Milvus scalar filters require {"expression":"..."}; the supplied filter was not sent.')
        body = await this.request(session, '/v2/vectordb/entities/search', { method: 'POST', body: { dbName: session.profile.database || 'default', collectionName: input.collection, data: [input.vector], limit: input.limit, outputFields: ['*'], ...(expression ? { filter: expression } : {}) }, signal: controller.signal })
        hits = Array.isArray(object(body).data) ? object(body).data as Record<string, unknown>[] : []
      } else if (session.profile.engine === 'weaviate') {
        if (input.filter) warnings.push('Weaviate filter translation is not available in this REST/GraphQL compatibility mode; no filter was sent.')
        if (!identifier(input.collection)) throw new Error('Weaviate collection name is not a safe GraphQL identifier.')
        const properties = (session.weaviateProperties.get(input.collection) || []).join(' ')
        const query = `{Get{${input.collection}(nearVector:{vector:${JSON.stringify(input.vector)}} limit:${input.limit}){${properties} _additional{id distance ${input.includeVectors ? 'vector' : ''}}}}}`
        body = await this.request(session, '/v1/graphql', { method: 'POST', body: { query }, signal: controller.signal })
        hits = (((object(object(object(body).data).Get)[input.collection]) as Record<string, unknown>[] | undefined) || [])
      } else {
        const host = await this.pineconeHost(session, input.collection)
        body = await this.request(session, '/query', { method: 'POST', host, body: { vector: input.vector, topK: input.limit, includeMetadata: true, includeValues: input.includeVectors, ...(input.namespace ? { namespace: input.namespace } : {}), ...(input.filter ? { filter: input.filter } : {}) }, signal: controller.signal })
        hits = (object(body).matches as Record<string, unknown>[] | undefined) || []
        usage = numericObject(object(object(body).usage))
        warnings.push('Pinecone does not guarantee general record enumeration; results are only this bounded query.')
      }
      return { hits: hits.slice(0, input.limit).map((hit) => normalizeHit(session.profile.engine, hit, input.includeVectors)), truncated: hits.length >= input.limit, durationMs: Math.round(performance.now() - started), ...(usage ? { usage } : {}), warnings }
    } finally { this.requests.delete(key) }
  }

  cancel(connectionId: string, requestId: string): { requested: boolean } { const controller = this.requests.get(`${connectionId}:${requestId}`); if (!controller) return { requested: false }; controller.abort(); return { requested: true } }

  async mutate(raw: VectorMutationInput): Promise<VectorMutationResult> {
    const input = vectorMutateSchema.parse(raw), session = this.session(input.connectionId)
    if (session.profile.readOnly) throw new Error('This vector connection is in guarded browsing mode.')
    if (input.confirm !== vectorConfirmation(input)) throw new Error('Type the exact visible vector target before applying this mutation.')
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 2 * 1024 * 1024) throw new Error('Vector mutation exceeds the 2 MiB reviewed request limit.')
    if (session.profile.engine === 'qdrant') {
      await this.request(session, `/collections/${encodeURIComponent(input.collection)}/points${input.action === 'upsert' ? '?wait=true' : '/delete?wait=true'}`, { method: input.action === 'upsert' ? 'PUT' : 'POST', body: input.action === 'upsert' ? { points: [{ id: input.id, vector: input.vector, payload: input.payload }] } : { points: [input.id] } })
    } else if (session.profile.engine === 'milvus') {
      const fields = session.milvusFields.get(input.collection) || await this.milvusFields(session, input.collection)
      await this.request(session, `/v2/vectordb/entities/${input.action === 'upsert' ? 'upsert' : 'delete'}`, { method: 'POST', body: input.action === 'upsert' ? { dbName: session.profile.database || 'default', collectionName: input.collection, data: [{ ...input.payload, [fields.primary]: input.id, [fields.vector]: input.vector }] } : { dbName: session.profile.database || 'default', collectionName: input.collection, filter: `${fields.primary} == ${JSON.stringify(input.id)}` } })
    } else if (session.profile.engine === 'weaviate') {
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('Weaviate mutations require an explicit UUID object id.')
      const path = `/v1/objects/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}`
      if (input.action === 'delete') await this.request(session, path, { method: 'DELETE' })
      else {
        let exists = true
        try { await this.request(session, path) } catch (error) {
          if (/HTTP 404\b/.test(message(error))) exists = false
          else throw error
        }
        const body = { class: input.collection, id: input.id, properties: input.payload, vector: input.vector }
        await this.request(session, exists ? path : '/v1/objects', { method: exists ? 'PUT' : 'POST', body })
      }
    } else {
      const host = await this.pineconeHost(session, input.collection)
      await this.request(session, input.action === 'upsert' ? '/vectors/upsert' : '/vectors/delete', { method: 'POST', host, body: input.action === 'upsert' ? { vectors: [{ id: String(input.id), values: input.vector, metadata: input.payload }], ...(input.namespace ? { namespace: input.namespace } : {}) } : { ids: [String(input.id)], ...(input.namespace ? { namespace: input.namespace } : {}) } })
    }
    return { action: input.action, acknowledged: true, ...(session.profile.engine === 'pinecone' ? { warning: 'Usage and eventual consistency remain provider-managed; refresh with a bounded query.' } : {}) }
  }

  private session(id: string): Session { const session = this.sessions.get(id); if (!session) throw new Error('Connect this vector target first.'); return session }
  private base(profile: ConnectionProfile): string { const protocol = profile.tls.enabled ? 'https:' : 'http:'; return `${protocol}//${profile.host}:${profile.port}${profile.search.pathPrefix || ''}` }
  private headers(session: Session): Record<string, string> { const key = session.apiKey; return { accept: 'application/json', 'content-type': 'application/json', ...(key ? session.profile.engine === 'qdrant' ? { 'api-key': key } : session.profile.engine === 'pinecone' ? { 'Api-Key': key, 'X-Pinecone-Api-Version': '2025-04' } : { authorization: `Bearer ${key}` } : {}) } }
  private async request(session: Session, path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; host?: string } = {}): Promise<unknown> {
    const base = options.host ? `https://${options.host}` : `${session.profile.tls.enabled ? 'https:' : 'http:'}//${session.profile.host}:${session.profile.port}`
    const prefix = options.host ? '' : session.profile.search.pathPrefix.replace(/\/$/, '')
    const controller = options.signal ? undefined : new AbortController()
    const timer = setTimeout(() => controller?.abort(), Math.min(session.profile.queryTimeout, 60_000)); timer.unref()
    try {
      const response = await this.fetcher(new URL(`${prefix}${path}`, base), { method: options.method || 'GET', redirect: 'error', headers: this.headers(session), signal: options.signal || controller!.signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) })
      const text = await boundedText(response, 2 * 1024 * 1024)
      if (!response.ok) throw new Error(`${session.profile.engine} returned HTTP ${response.status}. ${text.slice(0, 500)}`)
      if (!text) return {}
      const parsed = JSON.parse(text) as unknown
      if (session.profile.engine === 'milvus' && number(object(parsed).code) !== undefined && number(object(parsed).code) !== 0) throw new Error(`Milvus returned code ${number(object(parsed).code)}. ${string(object(parsed).message)}`)
      return parsed
    } finally { clearTimeout(timer) }
  }
  private async probe(session: Session): Promise<string> { if (session.profile.engine === 'qdrant') { const root = object(await this.request(session, '/')); return string(root.version) || 'Qdrant' }; if (session.profile.engine === 'milvus') { await this.request(session, '/v2/vectordb/collections/list', { method: 'POST', body: { dbName: session.profile.database || 'default' } }); return 'Milvus REST v2' }; if (session.profile.engine === 'weaviate') { const meta = object(await this.request(session, '/v1/meta')); return string(meta.version) || 'Weaviate' }; await this.request(session, '/indexes'); return 'Pinecone API 2025-04' }
  private async qdrantCollection(session: Session, name: string): Promise<VectorCollection> { const body = object(await this.request(session, `/collections/${encodeURIComponent(name)}`)), result = object(body.result), config = object(result.config), vectors = object(object(config.params).vectors); return { name, dimension: number(vectors.size), metric: string(vectors.distance), records: number(result.points_count), status: string(result.status), details: { indexedVectors: number(result.indexed_vectors_count) || 0, segments: number(result.segments_count) || 0, optimizerStatus: string(result.optimizer_status) } } }
  private async milvusFields(session: Session, name: string) {
    const body = object(await this.request(session, '/v2/vectordb/collections/describe', {
      method: 'POST', body: { dbName: session.profile.database || 'default', collectionName: name },
    }))
    const fields = (object(body.data).fields as Record<string, unknown>[] | undefined) || []
    const primary = milvusFieldName(fields.find(milvusPrimary))
    const vector = milvusFieldName(fields.find((field) => /vector/i.test(milvusFieldType(field))))
    if (!identifier(primary) || !identifier(vector))
      throw new Error('Milvus collection does not expose one supported primary/vector field.')
    const value = { primary, vector }
    session.milvusFields.set(name, value)
    return value
  }
  private async milvusCollection(session: Session, name: string): Promise<VectorCollection> {
    const body = object(await this.request(session, '/v2/vectordb/collections/describe', {
      method: 'POST', body: { dbName: session.profile.database || 'default', collectionName: name },
    }))
    const data = object(body.data)
    const fields = (data.fields as Record<string, unknown>[] | undefined) || []
    const vector = fields.find((field) => /vector/i.test(milvusFieldType(field)))
    const primary = fields.find(milvusPrimary)
    const primaryName = milvusFieldName(primary), vectorName = milvusFieldName(vector)
    if (identifier(primaryName) && identifier(vectorName))
      session.milvusFields.set(name, { primary: primaryName, vector: vectorName })
    const indexes = (data.indexes as Record<string, unknown>[] | undefined) || []
    const vectorIndex = indexes.find((item) => string(item.fieldName) === vectorName)
    return {
      name,
      dimension: milvusDimension(vector),
      metric: string(vectorIndex?.metricType),
      status: string(data.load) || string(data.consistencyLevel),
      details: { fields: fields.length, autoId: Boolean(data.autoId), shards: number(data.shardsNum) || 0 },
    }
  }
  private async pineconeHost(session: Session, index: string): Promise<string> { let host = session.pineconeHosts.get(index); if (!host) { await this.collections(session.profile.id); host = session.pineconeHosts.get(index) }; if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('Pinecone index host is unavailable or invalid.'); return host }
}

async function boundedText(response: Response, max: number): Promise<string> { const reader = response.body?.getReader(); if (!reader) return ''; const chunks: Uint8Array[] = []; let size = 0; while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > max) { await reader.cancel(); throw new Error('Vector provider response exceeds the 2 MiB limit.') }; chunks.push(item.value) }; const merged = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }; return new TextDecoder('utf-8', { fatal: true }).decode(merged) }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const safeError = (error: unknown, secret?: string) => { let value = message(error); if (secret) value = value.replaceAll(secret, '[redacted]'); return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@').slice(0, 2000) }
const identifier = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
const numericObject = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'number' ? [[key, item]] : []))
const milvusFieldName = (field?: Record<string, unknown>) => string(field?.fieldName) || string(field?.name)
const milvusFieldType = (field?: Record<string, unknown>) => string(field?.dataType) || string(field?.type)
const milvusPrimary = (field: Record<string, unknown>) => Boolean(field.isPrimary ?? field.primaryKey)
const milvusDimension = (field?: Record<string, unknown>) => {
  const direct = number(object(field?.elementTypeParams).dim)
  if (direct !== undefined) return direct
  const params = Array.isArray(field?.params) ? field.params as Record<string, unknown>[] : []
  return number(params.find((item) => item.key === 'dim')?.value)
}
function normalizeHit(engine: string, hit: Record<string, unknown>, vectors: boolean) { const additional = object(hit._additional), rawVector = hit.vector ?? hit.values ?? additional.vector, payload = object(hit.payload ?? hit.metadata ?? hit.entity ?? hit); delete payload.vector; delete payload.values; delete payload._additional; const vector = Array.isArray(rawVector) ? rawVector.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).slice(0, 4096) : undefined; return { id: String(hit.id ?? additional.id ?? object(hit.entity).id ?? ''), ...(number(hit.score ?? hit.distance ?? additional.distance) !== undefined ? { score: number(hit.score ?? hit.distance ?? additional.distance) } : {}), payload, ...(vectors && vector ? { vector } : {}) } }
