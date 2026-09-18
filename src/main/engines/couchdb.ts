import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  couchReadSchema,
  couchDocumentSchema,
  couchMutationSchema,
  couchConfirmation,
  type CouchReadInput,
  type CouchDocumentInput,
  type CouchMutationInput,
  type CouchDocument,
  type CouchPage,
} from '../../shared/couchdb'
import { openTransport, type Transport } from './transport'
import { CouchHttp, couchJson, couchObject, encodeCouchJson, type CouchJson } from './couchdb-http'
interface Cursor {
  session: string
  query: string
  bookmark: string
  expires: number
}
interface Live {
  profile: ConnectionProfile
  http: CouchHttp
  transport: Transport
  status: ConnectionStatus
  cursors: Map<string, Cursor>
  active: Map<string, { requestId: string; controller: AbortController }>
}
function databasePath(name: string) {
  if (!/^[a-z][a-z0-9_$()+/-]*$/.test(name) || name.length > 255)
    throw new Error('Choose an ordinary CouchDB database name; system databases are excluded.')
  return '/' + encodeURIComponent(name)
}
function docPath(id: string) {
  if (!id || id.startsWith('_') || Array.from(id).some((character) => character.charCodeAt(0) < 32))
    throw new Error('Choose an ordinary document ID. Design and local documents are excluded.')
  return '/' + encodeURIComponent(id)
}
function boundedObject(source: string) {
  if (Buffer.byteLength(source) > 1000000) throw new Error('Document or selector exceeds the 1 MB bound.')
  const object = couchObject(couchJson(source))
  let nodes = 0
  const walk = (value: CouchJson, depth = 0) => {
    if (++nodes > 50000 || depth > 64) throw new Error('JSON complexity exceeds the local bound.')
    if (value && typeof value === 'object') for (const child of Object.values(value)) walk(child, depth + 1)
  }
  walk(object)
  return object
}
function document(value: CouchJson): CouchDocument {
  const object = couchObject(value)
  if (typeof object._id !== 'string' || typeof object._rev !== 'string')
    throw new Error('Document identity or revision is unavailable.')
  const source = encodeCouchJson(object)
  if (Buffer.byteLength(source) > 1000000) throw new Error('A document exceeds the 1 MB editor bound.')
  return {
    id: object._id,
    revision: object._rev,
    source,
    conflicts: Array.isArray(object._conflicts)
      ? object._conflicts.filter((x): x is string => typeof x === 'string')
      : [],
    attachmentNames: object._attachments ? Object.keys(couchObject(object._attachments)) : [],
  }
}
export class CouchdbService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'couchdb') throw new Error('Use the CouchDB adapter.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id),
      started = performance.now()
    let transport: Transport | undefined, http: CouchHttp | undefined
    try {
      transport = await openTransport(profile, secrets)
      http = new CouchHttp(profile, transport, secrets)
      const body = couchObject(
        (await http.request('GET', '/', undefined, undefined, profile.connectTimeout)).body,
      )
      if (body.couchdb !== 'Welcome' || typeof body.version !== 'string' || !/^3\.5\./.test(body.version))
        throw new Error(
          'This adapter requires CouchDB 3.5.x. The endpoint did not identify that product/version.',
        )
      const session = couchObject(
        (await http.request('GET', '/_session', undefined, undefined, profile.connectTimeout)).body,
      )
      if (couchObject(session.userCtx).name !== profile.username)
        throw new Error('CouchDB did not authenticate the selected username.')
      if (this.generations.get(profile.id) !== generation) {
        http.close()
        await transport.close()
        return { state: 'disconnected' }
      }
      const status: ConnectionStatus = {
        state: 'connected',
        version: 'CouchDB ' + body.version,
        durationMs: Math.round(performance.now() - started),
        transport: `${profile.ssh.enabled ? 'Verified SSH + ' : ''}${profile.tls.enabled ? 'HTTPS' : 'HTTP'}`,
        lastConnectedAt: new Date().toISOString(),
      }
      this.connections.set(profile.id, {
        profile,
        http,
        transport,
        status,
        cursors: new Map(),
        active: new Map(),
      })
      return status
    } catch (error) {
      http?.close()
      await transport?.close()
      const status: ConnectionStatus = {
        state: 'failed',
        error: error instanceof Error ? error.message : 'CouchDB connection failed.',
      }
      if (this.generations.get(profile.id) === generation) this.states.set(profile.id, status)
      return status
    }
  }
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live) throw new Error('Connect to CouchDB before running this operation.')
    return live
  }
  async databases(id: string): Promise<string[]> {
    const live = this.live(id)
    const body = (await live.http.request('GET', '/_all_dbs?limit=501')).body
    if (!Array.isArray(body)) throw new Error('Invalid CouchDB database list.')
    if (body.length > 500)
      throw new Error('More than 500 databases are present. Enter the exact database name instead.')
    return body.filter((x): x is string => typeof x === 'string' && !x.startsWith('_'))
  }
  async read(raw: CouchReadInput): Promise<CouchPage> {
    const input = couchReadSchema.parse(raw),
      live = this.live(input.connectionId),
      path = databasePath(input.database)
    if (live.active.has(input.sessionId) || live.active.size >= 4)
      throw new Error('A request is already running. Wait or cancel before querying again.')
    const selector = boundedObject(input.selector),
      query = JSON.stringify([input.database, input.selector, input.pageSize, input.allowScan, input.index]),
      controller = new AbortController(),
      started = performance.now()
    for (const [id, cursor] of live.cursors) if (cursor.expires < Date.now()) live.cursors.delete(id)
    let bookmark: string | undefined
    if (input.cursor) {
      const cursor = live.cursors.get(input.cursor)
      live.cursors.delete(input.cursor)
      if (!cursor || cursor.session !== input.sessionId || cursor.query !== query)
        throw new Error('The cursor expired or selector/target changed. Restart the query.')
      bookmark = cursor.bookmark
    } else
      for (const [id, cursor] of live.cursors) if (cursor.session === input.sessionId) live.cursors.delete(id)
    live.active.set(input.sessionId, { requestId: input.requestId, controller })
    try {
      const response = couchObject(
        (
          await live.http.request(
            'POST',
            path + '/_find',
            {
              selector,
              limit: input.pageSize,
              conflicts: true,
              execution_stats: true,
              allow_fallback: input.allowScan,
              ...(input.index ? { use_index: input.index } : {}),
              ...(bookmark ? { bookmark } : {}),
            },
            controller.signal,
          )
        ).body,
      )
      if (this.connections.get(input.connectionId) !== live)
        throw new Error('The connection changed during the request. Restart the query.')
      if (!Array.isArray(response.docs) || response.docs.length > input.pageSize)
        throw new Error('CouchDB exceeded the requested page size.')
      const documents = response.docs.map(document)
      let cursor: string | undefined
      if (
        documents.length === input.pageSize &&
        typeof response.bookmark === 'string' &&
        response.bookmark !== bookmark
      ) {
        if (live.cursors.size >= 20) live.cursors.delete(live.cursors.keys().next().value!)
        cursor = randomUUID()
        live.cursors.set(cursor, {
          session: input.sessionId,
          query,
          bookmark: response.bookmark,
          expires: Date.now() + 600000,
        })
      }
      const stats = response.execution_stats ? couchObject(response.execution_stats) : undefined
      return {
        documents,
        cursor,
        warning:
          typeof response.warning === 'string'
            ? 'CouchDB reports an index fallback or query warning. This request may scan documents; create a suitable index outside Harbor and review the selector.'
            : undefined,
        examined: stats ? String(stats.total_docs_examined ?? '') : undefined,
        durationMs: Math.round(performance.now() - started),
      }
    } finally {
      live.active.delete(input.sessionId)
    }
  }
  async document(raw: CouchDocumentInput): Promise<CouchDocument> {
    const input = couchDocumentSchema.parse(raw),
      live = this.live(input.connectionId)
    const query = new URLSearchParams({
      conflicts: 'true',
      ...(input.revision ? { rev: input.revision } : {}),
    })
    return document(
      (await live.http.request('GET', databasePath(input.database) + docPath(input.id) + '?' + query)).body,
    )
  }
  async mutate(raw: CouchMutationInput): Promise<{ id: string; revision: string }> {
    const input = couchMutationSchema.parse(raw),
      live = this.live(input.connectionId),
      path = databasePath(input.database) + docPath(input.id)
    if (live.profile.readOnly) throw new Error('This CouchDB profile is read-only.')
    if (input.confirm !== couchConfirmation(input))
      throw new Error('Type the exact action, target and revision before changing this document.')
    if (input.action !== 'create' && !/^\d+-[a-f0-9]+$/.test(input.revision || ''))
      throw new Error('Reload the document and review its current revision.')
    if (input.action === 'create' && input.revision)
      throw new Error('A new document cannot supply a revision.')
    let body: CouchJson | undefined
    if (input.action !== 'delete') {
      body = boundedObject(input.source || '')
      if (body._id !== input.id) throw new Error('The document _id must match the reviewed target.')
      if (input.action === 'replace' && body._rev !== input.revision)
        throw new Error('The document _rev must match the reviewed revision.')
      if (input.action === 'create' && body._rev !== undefined)
        throw new Error('A new document cannot supply _rev.')
      // Avoid silently deleting attachments or resolving sibling revisions as part of ordinary editing.
      for (const field of Object.keys(body))
        if (field.startsWith('_') && !['_id', '_rev'].includes(field))
          throw new Error(
            'Attachment, replication and conflict metadata cannot be written in the ordinary document editor.',
          )
      if (input.action === 'replace') {
        const current = await this.document({
          connectionId: input.connectionId,
          database: input.database,
          id: input.id,
        })
        if (current.revision !== input.revision)
          throw new Error('Conflict: this document changed. Reload and review again; no write was sent.')
        if (current.attachmentNames.length || current.conflicts.length)
          throw new Error(
            'Documents with attachments or sibling conflicts require explicit external resolution before ordinary editing.',
          )
        if (this.connections.get(input.connectionId) !== live)
          throw new Error('The connection changed before the write. Review again.')
      }
    }
    const response = couchObject(
      (
        await live.http.request(
          input.action === 'delete' ? 'DELETE' : 'PUT',
          path + (input.action === 'delete' ? '?rev=' + encodeURIComponent(input.revision!) : ''),
          body,
        )
      ).body,
    )
    if (response.ok !== true || typeof response.id !== 'string' || typeof response.rev !== 'string')
      throw new Error(
        'Write acknowledgment was incomplete. Inspect the document revision before retrying; no write was replayed.',
      )
    return { id: response.id, revision: response.rev }
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const live = this.live(input.connectionId),
      active = live.active.get(input.sessionId)
    if (active?.requestId === input.requestId) active.controller.abort()
  }
  async closeSession(input: { connectionId: string; sessionId: string }) {
    const live = this.connections.get(input.connectionId)
    live?.active.get(input.sessionId)?.controller.abort()
    for (const [id, cursor] of live?.cursors || [])
      if (cursor.session === input.sessionId) live!.cursors.delete(id)
  }
  async disconnect(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (live) {
      for (const active of live.active.values()) active.controller.abort()
      live.http.close()
      await live.transport.close()
    }
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
