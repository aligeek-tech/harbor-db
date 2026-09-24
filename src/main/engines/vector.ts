import { parse, stringify, isLosslessNumber, LosslessNumber } from 'lossless-json'
import { openTransport, tlsOptions, type Transport } from './transport'
import { vectorHttp } from './vector-http'
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
interface Session { controller: AbortController; transport?: Transport; active: number; profile: ConnectionProfile; apiKey?: string; status: ConnectionStatus; pineconeHosts: Map<string, string>; weaviateProperties: Map<string, string[]>; milvusFields: Map<string, { primary: string; vector: string; numeric: boolean }> }

export class VectorService implements ConnectionAdapter {
  private sessions = new Map<string, Session>()
  private statuses = new Map<string, ConnectionStatus>()
  private requests = new Map<string, AbortController>()
  constructor(private readonly fetcher?: Fetcher) {}

  async connect(profile: ConnectionProfile, secrets?: Secrets): Promise<ConnectionStatus> {
    if (!['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine))
      throw new Error('This is not a vector database profile.')
    if (profile.engine === 'pinecone' && !secrets?.password)
      throw new Error('Pinecone requires a project-scoped API key.')
    await this.disconnect(profile.id)
    validateTransport(profile)
    const started = performance.now()
    const session: Session = { controller: new AbortController(), active: 0, profile: structuredClone(profile), apiKey: secrets?.password, status: { state: 'connecting' }, pineconeHosts: new Map(), weaviateProperties: new Map(), milvusFields: new Map() }
    this.sessions.set(profile.id, session)
    this.statuses.set(profile.id, session.status)
    try {
      if (!this.fetcher) session.transport = await openTransport(profile, secrets)
      const version = await this.probe(session)
      if (session.controller.signal.aborted || this.sessions.get(profile.id) !== session) throw new Error('Vector connection was replaced or disconnected.')
      session.status = { state: 'connected', version, durationMs: Math.round(performance.now() - started), transport: this.base(profile) }
      this.sessions.set(profile.id, session)
      this.statuses.set(profile.id, session.status)
      return { ...session.status }
    } catch (error) {
      session.controller.abort()
      await session.transport?.close()
      if (this.sessions.get(profile.id) !== session) throw new Error('Vector connection was replaced or disconnected.')
      this.sessions.delete(profile.id)
      const status: ConnectionStatus = { state: /401|403|unauthorized|forbidden|api.?key/i.test(message(error)) ? 'authentication-failed' : 'failed', durationMs: Math.round(performance.now() - started), error: safeError(error, secrets?.password) }
      this.statuses.set(profile.id, status)
      throw new Error(status.error)
    }
  }

  status(id: string): ConnectionStatus { return { ...(this.statuses.get(id) || { state: 'disconnected' }) } }
  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    session?.controller.abort()
    for (const [key, request] of this.requests) if (key.startsWith(`${id}:`)) request.abort()
    this.statuses.set(id, { state: 'disconnected' })
    await session?.transport?.close()
  }
  async closeAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map(id => this.disconnect(id))) }


  async collections(connectionId: string): Promise<VectorCollection[]> {
    const session = this.session(connectionId)
    if (session.profile.engine === 'qdrant') {
      const body = await this.request(session, '/collections') as { result?: { collections?: { name?: string }[] } }
      const result: VectorCollection[] = []
      for (const item of (body.result?.collections || []).slice(0, 1000)) if(item.name) result.push(await this.qdrantCollection(session, item.name))
      return result
    }
    if (session.profile.engine === 'milvus') {
      const listed = await this.request(session, '/v2/vectordb/collections/list', { method: 'POST', body: { dbName: session.profile.database || 'default' } }) as { data?: string[] | { collectionNames?: string[] } }
      const names = Array.isArray(listed.data) ? listed.data : listed.data?.collectionNames || []
      const result: VectorCollection[] = []
      for (const name of names.slice(0, 1000)) result.push(await this.milvusCollection(session, name))
      return result
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
    if (input.filterJson !== undefined) input.filter = jsonObject(input.filterJson)
    if (input.filter && Object.keys(input.filter).length === 0) input.filter = undefined
    if (input.namespace && session.profile.engine !== 'pinecone') throw new Error('Namespaces are only supported for Pinecone in this workspace.')
    const controller = new AbortController(), key = `${input.connectionId}:${input.requestId}`
    if (this.requests.has(key)) throw new Error('This vector request is already running.')
    if (this.requests.size >= 4) throw new Error('Four vector searches are already running. Wait or cancel one.')
    this.requests.set(key, controller)
    const started = performance.now(), warnings: string[] = []
    try {
      let body: unknown, hits: Record<string, unknown>[] = [], usage: Record<string, number> | undefined
      if (session.profile.engine === 'qdrant') {
        body = await this.request(session, `/collections/${encodeURIComponent(input.collection)}/points/query`, { method: 'POST', body: { query: input.vector, filter: input.filter, limit: input.limit, with_payload: true, with_vector: input.includeVectors }, signal: controller.signal })
        hits = (object(object(body).result).points as Record<string, unknown>[] | undefined) || []
      } else if (session.profile.engine === 'milvus') {
        if (!session.milvusFields.has(input.collection)) await this.milvusFields(session, input.collection)
        const expression = typeof input.filter?.expression === 'string' ? input.filter.expression : undefined
        if (input.filter && (!expression || Object.keys(input.filter).some(key => key !== 'expression'))) throw new Error('Milvus scalar filters require exactly {"expression":"..."}; no query was sent.')
        body = await this.request(session, '/v2/vectordb/entities/search', { method: 'POST', body: { dbName: session.profile.database || 'default', collectionName: input.collection, data: [input.vector], limit: input.limit, outputFields: ['*'], ...(expression ? { filter: expression } : {}) }, signal: controller.signal })
        hits = Array.isArray(object(body).data) ? object(body).data as Record<string, unknown>[] : []
      } else if (session.profile.engine === 'weaviate') {
        if (input.filter) throw new Error('Weaviate filter translation is not available in this workspace; no query was sent.')
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
      return { hits: hits.slice(0, input.limit).map((hit) => normalizeHit(session.profile.engine, hit, input.includeVectors, session.milvusFields.get(input.collection))), truncated: hits.length >= input.limit, durationMs: Math.round(performance.now() - started), ...(usage ? { usage } : {}), warnings }
    } finally { this.requests.delete(key) }
  }

  cancel(connectionId: string, requestId: string): { requested: boolean } { const controller = this.requests.get(`${connectionId}:${requestId}`); if (!controller) return { requested: false }; controller.abort(); return { requested: true } }

  async mutate(raw: VectorMutationInput): Promise<VectorMutationResult> {
    const input = vectorMutateSchema.parse(raw), session = this.session(input.connectionId)
    if (input.action === 'upsert' && input.payloadJson !== undefined) input.payload = jsonObject(input.payloadJson)
    if (input.namespace && session.profile.engine !== 'pinecone') throw new Error('Namespaces are only supported for Pinecone.')
    if (session.profile.readOnly) throw new Error('This vector connection is in guarded browsing mode.')
    if (input.confirm !== vectorConfirmation(input)) throw new Error('Type the exact visible vector target before applying this mutation.')
    if (new TextEncoder().encode(stringify(input)!).byteLength > 2 * 1024 * 1024) throw new Error('Vector mutation exceeds the 2 MiB reviewed request limit.')
    try {
    if (session.profile.engine === 'qdrant') {
      await this.request(session, `/collections/${encodeURIComponent(input.collection)}/points${input.action === 'upsert' ? '?wait=true' : '/delete?wait=true'}`, { method: input.action === 'upsert' ? 'PUT' : 'POST', body: input.action === 'upsert' ? { points: [{ id: qdrantId(input.id), vector: input.vector, payload: input.payload }] } : { points: [qdrantId(input.id)] } })
    } else if (session.profile.engine === 'milvus') {
      const fields = session.milvusFields.get(input.collection) || await this.milvusFields(session, input.collection)
      const pointId = fields.numeric ? milvusId(input.id) : String(input.id)
      await this.request(session, `/v2/vectordb/entities/${input.action === 'upsert' ? 'upsert' : 'delete'}`, { method: 'POST', body: input.action === 'upsert' ? { dbName: session.profile.database || 'default', collectionName: input.collection, data: [{ ...input.payload, [fields.primary]: pointId, [fields.vector]: input.vector }] } : { dbName: session.profile.database || 'default', collectionName: input.collection, filter: `${fields.primary} == ${stringify(pointId)}` } })
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
    } catch { throw new Error('Vector mutation did not complete with a confirmed acknowledgement. Its outcome may be uncertain; inspect the exact point before retrying. No automatic replay occurred.') }
    return { action: input.action, acknowledged: true, ...(session.profile.engine === 'pinecone' ? { warning: 'Usage and eventual consistency remain provider-managed; refresh with a bounded query.' } : {}) }
  }

  private session(id: string): Session { const session = this.sessions.get(id); if (!session || session.status.state !== 'connected' || session.controller.signal.aborted) throw new Error('Connect this vector target first.'); return session }
  private base(profile: ConnectionProfile): string { const protocol = profile.tls.enabled ? 'https:' : 'http:'; return `${protocol}//${profile.host}:${profile.port}${profile.search.pathPrefix || ''}` }
  private headers(session: Session): Record<string, string> { const key = session.apiKey; return { accept: 'application/json', 'content-type': 'application/json', ...(key ? session.profile.engine === 'qdrant' ? { 'api-key': key } : session.profile.engine === 'pinecone' ? { 'Api-Key': key, 'X-Pinecone-Api-Version': '2025-04' } : { authorization: `Bearer ${key}` } : {}) } }
  private async request(session: Session, path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; host?: string } = {}): Promise<unknown> {
    if (session.controller.signal.aborted) throw new Error('Vector connection was disconnected.')
    if (session.active >= 4) throw new Error('Four vector requests are already active. Wait or cancel one.')
    if (options.host && !pineconeHostValid(options.host)) throw new Error('Invalid Pinecone data-plane host.')
    const base = options.host ? `https://${options.host}` : `${session.profile.tls.enabled ? 'https:' : 'http:'}//${session.profile.host.includes(':') ? '['+session.profile.host+']' : session.profile.host}:${session.profile.port}`
    const prefix = options.host ? '' : session.profile.search.pathPrefix.replace(/\/$/, '')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, session.controller.signal, ...(options.signal ? [options.signal] : [])])
    const timer = setTimeout(() => controller.abort(), Math.min(session.profile.queryTimeout, 60_000)); timer.unref()
    session.active++
    try {
      if (signal.aborted) throw new Error('Vector request cancelled before dispatch.')
      const url = new URL(`${prefix}${path}`, base)
      const body = options.body !== undefined ? stringify(options.body) : undefined
      if (body && Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Vector request exceeds 2 MiB.')
      const init: RequestInit = {method:options.method || 'GET', redirect:'error', headers:this.headers(session), signal, ...(body !== undefined ? {body} : {})}
      const transport = options.host ? {host:options.host, port:443, tls:await tlsOptions({...session.profile, host:options.host}), close:async()=>{}} : session.transport
      const response = this.fetcher ? await this.fetcher(url, init) : await vectorHttp(url,init,transport!)
      if (!response.ok) { await response.body?.cancel(); throw new Error(`${session.profile.engine} returned HTTP ${response.status}. Provider details omitted.`) }
      const text = await boundedText(response, 2 * 1024 * 1024, signal)
      if (signal.aborted) throw new Error('Vector request cancelled or deadline exceeded.')
      if (!text) return {}
      let parsed: unknown
      try { parsed = parse(text) } catch { throw new Error('Vector provider returned invalid JSON. Content omitted.') }
      if (session.profile.engine === 'milvus' && number(object(parsed).code) !== undefined && number(object(parsed).code) !== 0) throw new Error(`Milvus returned code ${number(object(parsed).code)}. Provider details omitted.`)
      if (session.profile.engine === 'weaviate' && Array.isArray(object(parsed).errors) && (object(parsed).errors as unknown[]).length) throw new Error('Weaviate rejected the query. Provider details omitted.')
      return parsed
    } catch(error) {
      if (signal.aborted) throw new Error('Vector request cancelled or deadline exceeded. Server outcome is unconfirmed.')
      if(error instanceof Error && /^(Vector |Milvus returned code|Weaviate rejected|(?:qdrant|milvus|weaviate|pinecone) returned HTTP)/.test(error.message)) throw error
      throw new Error('Vector transport failed. Provider details omitted; no automatic replay occurred.')
    } finally { clearTimeout(timer); session.active-- }
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
    const value = { primary, vector, numeric: /int64/i.test(milvusFieldType(fields.find(milvusPrimary))) }
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
      session.milvusFields.set(name, { primary: primaryName, vector: vectorName, numeric: /int64/i.test(milvusFieldType(primary)) })
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
  private async pineconeHost(session: Session, index: string): Promise<string> { let host = session.pineconeHosts.get(index); if (!host) { await this.collections(session.profile.id); host = session.pineconeHosts.get(index) }; if (!host || !pineconeHostValid(host)) throw new Error('Pinecone index host is unavailable or invalid.'); return host }
}

async function boundedText(response: Response, max: number, signal: AbortSignal): Promise<string> { const reader = response.body?.getReader(); if (!reader) return ''; if(signal.aborted) { await reader.cancel(); throw new Error('Vector request cancelled.'); } const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, {once:true}); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > max) { await reader.cancel(); throw new Error('Vector provider response exceeds the 2 MiB limit.') }; chunks.push(item.value) }; const merged = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }; return new TextDecoder('utf-8', { fatal: true }).decode(merged) } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() } }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (raw: unknown): number | undefined => { const value = isLosslessNumber(raw) ? Number(raw.value) : raw; return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const safeError = (error: unknown, secret?: string) => { let value = message(error); if (secret) value = value.replaceAll(secret, '[redacted]'); return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@').slice(0, 2000) }
const identifier = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
const numericObject = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).flatMap(([key, item]) => number(item) !== undefined ? [[key, number(item)!]] : []))
const milvusFieldName = (field?: Record<string, unknown>) => string(field?.fieldName) || string(field?.name)
const milvusFieldType = (field?: Record<string, unknown>) => string(field?.dataType) || string(field?.type)
const milvusPrimary = (field: Record<string, unknown>) => Boolean(field.isPrimary ?? field.primaryKey)
const milvusDimension = (field?: Record<string, unknown>) => {
  const direct = number(object(field?.elementTypeParams).dim)
  if (direct !== undefined) return direct
  const params = Array.isArray(field?.params) ? field.params as Record<string, unknown>[] : []
  return number(params.find((item) => item.key === 'dim')?.value)
}
function normalizeHit(engine: string, hit: Record<string, unknown>, vectors: boolean, fields?: {primary:string;vector:string}) { const additional = object(hit._additional), rawVector = (fields ? hit[fields.vector] : undefined) ?? hit.vector ?? hit.values ?? additional.vector, payload = object(exactJson(hit.payload ?? hit.metadata ?? hit.entity ?? hit)); if(fields) delete payload[fields.vector]; delete payload.vector; delete payload.values; delete payload._additional; const vector = Array.isArray(rawVector) ? rawVector.map(value => number(value)).filter((value): value is number => value !== undefined && Number.isFinite(value)).slice(0, 4096) : undefined; return { id: String((fields ? hit[fields.primary] : undefined) ?? hit.id ?? additional.id ?? object(hit.entity).id ?? ''), ...(number(hit.score ?? hit.distance ?? additional.distance) !== undefined ? { score: number(hit.score ?? hit.distance ?? additional.distance) } : {}), payload, ...(vectors && vector ? { vector } : {}) } }

function exactJson(value: unknown): unknown {
  if (isLosslessNumber(value)) return value.value
  if (Array.isArray(value)) return value.map(exactJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,exactJson(v)]))
  return value
}
function jsonObject(text: string): Record<string, unknown> {
  const value = parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value)) throw new Error('Enter a JSON object.')
  return value as Record<string,unknown>
}
function qdrantId(value: string | number): string | number | LosslessNumber {
  if(typeof value === 'string' && /^\d+$/.test(value)) {
    const integer = BigInt(value)
    if(integer > 18446744073709551615n) throw new Error('Qdrant ID exceeds uint64.')
    return new LosslessNumber(integer.toString())
  }
  return value
}
function pineconeHostValid(host: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+pinecone\.io$/i.test(host)
}
function validateTransport(profile: ConnectionProfile): void {
  if (!profile.host || /[\s/@?#\\]/.test(profile.host)) throw new Error('Invalid vector hostname.')
  if (profile.search.pathPrefix && (!profile.search.pathPrefix.startsWith('/') || profile.search.pathPrefix.startsWith('//') || /[?#\\]/.test(profile.search.pathPrefix))) throw new Error('Invalid vector API prefix.')
  if (profile.tls.enabled && !profile.tls.rejectUnauthorized) throw new Error('Vector TLS requires certificate verification.')
  if (!profile.tls.enabled && !profile.ssh.enabled && !['localhost','127.0.0.1','::1'].includes(profile.host)) throw new Error('Remote vector connections require verified TLS or pinned SSH.')
  if (profile.engine === 'pinecone' && (profile.host !== 'api.pinecone.io' || profile.port !== 443 || !profile.tls.enabled || profile.ssh.enabled || profile.search.pathPrefix)) throw new Error('Pinecone requires its verified HTTPS api.pinecone.io control plane and direct provider data-plane hosts.')
}

function milvusId(value: string | number): LosslessNumber {
  if (!/^-?\d+$/.test(String(value))) throw new Error('Milvus primary key requires an exact int64.')
  const id = BigInt(value)
  if(id < -9223372036854775808n || id > 9223372036854775807n) throw new Error('Milvus primary key exceeds int64.')
  return new LosslessNumber(id.toString())
}
