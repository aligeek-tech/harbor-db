import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { profileSchema } from '../src/shared/contracts'
import { couchConfirmation, type CouchMutationInput } from '../src/shared/couchdb'
import { CouchdbService } from '../src/main/engines/couchdb'
const fixture = process.env.HARBOR_COUCHDB_FIXTURE_DIR
const service = new CouchdbService(),
  database = 'harbor_' + randomUUID().replaceAll('-', '')
const profile = profileSchema.parse({
  id: randomUUID(),
  name: 'CouchDB native fixture',
  engine: 'couchdb',
  host: '127.0.0.1',
  port: 15984,
  username: 'harbor_fixture',
  database,
  readOnly: false,
})
let password = '',
  authorization = ''
async function native(path: string, method = 'GET', body?: unknown) {
  const response = await fetch('http://127.0.0.1:15984' + path, {
    method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
const input = (id: string, action: CouchMutationInput['action'], source?: string, revision?: string) => {
  const value = { connectionId: profile.id, database, id, action, source, revision }
  return { ...value, confirm: couchConfirmation(value) }
}
const read = (extra: Record<string, unknown> = {}) =>
  service.read({
    connectionId: profile.id,
    database,
    sessionId: 'query',
    requestId: randomUUID(),
    selector: '{"_id":{"$gt":null}}',
    pageSize: 25,
    allowScan: true,
    ...extra,
  })
describe.skipIf(!fixture)('CouchDB 3.5 native revision/document workflow', () => {
  beforeAll(async () => {
    const env = await readFile(fixture + '/fixture.env', 'utf8')
    password = /^COUCHDB_PASSWORD=(.+)$/m.exec(env)![1]!
    authorization = 'Basic ' + Buffer.from('harbor_fixture:' + password).toString('base64')
    expect((await native('/' + database, 'PUT')).status).toBe(201)
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toBe('CouchDB 3.5.1')
  })
  afterAll(async () => {
    await service.closeAll()
    if (authorization) await native('/' + database, 'DELETE')
  })
  it('preserves native numbers, Unicode and revision identity through reviewed CRUD', async () => {
    const source =
      '{"_id":"precision","integer":9007199254740993,"decimal":0.12345678901234567,"nested":{"label":"سلام 🌊"}}'
    const created = await service.mutate(input('precision', 'create', source))
    const doc = await service.document({ connectionId: profile.id, database, id: 'precision' })
    expect(doc.source).toContain('9007199254740993')
    expect(doc.source).toContain('سلام 🌊')
    expect(doc.revision).toBe(created.revision)
    const updated = await service.mutate(
      input('precision', 'replace', doc.source.replace('سلام', 'updated'), doc.revision),
    )
    expect(updated.revision).not.toBe(doc.revision)
    await expect(service.mutate(input('precision', 'replace', doc.source, doc.revision))).rejects.toThrow(
      'Conflict',
    )
    await expect(service.mutate(input('precision', 'delete', undefined, doc.revision))).rejects.toThrow(
      'Conflict',
    )
    await service.mutate(input('precision', 'delete', undefined, updated.revision))
    expect((await native('/' + database + '/precision')).status).toBe(404)
  })
  it('pages actual selectors with opaque query-bound cursors and explicit fallback consent', async () => {
    const docs = Array.from({ length: 63 }, (_, i) => ({
      _id: 'page-' + String(i).padStart(3, '0'),
      kind: 'fixture',
      rank: i,
    }))
    expect((await native('/' + database + '/_bulk_docs', 'POST', { docs })).status).toBe(201)
    let page = await read()
    const ids = new Set(page.documents.map((doc) => doc.id))
    expect(page.documents).toHaveLength(25)
    expect(page.cursor).toMatch(/^[a-f0-9-]{36}$/)
    while (page.cursor) {
      page = await read({ cursor: page.cursor })
      page.documents.forEach((doc) => ids.add(doc.id))
    }
    expect(ids.size).toBe(63)
    const first = await read()
    await expect(read({ cursor: first.cursor, selector: '{"kind":"fixture"}' })).rejects.toThrow(
      'selector/target changed',
    )
    await expect(read({ selector: '{"kind":"fixture"}', allowScan: false })).rejects.toThrow()
    const fallback = await read({ selector: '{"kind":"fixture"}', allowScan: true })
    expect(fallback.documents).toHaveLength(25)
    expect(fallback.warning).toContain('fallback')
  })
  it('rejects unreviewed/readonly/system/duplicate-key edits before dispatch', async () => {
    await expect(
      service.mutate({ ...input('not-written', 'create', '{"_id":"not-written"}'), confirm: '' }),
    ).rejects.toThrow('exact action')
    await expect(
      service.mutate(input('_design/unsafe', 'create', '{"_id":"_design/unsafe"}')),
    ).rejects.toThrow('ordinary document')
    await expect(
      service.mutate(input('duplicate', 'create', '{"_id":"duplicate","x":1,"x":2}')),
    ).rejects.toThrow('duplicate')
    const readonly = profileSchema.parse({ ...profile, id: randomUUID(), readOnly: true })
    expect((await service.connect(readonly, { password })).state).toBe('connected')
    const mutation = { ...input('readonly', 'create', '{"_id":"readonly"}'), connectionId: readonly.id }
    mutation.confirm = couchConfirmation(mutation)
    await expect(service.mutate(mutation)).rejects.toThrow('read-only')
    expect((await native('/' + database + '/readonly')).status).toBe(404)
    const invalid = await service.connect(
      { ...profile, id: randomUUID() },
      { password: 'wrong disposable value' },
    )
    expect(invalid.state).toBe('failed')
    expect(invalid.error).not.toContain(password)
  })
  it('shows real sibling revisions and attachments without silently rewriting them', async () => {
    const docs = [
      { _id: 'siblings', _rev: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', value: 'a' },
      { _id: 'siblings', _rev: '1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', value: 'b' },
    ]
    await native('/' + database + '/_bulk_docs', 'POST', { new_edits: false, docs })
    const doc = await service.document({ connectionId: profile.id, database, id: 'siblings' })
    expect(doc.conflicts).toHaveLength(1)
    const sibling = await service.document({
      connectionId: profile.id,
      database,
      id: 'siblings',
      revision: doc.conflicts[0],
    })
    expect(sibling.revision).toBe(doc.conflicts[0])
    const clean = JSON.parse(doc.source) as Record<string, unknown>
    delete clean._conflicts
    await expect(
      service.mutate(input('siblings', 'replace', JSON.stringify(clean), doc.revision)),
    ).rejects.toThrow('sibling conflicts')
    await native('/' + database + '/attached', 'PUT', {
      _id: 'attached',
      _attachments: {
        'example.txt': { content_type: 'text/plain', data: Buffer.from('synthetic').toString('base64') },
      },
    })
    const attached = await service.document({ connectionId: profile.id, database, id: 'attached' })
    expect(attached.attachmentNames).toEqual(['example.txt'])
    await expect(
      service.mutate(
        input(
          'attached',
          'replace',
          JSON.stringify({ _id: attached.id, _rev: attached.revision }),
          attached.revision,
        ),
      ),
    ).rejects.toThrow('attachments')
  })
  it('enforces real server document permissions independently of the local safeguard', async () => {
    const username = 'harbor_reader_' + randomUUID().replaceAll('-', ''),
      userId = 'org.couchdb.user:' + username,
      userPassword = randomUUID()
    expect(
      (
        await native('/_users/' + encodeURIComponent(userId), 'PUT', {
          _id: userId,
          name: username,
          password: userPassword,
          roles: ['harbor_reader'],
          type: 'user',
        })
      ).status,
    ).toBe(201)
    await native('/' + database + '/_security', 'PUT', {
      admins: { names: [], roles: [] },
      members: { names: [username], roles: [] },
    })
    expect(
      (
        await native('/' + database + '/_design/guard', 'PUT', {
          validate_doc_update:
            'function(newDoc,oldDoc,userCtx){if(userCtx.roles.indexOf("harbor_reader")>=0){throw({forbidden:"Read access only"})}}',
        })
      ).status,
    ).toBe(201)
    const restricted = profileSchema.parse({ ...profile, id: randomUUID(), username })
    try {
      expect((await service.connect(restricted, { password: userPassword })).state).toBe('connected')
      const doc = await service.document({ connectionId: restricted.id, database, id: 'attached' })
      expect(doc.id).toBe('attached')
      const mutation = {
        ...input('server-denied', 'create', '{"_id":"server-denied"}'),
        connectionId: restricted.id,
      }
      mutation.confirm = couchConfirmation(mutation)
      await expect(service.mutate(mutation)).rejects.toThrow('Permission denied')
      expect((await native('/' + database + '/server-denied')).status).toBe(404)
    } finally {
      await service.disconnect(restricted.id)
      const user = await native('/_users/' + encodeURIComponent(userId))
      await native(
        '/_users/' + encodeURIComponent(userId) + '?rev=' + encodeURIComponent(String(user.body._rev)),
        'DELETE',
      )
    }
  })
  it('cancels only the matching read and invalidates cursors on reconnect', async () => {
    let arrived!: () => void
    const reached = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const proxy = http.createServer((request, response) => {
      if (request.url?.endsWith('/_find')) {
        request.resume()
        arrived()
        return
      }
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: 15984,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode || 500, incoming.headers)
          incoming.pipe(response)
        },
      )
      upstream.on('error', () => response.destroy())
      request.pipe(upstream)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxied = profileSchema.parse({
      ...profile,
      id: randomUUID(),
      port: (proxy.address() as { port: number }).port,
    })
    try {
      expect((await service.connect(proxied, { password })).state).toBe('connected')
      const pending = service.read({
        connectionId: proxied.id,
        database,
        sessionId: 'cancel',
        requestId: 'active',
        selector: '{}',
        pageSize: 25,
        allowScan: true,
      })
      const observed = expect(pending).rejects.toThrow('stopped')
      await reached
      await service.cancel({ connectionId: proxied.id, sessionId: 'cancel', requestId: 'other' })
      await expect(
        service.read({
          connectionId: proxied.id,
          database,
          sessionId: 'cancel',
          requestId: 'second',
          selector: '{}',
          pageSize: 25,
          allowScan: true,
        }),
      ).rejects.toThrow('already running')
      await service.cancel({ connectionId: proxied.id, sessionId: 'cancel', requestId: 'active' })
      await observed
    } finally {
      await service.disconnect(proxied.id)
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
    const page = await read()
    await service.disconnect(profile.id)
    expect((await service.connect(profile, { password })).state).toBe('connected')
    await expect(read({ cursor: page.cursor })).rejects.toThrow('expired')
  })
  it('preserves uncertainty after a real persisted write loses its HTTP acknowledgment without replay', async () => {
    let writes = 0
    const proxy = http.createServer((request, response) => {
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: 15984,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (incoming) => {
          if (request.method === 'PUT') {
            writes++
            incoming.resume()
            incoming.on('end', () => response.destroy())
          } else {
            response.writeHead(incoming.statusCode || 500, incoming.headers)
            incoming.pipe(response)
          }
        },
      )
      upstream.on('error', () => response.destroy())
      request.pipe(upstream)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as { port: number }).port,
      proxied = profileSchema.parse({ ...profile, id: randomUUID(), port })
    try {
      expect((await service.connect(proxied, { password })).state).toBe('connected')
      const mutation = {
        ...input('lost-ack', 'create', '{"_id":"lost-ack","value":1}'),
        connectionId: proxied.id,
      }
      mutation.confirm = couchConfirmation(mutation)
      await expect(service.mutate(mutation)).rejects.toThrow('uncertain')
      expect((await native('/' + database + '/lost-ack')).status).toBe(200)
      expect(writes).toBe(1)
    } finally {
      await service.disconnect(proxied.id)
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })
  it('verifies native CouchDB through TLS and rejects an untrusted root and disabled verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harbor-couch-tls-'))
    const key = join(dir, 'key.pem'),
      cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    )
    const ca = await readFile(cert, 'utf8'),
      proxy = https.createServer({ key: await readFile(key), cert: ca }, (request, response) => {
        const upstream = http.request(
          {
            hostname: '127.0.0.1',
            port: 15984,
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode || 500, incoming.headers)
            incoming.pipe(response)
          },
        )
        upstream.on('error', () => response.destroy())
        request.pipe(upstream)
      })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const secure = profileSchema.parse({
      ...profile,
      id: randomUUID(),
      host: 'localhost',
      port: (proxy.address() as { port: number }).port,
      tls: { enabled: true, rejectUnauthorized: true, ca },
    })
    try {
      const connected = await service.connect(secure, { password })
      expect(connected.state, connected.error).toBe('connected')
      expect(await service.databases(secure.id)).toContain(database)
      expect(
        (await service.connect({ ...secure, id: randomUUID(), tls: { ...secure.tls, ca: '' } }, { password }))
          .state,
      ).toBe('failed')
      expect(
        (
          await service.connect(
            { ...secure, id: randomUUID(), tls: { ...secure.tls, rejectUnauthorized: false } },
            { password },
          )
        ).error,
      ).toContain('verification')
    } finally {
      await service.disconnect(secure.id)
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
