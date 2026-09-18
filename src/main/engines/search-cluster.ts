import { randomUUID } from 'node:crypto'
import { isLosslessNumber } from 'lossless-json'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  searchInputSchema,
  searchDocumentSchema,
  searchMutationSchema,
  searchMutationConfirmation,
  type SearchInput,
  type SearchDocumentInput,
  type SearchMutationInput,
  type SearchResult,
  type SearchHit,
  type SearchCatalog,
  type SearchMapping,
  type SearchMutationResult,
  type SearchCancelResult,
} from '../../shared/search'
import { openTransport, type Transport } from './transport'
import {
  SearchHttp,
  SearchHttpError,
  encodeSearchJson,
  searchJson,
  searchNumber,
  searchObject,
  type SearchJson,
  type SearchObject,
} from './search-http'

type Product = 'elasticsearch' | 'opensearch'
interface Cursor {
  token: string
  sessionId: string
  index: string
  dsl: string
  pageSize: number
  pit: string
  after?: SearchJson[]
  expires: number
}
interface Live {
  profile: ConnectionProfile
  transport: Transport
  http: SearchHttp
  version: string
  closed: boolean
  cursors: Map<string, Cursor>
  active: Map<string, { requestId: string; controller: AbortController }>
  status: ConnectionStatus
}
function scalar(value: SearchJson | undefined): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || isLosslessNumber(value)
    ? String(value)
    : undefined
}
function numberToken(value: SearchJson | undefined): string | undefined {
  const text = scalar(value)
  return text && /^\d+$/.test(text) ? text : undefined
}
function sessionName(value: string): void {
  if (!value || value.startsWith('_')) throw new Error('Use a non-reserved session identifier.')
}
export function searchIndex(value: string, concrete = false): string {
  if (
    !value ||
    value.length > 255 ||
    /[\s/\\?#:%\0]/.test(value) ||
    value.startsWith('_') ||
    value.split(',').some((part) => !part)
  )
    throw new Error('Choose an index or local index pattern without URL separators or cross-cluster targets.')
  if (concrete && (/[*,]/.test(value) || value.startsWith('.')))
    throw new Error(
      'Document writes require one existing non-system concrete index, not an alias, pattern or data stream.',
    )
  return encodeURIComponent(value)
}
export function parseSearchDsl(source: string, pageSize: number): SearchObject {
  if (Buffer.byteLength(source) > 1000000) throw new Error('JSON DSL exceeds the 1 MB limit.')
  const dsl = searchObject(searchJson(source || '{}'))
  for (const field of ['from', 'search_after', 'pit', 'scroll', 'slice', 'collapse', 'terminate_after'])
    if (field in dsl)
      throw new Error(
        `${field} is controlled by Harbor’s bounded snapshot pagination or is incompatible with it.`,
      )
  if ('size' in dsl && searchNumber(dsl.size) !== pageSize)
    throw new Error('Set the page-size control to match DSL size, or remove size from the DSL.')
  let nodes = 0
  const walk = (value: SearchJson, depth = 0) => {
    if (++nodes > 50000 || depth > 64)
      throw new Error('JSON DSL nesting or complexity exceeds the local limit.')
    if (value && typeof value === 'object' && !isLosslessNumber(value))
      for (const child of Object.values(value)) walk(child, depth + 1)
  }
  walk(dsl)
  const boundAggregations = (value: SearchJson | undefined, multiplier = 1): void => {
    if (!value) return
    for (const aggregation of Object.values(searchObject(value))) {
      const object = searchObject(aggregation)
      let size = 1
      for (const [kind, options] of Object.entries(object)) {
        if (['aggs', 'aggregations', 'meta'].includes(kind)) continue
        const spec = searchObject(options)
        if (spec.size !== undefined) {
          const count = searchNumber(spec.size)
          if (count > 1000) throw new Error('Each aggregation size is limited to 1000 buckets or hits.')
          size = Math.max(size, count)
        }
        if (spec.shard_size !== undefined && searchNumber(spec.shard_size) > 5000)
          throw new Error('Aggregation shard_size is limited to 5000.')
      }
      if (multiplier * size > 10000)
        throw new Error('Nested aggregation sizes exceed the 10000-bucket local bound.')
      boundAggregations(object.aggs || object.aggregations, multiplier * size)
    }
  }
  boundAggregations(dsl.aggs || dsl.aggregations)
  return dsl
}
function hit(value: SearchJson): SearchHit {
  const item = searchObject(value)
  if (typeof item._index !== 'string' || typeof item._id !== 'string')
    throw new Error('Search hit identity is unavailable; no document operation is safe.')
  const route = item._routing || (item.fields ? searchObject(item.fields)._routing : undefined)
  const routing =
    typeof route === 'string'
      ? route
      : Array.isArray(route) && typeof route[0] === 'string'
        ? route[0]
        : undefined
  return {
    index: item._index,
    id: item._id,
    sourceJson: encodeSearchJson(item._source ?? null),
    ...(item.fields ? { fieldsJson: encodeSearchJson(item.fields) } : {}),
    score: scalar(item._score) || null,
    ...(numberToken(item._seq_no) ? { seqNo: numberToken(item._seq_no) } : {}),
    ...(numberToken(item._primary_term) ? { primaryTerm: numberToken(item._primary_term) } : {}),
    ...(routing ? { routing } : {}),
  }
}
function boundedAggregation(value: SearchJson): void {
  let count = 0
  const visit = (item: SearchJson, depth = 0) => {
    if (depth > 64) throw new Error('Aggregation nesting exceeds the display limit.')
    if (!item || typeof item !== 'object' || isLosslessNumber(item)) return
    for (const [key, child] of Object.entries(item)) {
      if (key === 'buckets' && child && typeof child === 'object') count += Object.keys(child).length
      if (count > 10000)
        throw new Error('Aggregation result exceeds the 10000-bucket display limit. Narrow the aggregation.')
      visit(child, depth + 1)
    }
  }
  visit(value)
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
    throw new Error('The displayed result exceeds 8 MiB. Narrow source fields or aggregation scope.')
  return value
}

/** Product identity and PIT protocol differ even where the JSON UI is shared. */
export class SearchClusterService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  constructor(readonly product: Product) {}
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (String(profile.engine) !== this.product) throw new Error('Use the matching search-product adapter.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    const started = performance.now()
    this.states.set(profile.id, { state: 'connecting' })
    let transport: Transport | undefined
    let http: SearchHttp | undefined
    try {
      transport = await openTransport(profile, secrets)
      http = new SearchHttp(profile, transport, secrets)
      const response = await http.request('GET', '/', undefined, undefined, profile.connectTimeout)
      const body = searchObject(response.body)
      const version = searchObject(body.version)
      const number = scalar(version.number) || ''
      const match = /^(\d+)\.(\d+)\.\d+/.exec(number)
      if (!match) throw new Error('The server did not identify a supported product version.')
      if (this.product === 'elasticsearch') {
        if (
          response.headers['x-elastic-product'] !== 'Elasticsearch' ||
          version.distribution === 'opensearch'
        )
          throw new Error('This endpoint is not verified as Elasticsearch. Choose the correct engine.')
        if (![8, 9].includes(Number(match[1])))
          throw new Error(
            'This adapter targets Elasticsearch 8 and 9 REST APIs; other majors are not supported.',
          )
      } else {
        if (version.distribution !== 'opensearch')
          throw new Error(
            'This endpoint is not verified as OpenSearch. Compatibility responses are not sufficient.',
          )
        if (Number(match[1]) !== 3 || Number(match[2]) < 4)
          throw new Error(
            'OpenSearch 3.4 or later in major 3 is required for the verified PIT shard/document tie-breaker API.',
          )
      }
      if (this.generations.get(profile.id) !== generation) {
        http.close()
        await transport.close()
        return { state: 'disconnected' }
      }
      const status: ConnectionStatus = {
        state: 'connected',
        version: `${this.product === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch'} ${number}`,
        durationMs: Math.round(performance.now() - started),
        transport: `${profile.ssh.enabled ? 'SSH tunnel + ' : ''}${profile.tls.enabled ? 'HTTPS' : 'HTTP'}`,
        lastConnectedAt: new Date().toISOString(),
      }
      this.connections.set(profile.id, {
        profile,
        transport,
        http,
        version: number,
        closed: false,
        cursors: new Map(),
        active: new Map(),
        status,
      })
      this.states.set(profile.id, status)
      return status
    } catch (error) {
      http?.close()
      await transport?.close()
      if (this.generations.get(profile.id) !== generation) return { state: 'disconnected' }
      const status: ConnectionStatus = {
        state: 'failed',
        error: error instanceof Error ? error.message : 'Search connection failed.',
        durationMs: Math.round(performance.now() - started),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }
  }
  async getSessionState(input: { connectionId: string; sessionId: string }) {
    return {
      state: 'idle' as const,
      connected: this.status(input.connectionId).state === 'connected',
      running: this.connections.get(input.connectionId)?.active.has(input.sessionId) || false,
    }
  }
  private live(id: string): Live {
    const live = this.connections.get(id)
    if (!live || live.closed) throw new Error('Search service is disconnected. Connect explicitly.')
    return live
  }
  private async request(
    live: Live,
    ...args: Parameters<SearchHttp['request']>
  ): ReturnType<SearchHttp['request']> {
    try {
      const response = await live.http.request(...args)
      if (!live.closed && this.connections.get(live.profile.id) === live) {
        const recovered = live.status.state !== 'connected'
        live.status = {
          ...live.status,
          state: 'connected',
          error: undefined,
          checkedAt: new Date().toISOString(),
          ...(recovered ? { lastConnectedAt: new Date().toISOString() } : {}),
        }
        this.states.set(live.profile.id, live.status)
      }
      return response
    } catch (error) {
      const authentication = error instanceof SearchHttpError && error.status === 401
      const network =
        error instanceof SearchHttpError
          ? error.status >= 500
          : error instanceof Error && ('code' in error || /timed out/.test(error.message))
      if (!live.closed && this.connections.get(live.profile.id) === live && (authentication || network)) {
        live.status = {
          ...live.status,
          state: authentication ? 'authentication-failed' : 'degraded',
          checkedAt: new Date().toISOString(),
          error: authentication
            ? 'Authentication failed. Reconnect with valid credentials.'
            : 'The last request could not establish readiness. Check the connection or reload a document; no operation was replayed.',
        }
        this.states.set(live.profile.id, live.status)
      }
      throw error
    }
  }
  private claim(live: Live, sessionId: string, requestId: string): AbortController {
    sessionName(sessionId)
    if (live.active.has(sessionId)) throw new Error('This search tab already has a running operation.')
    const controller = new AbortController()
    live.active.set(sessionId, { requestId, controller })
    return controller
  }
  private async drop(live: Live, cursor: Cursor): Promise<void> {
    live.cursors.delete(cursor.token)
    await this.request(
      live,
      'DELETE',
      this.product === 'elasticsearch' ? '/_pit' : '/_search/point_in_time',
      this.product === 'elasticsearch' ? { id: cursor.pit } : { pit_id: [cursor.pit] },
      undefined,
      Math.min(live.profile.queryTimeout, 3000),
    )
  }
  private async prune(live: Live): Promise<void> {
    for (const cursor of [...live.cursors.values()])
      if (cursor.expires <= Date.now() && !live.active.has(cursor.sessionId))
        await this.drop(live, cursor).catch(() => {})
  }
  async catalog(input: { connectionId: string }): Promise<SearchCatalog> {
    const live = this.live(input.connectionId)
    const warnings: string[] = []
    const response = (
      await this.request(
        live,
        'GET',
        '/_cat/indices?format=json&h=index,health,status,docs.count&expand_wildcards=open',
      )
    ).body
    if (!Array.isArray(response) || response.length > 1000)
      throw new Error(
        'Catalog exceeds 1000 indices or returned an unexpected shape. Narrow access using an index-scoped account.',
      )
    let aliases: SearchObject = {}
    try {
      aliases = searchObject((await this.request(live, 'GET', '/_alias?expand_wildcards=open')).body)
    } catch (error) {
      if (error instanceof SearchHttpError && [403, 404].includes(error.status))
        warnings.push('Aliases are unavailable with current metadata permissions.')
      else throw error
    }
    const indices = response.map((value) => {
      const item = searchObject(value)
      const name = String(item.index)
      let names: string[] = []
      if (aliases[name]) names = Object.keys(searchObject(searchObject(aliases[name]).aliases))
      return {
        name,
        health: String(item.health || 'unknown'),
        status: String(item.status || 'unknown'),
        documents: scalar(item['docs.count']) || 'unknown',
        aliases: names,
      }
    })
    let health: SearchCatalog['health']
    try {
      const status = searchObject(
        (await this.request(live, 'GET', '/_cluster/health?timeout=1s', undefined, undefined, 2000)).body,
      )
      health = {
        status: String(status.status || 'unknown'),
        timedOut: status.timed_out === true,
        nodes: searchNumber(status.number_of_nodes),
      }
    } catch {
      warnings.push('Cluster health is unavailable; index exploration may still be permitted.')
    }
    return bounded({ engine: this.product, version: live.version, indices, health, warnings })
  }
  async mappings(input: { connectionId: string; index: string }): Promise<SearchMapping> {
    const live = this.live(input.connectionId)
    const target = searchIndex(input.index)
    const mapping = (await this.request(live, 'GET', `/${target}/_mapping`)).body
    let aliases: SearchJson = {}
    const warnings: string[] = []
    try {
      aliases = (await this.request(live, 'GET', `/${target}/_alias`)).body
    } catch (error) {
      if (error instanceof SearchHttpError && [403, 404].includes(error.status))
        warnings.push('Alias metadata is unavailable.')
      else throw error
    }
    return bounded({
      index: input.index,
      mappingsJson: encodeSearchJson(mapping),
      aliasesJson: encodeSearchJson(aliases),
      warnings,
    })
  }
  async search(raw: SearchInput): Promise<SearchResult> {
    const input = searchInputSchema.parse(raw)
    const live = this.live(input.connectionId)
    const target = searchIndex(input.index)
    const controller = this.claim(live, input.sessionId, input.requestId)
    const started = performance.now()
    let cursor: Cursor | undefined
    try {
      const dsl = parseSearchDsl(input.dsl, input.pageSize)
      await this.prune(live)
      if (input.cursor) {
        const candidate = live.cursors.get(input.cursor)
        if (
          !candidate ||
          candidate.sessionId !== input.sessionId ||
          candidate.index !== input.index ||
          candidate.dsl !== input.dsl ||
          candidate.pageSize !== input.pageSize
        )
          throw new Error(
            'This cursor expired or belongs to different search inputs. Run the search explicitly again.',
          )
        cursor = candidate
        if (cursor.expires <= Date.now())
          throw new Error('This cursor expired. Run the search explicitly again.')
      } else {
        for (const prior of [...live.cursors.values()])
          if (prior.sessionId === input.sessionId) await this.drop(live, prior).catch(() => {})
        if (live.cursors.size >= 16)
          throw new Error('Close another search snapshot before opening more than 16.')
        if (input.pageSize > 0) {
          const route =
            this.product === 'elasticsearch'
              ? `/${target}/_pit?keep_alive=2m&allow_partial_search_results=false`
              : `/${target}/_search/point_in_time?keep_alive=2m&allow_partial_pit_creation=false`
          const opened = searchObject(
            (await this.request(live, 'POST', route, undefined, controller.signal)).body,
          )
          const pit = scalar(this.product === 'elasticsearch' ? opened.id : opened.pit_id)
          if (!pit)
            throw new Error(
              'The server did not create a point-in-time snapshot; no live-pagination fallback was used.',
            )
          cursor = {
            token: randomUUID(),
            sessionId: input.sessionId,
            index: input.index,
            dsl: input.dsl,
            pageSize: input.pageSize,
            pit,
            expires: Date.now() + 110000,
          }
          live.cursors.set(cursor.token, cursor)
        }
      }
      const body: SearchObject = {
        ...dsl,
        size: input.pageSize,
        seq_no_primary_term: true,
        timeout: `${Math.min(live.profile.queryTimeout, 600000)}ms`,
        track_total_hits: dsl.track_total_hits ?? 10000,
      }
      const stored =
        dsl.stored_fields === undefined
          ? []
          : Array.isArray(dsl.stored_fields)
            ? dsl.stored_fields
            : [dsl.stored_fields]
      if (stored.some((field) => typeof field !== 'string' || field === '_none_'))
        throw new Error(
          'stored_fields must preserve document identity; use a field name or string array, not _none_.',
        )
      body.stored_fields = [...new Set([...stored, '_routing'])]
      body._source = dsl._source ?? true
      if (cursor) {
        const requested = dsl.sort === undefined ? [] : Array.isArray(dsl.sort) ? dsl.sort : [dsl.sort]
        if (requested.length > 8) throw new Error('At most eight explicit search sort fields are supported.')
        const sorts = requested.length ? requested : [{ _score: 'desc' }]
        body.sort = sorts.some((sort) =>
          typeof sort === 'string'
            ? sort === '_shard_doc'
            : Object.keys(searchObject(sort)).includes('_shard_doc'),
        )
          ? sorts
          : [...sorts, { _shard_doc: 'asc' }]
        body.pit = { id: cursor.pit, keep_alive: '2m' }
        if (cursor.after) body.search_after = cursor.after
      }
      const response = searchObject(
        (
          await this.request(
            live,
            'POST',
            cursor ? '/_search' : `/${target}/_search`,
            body,
            controller.signal,
          )
        ).body,
      )
      const found = searchObject(response.hits)
      const list = found.hits
      if (!Array.isArray(list) || list.length > input.pageSize)
        throw new Error('The server exceeded the requested bounded hit count.')
      const hits = list.map(hit)
      const shards = response._shards ? searchObject(response._shards) : {}
      const failed = searchNumber(shards.failed)
      const timedOut = response.timed_out === true
      const partial = timedOut || failed > 0 || response.terminated_early === true
      if (response.aggregations) boundedAggregation(response.aggregations)
      const warnings = [
        'Results are a bounded page. Aggregations apply to the query scope and may be approximate; inspect returned aggregation metadata.',
        'Document values are displayed and copied without numeric rounding.',
      ]
      if (partial)
        warnings.push(
          'Search returned partial or timed-out results. Pagination is closed; rerun explicitly after narrowing the query.',
        )
      let nextCursor: string | undefined
      let cursorExpiresAt: string | undefined
      if (cursor) {
        if (typeof response.pit_id === 'string') cursor.pit = response.pit_id
        const last = list.length ? searchObject(list[list.length - 1]) : undefined
        if (!partial && list.length === input.pageSize && last && Array.isArray(last.sort)) {
          live.cursors.delete(cursor.token)
          cursor.token = randomUUID()
          cursor.after = last.sort
          cursor.expires = Date.now() + 110000
          live.cursors.set(cursor.token, cursor)
          nextCursor = cursor.token
          cursorExpiresAt = new Date(cursor.expires).toISOString()
        } else
          await this.drop(live, cursor).catch(() =>
            warnings.push(
              'Snapshot cleanup could not be confirmed; the server keep-alive expires after two minutes.',
            ),
          )
      }
      let total: SearchResult['total'] = { value: '0', relation: 'unknown' }
      if (found.total !== undefined) {
        if (isLosslessNumber(found.total) || typeof found.total === 'number')
          total = { value: String(found.total), relation: 'eq' }
        else {
          const detail = searchObject(found.total)
          total = {
            value: scalar(detail.value) || '0',
            relation: detail.relation === 'eq' ? 'eq' : detail.relation === 'gte' ? 'gte' : 'unknown',
          }
        }
      }
      return bounded({
        requestId: input.requestId,
        hits,
        ...(response.aggregations ? { aggregationsJson: encodeSearchJson(response.aggregations) } : {}),
        total,
        tookMs: searchNumber(response.took),
        durationMs: Math.round(performance.now() - started),
        timedOut,
        partial,
        shardFailures: failed,
        nextCursor,
        cursorExpiresAt,
        warnings,
      })
    } catch (error) {
      if (cursor) await this.drop(live, cursor).catch(() => {})
      throw error
    } finally {
      live.active.delete(input.sessionId)
    }
  }
  async document(raw: SearchDocumentInput): Promise<SearchHit> {
    const input = searchDocumentSchema.parse(raw)
    const live = this.live(input.connectionId)
    const target = searchIndex(input.index, true)
    const route = `/${target}/_doc/${encodeURIComponent(input.id)}${input.routing ? '?routing=' + encodeURIComponent(input.routing) : ''}`
    return bounded(hit((await this.request(live, 'GET', route)).body))
  }
  async mutate(raw: SearchMutationInput): Promise<SearchMutationResult> {
    const input = searchMutationSchema.parse(raw)
    const live = this.live(input.connectionId)
    const target = searchIndex(input.index, true)
    if (live.status.state !== 'connected')
      throw new Error(
        'The search connection is not ready for writes. Check the connection or reload the exact document first.',
      )
    if (live.profile.readOnly)
      throw new Error(
        'This connection is read-only. Deliberately enable writes before reviewing a document change.',
      )
    if (input.confirm !== searchMutationConfirmation(input, live.profile))
      throw new Error('The exact document target confirmation is missing or changed.')
    if (input.operation !== 'create' && (!input.seqNo || !input.primaryTerm))
      throw new Error(
        'Replace and delete require the observed sequence number and primary term. Reload the document before review.',
      )
    if (input.operation === 'create' && (input.seqNo || input.primaryTerm))
      throw new Error('Create-only writes do not use replacement concurrency tokens.')
    const body = input.operation === 'delete' ? undefined : searchObject(searchJson(input.document || ''))
    const controller = this.claim(live, input.sessionId, input.requestId)
    let submitted = false
    try {
      const metadata = searchObject(
        (await this.request(live, 'GET', `/${target}/_mapping`, undefined, controller.signal)).body,
      )
      if (Object.keys(metadata).length !== 1 || !Object.hasOwn(metadata, input.index))
        throw new Error(
          'Select an existing concrete index. Alias, data-stream and automatic index creation writes are not supported.',
        )
      const parameters = new URLSearchParams({ refresh: 'wait_for' })
      if (input.routing) parameters.set('routing', input.routing)
      if (input.operation !== 'create') {
        parameters.set('if_seq_no', input.seqNo!)
        parameters.set('if_primary_term', input.primaryTerm!)
      }
      const route = `/${target}/${input.operation === 'create' ? '_create' : '_doc'}/${encodeURIComponent(input.id)}?${parameters}`
      submitted = true
      const result = searchObject(
        (
          await this.request(
            live,
            input.operation === 'delete' ? 'DELETE' : 'PUT',
            route,
            body,
            controller.signal,
          )
        ).body,
      )
      if (
        result.result !==
          ({ create: 'created', replace: 'updated', delete: 'deleted' } as const)[input.operation] ||
        result._index !== input.index ||
        result._id !== input.id
      )
        throw new Error(
          'The write response did not confirm the expected document outcome. Inspect before retrying.',
        )
      const warnings = [
        'One document was acknowledged. There is no multi-document transaction or automatic retry.',
      ]
      if (result._shards && searchNumber(searchObject(result._shards).failed) > 0)
        warnings.push(
          'The primary acknowledged the write but some shard copies failed. Inspect cluster health; do not replay the write.',
        )
      return {
        requestId: input.requestId,
        result: String(result.result) as SearchMutationResult['result'],
        index: input.index,
        id: input.id,
        seqNo: numberToken(result._seq_no),
        primaryTerm: numberToken(result._primary_term),
        warnings,
      }
    } catch (error) {
      if (submitted && (!(error instanceof SearchHttpError) || error.status >= 500 || error.status === 429))
        throw new Error(
          'The document write outcome is uncertain after interruption or a non-definitive response. Reload the exact document before retrying; Harbor did not replay it.',
        )
      throw error
    } finally {
      live.active.delete(input.sessionId)
    }
  }
  async closeCursor(input: { connectionId: string; sessionId: string; cursor: string }): Promise<void> {
    const live = this.live(input.connectionId)
    const cursor = live.cursors.get(input.cursor)
    if (cursor && cursor.sessionId !== input.sessionId) throw new Error('Snapshot belongs to another tab.')
    if (cursor) {
      live.active.get(input.sessionId)?.controller.abort()
      await this.drop(live, cursor)
    }
  }
  async cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<SearchCancelResult> {
    const active = this.live(input.connectionId).active.get(input.sessionId)
    if (!active || active.requestId !== input.requestId)
      return {
        requested: false,
        serverCancellationConfirmed: false,
        message: 'No matching request is waiting.',
      }
    active.controller.abort()
    return {
      requested: true,
      serverCancellationConfirmed: false,
      message:
        'HTTP waiting stopped. Server cancellation is not confirmed; submitted writes may have an uncertain outcome. No operation is replayed.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }): Promise<void> {
    const live = this.connections.get(input.connectionId)
    if (!live) return
    live.active.get(input.sessionId)?.controller.abort()
    for (const cursor of [...live.cursors.values()])
      if (cursor.sessionId === input.sessionId) await this.drop(live, cursor).catch(() => {})
  }
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!live) return
    live.closed = true
    for (const active of live.active.values()) active.controller.abort()
    await Promise.allSettled([...live.cursors.values()].map((cursor) => this.drop(live, cursor)))
    live.http.close()
    await live.transport.close()
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
