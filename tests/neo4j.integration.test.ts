import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import neo4j, { type Driver } from 'neo4j-driver'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { neoConfirmation, type NeoQueryInput } from '../src/shared/neo4j'
import { Neo4jService } from '../src/main/engines/neo4j'
const fixture = process.env.HARBOR_NEO4J_FIXTURE_DIR,
  service = new Neo4jService(),
  tag = 'harbor_' + randomUUID().replaceAll('-', '')
const profile = profileSchema.parse({
  id: randomUUID(),
  name: 'Neo4j native fixture',
  engine: 'neo4j',
  host: '127.0.0.1',
  port: 17687,
  username: 'neo4j',
  database: 'neo4j',
  readOnly: false,
  queryTimeout: 10000,
})
let password = '',
  control: Driver
const query = (cypher: string, extra: Partial<NeoQueryInput> = {}) =>
  service.query({
    connectionId: profile.id,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    database: 'neo4j',
    cypher,
    parameters: [],
    mode: 'read',
    pageSize: 25,
    ...extra,
  })
const mutation = (cypher: string, extra: Partial<NeoQueryInput> = {}) =>
  query(cypher, { mode: 'mutation', confirm: neoConfirmation(profile.id, 'neo4j'), ...extra })
async function native(cypher: string, parameters: Record<string, unknown> = {}) {
  const session = control.session({ database: 'neo4j', disableAutoCommitRetries: true })
  try {
    return await session.run(cypher, parameters)
  } finally {
    await session.close()
  }
}
describe.skipIf(!fixture)('Neo4j native Bolt graph workflow', () => {
  beforeAll(async () => {
    password = /^NEO4J_AUTH=neo4j\/(.+)$/m.exec(await readFile(fixture + '/fixture.env', 'utf8'))![1]!
    control = neo4j.driver('bolt://127.0.0.1:17687', neo4j.auth.basic('neo4j', password), {
      maxTransactionRetryTime: 0,
      disableAutoCommitRetries: true,
      telemetryDisabled: true,
    })
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toBe('Neo4j 5.26.30')
  })
  afterAll(async () => {
    await service.closeAll()
    if (control) {
      await native('MATCH(n:HarborFixture {tag:$tag}) DETACH DELETE n', { tag })
      await control.close()
    }
  })
  it('binds exact integers and temporal values while preserving returned property types', async () => {
    const page = await query(
      'RETURN $integer AS exact, $when AS moment, $day AS day, $duration AS duration, point({longitude:12.3, latitude:45.6}) AS location, $nested AS nested',
      {
        parameters: [
          { name: 'integer', type: 'integer', value: '9223372036854775807' },
          { name: 'when', type: 'datetime', value: '2026-09-18T12:34:56.123456789+03:30' },
          { name: 'day', type: 'date', value: '2026-09-18' },
          { name: 'duration', type: 'duration', value: 'P1M2DT3.123456789S' },
          { name: 'nested', type: 'json', value: '{"exact":9007199254740993,"name":"سلام 🌊"}' },
        ],
      },
    )
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]![0]!.value).toContain('9223372036854775807')
    expect(page.rows[0]![1]!.value).toContain('123456789')
    expect(page.rows[0]![1]!.value).toContain('+03:30')
    expect(page.rows[0]![2]!.value).toContain('2026-09-18')
    expect(page.rows[0]![4]!.value).toContain('4326')
    expect(page.rows[0]![5]!.value).toContain('9007199254740993')
    expect(page.cursor).toBeUndefined()
  })
  it('returns graph nodes, relationships and paths with exact property inspector values', async () => {
    const result = await mutation(
      'CREATE (a:HarborFixture {tag:$tag, exact:$exact}), (b:HarborFixture {tag:$tag}) CREATE p=(a)-[:LINK {weight:0.25}]->(b) RETURN p',
      {
        parameters: [
          { name: 'tag', type: 'string', value: tag },
          { name: 'exact', type: 'integer', value: '9007199254740993' },
        ],
      },
    )
    expect(result.mutationAcknowledged).toBe(true)
    expect(result.nodes).toHaveLength(2)
    expect(result.relationships).toHaveLength(1)
    expect(result.nodes.some((node) => node.properties.includes('9007199254740993'))).toBe(true)
    expect(result.counters?.nodesCreated).toBe(2)
    const expanded = await query(
      'MATCH (n) WHERE elementId(n)=$id OPTIONAL MATCH(n)-[r]-(m) RETURN n,r,m LIMIT 50',
      { parameters: [{ name: 'id', type: 'string', value: result.nodes[0]!.id }] },
    )
    expect(expanded.nodes).toHaveLength(2)
  })
  it('continues one read through bounded pages and invalidates closed cursors', async () => {
    const sessionId = randomUUID()
    let page = await query('UNWIND range(1,63) AS x RETURN x', { sessionId, pageSize: 10 })
    expect(page.rows).toHaveLength(10)
    const first = page.cursor!
    let count = page.rows.length
    while (page.cursor) {
      page = await service.next({
        connectionId: profile.id,
        sessionId,
        requestId: randomUUID(),
        cursor: page.cursor,
      })
      count += page.rows.length
    }
    expect(count).toBe(63)
    await expect(
      service.next({ connectionId: profile.id, sessionId, requestId: randomUUID(), cursor: first }),
    ).rejects.toThrow('expired')
    page = await query('UNWIND range(1,99) AS x RETURN x', { sessionId, pageSize: 10 })
    await service.closeSession({ connectionId: profile.id, sessionId })
    await expect(
      service.next({ connectionId: profile.id, sessionId, requestId: randomUUID(), cursor: page.cursor! }),
    ).rejects.toThrow('expired')
  })
  it('requires reviewed mutations and native read transactions reject writes independently', async () => {
    await expect(
      query('CREATE(n:HarborFixture {tag:$tag})', {
        parameters: [{ name: 'tag', type: 'string', value: tag }],
      }),
    ).rejects.toThrow('mutate')
    await expect(query('CREATE(n)', { mode: 'mutation' })).rejects.toThrow('confirmation')
    await expect(
      query("LOAD CSV FROM 'https://example.invalid/data.csv' AS row RETURN row"),
    ).rejects.toThrow()
    await expect(query('CALL db.labels()')).rejects.toThrow()
    await expect(query('RETURN 1; RETURN 2')).rejects.toThrow('one Cypher')
    const readonly = profileSchema.parse({ ...profile, id: randomUUID(), readOnly: true })
    expect((await service.connect(readonly, { password })).state).toBe('connected')
    await expect(
      service.query({
        connectionId: readonly.id,
        sessionId: 'readonly',
        requestId: 'write',
        database: 'neo4j',
        cypher: 'CREATE(n)',
        parameters: [],
        mode: 'mutation',
        pageSize: 25,
        confirm: neoConfirmation(readonly.id, 'neo4j'),
      }),
    ).rejects.toThrow('writable')
    const session = control.session({ database: 'neo4j', defaultAccessMode: neo4j.session.READ })
    const transaction = session.beginTransaction()
    try {
      await expect(transaction.run('CREATE(n:HarborFixture {tag:$tag})', { tag })).rejects.toThrow()
    } finally {
      await transaction.rollback().catch(() => {})
      await session.close()
    }
  })
  it('rolls back an oversized mutation result rather than silently committing truncated output', async () => {
    const marker = tag + '_rolledback'
    await expect(
      mutation('UNWIND range(1,501) AS x CREATE(n:HarborFixture {tag:$tag}) RETURN n', {
        parameters: [{ name: 'tag', type: 'string', value: marker }],
      }),
    ).rejects.toThrow('rolled back')
    const actual = await native('MATCH(n:HarborFixture {tag:$tag}) RETURN count(n) AS count', { tag: marker })
    expect(actual.records[0]!.get('count').toString()).toBe('0')
  })
  it('bounds simultaneous cursors and allows a new query after matching cancellation', async () => {
    const first = randomUUID(),
      second = randomUUID()
    await query('UNWIND range(1,100) AS x RETURN x', { sessionId: first, requestId: 'one' })
    await query('UNWIND range(1,100) AS x RETURN x', { sessionId: second, requestId: 'two' })
    await expect(query('RETURN 1')).rejects.toThrow('Two Neo4j cursors')
    expect(
      (await service.cancel({ connectionId: profile.id, sessionId: first, requestId: 'wrong' })).requested,
    ).toBe(false)
    expect(
      (await service.cancel({ connectionId: profile.id, sessionId: first, requestId: 'one' })).requested,
    ).toBe(true)
    expect((await query('RETURN 42 AS value')).rows).toHaveLength(1)
    await service.closeSession({ connectionId: profile.id, sessionId: second })
  })
  it('bounds graph projection and total cursor consumption on real native values', async () => {
    await native('UNWIND range(1,205) AS x CREATE(n:HarborFixture {tag:$tag,number:x})', { tag })
    const graph = await query('MATCH(n:HarborFixture {tag:$tag}) RETURN collect(n)', {
      parameters: [{ name: 'tag', type: 'string', value: tag }],
    })
    expect(graph.nodes).toHaveLength(200)
    expect(graph.graphTruncated).toBe(true)
    const sessionId = randomUUID()
    let page = await query('UNWIND range(1,10000) AS x RETURN x', { sessionId, pageSize: 100 })
    while (page.rowsRead < 1000) {
      page = await service.next({
        connectionId: profile.id,
        sessionId,
        requestId: randomUUID(),
        cursor: page.cursor!,
      })
    }
    await expect(
      service.next({ connectionId: profile.id, sessionId, requestId: randomUUID(), cursor: page.cursor! }),
    ).rejects.toThrow('1,000 row')
    expect((await query('RETURN 1')).rows).toHaveLength(1)
  })
  it('reports a genuinely lost COMMIT acknowledgment as uncertain and never replays the mutation', async () => {
    const sockets = new Set<net.Socket>()
    let commits = 0
    const proxy = net.createServer((client) => {
      sockets.add(client)
      const upstream = net.createConnection({ host: '127.0.0.1', port: 17687 })
      sockets.add(upstream)
      let tail = Buffer.alloc(0),
        commit = false
      client.on('data', (chunk) => {
        const combined = Buffer.concat([tail, chunk])
        if (!commit && combined.includes(Buffer.from([0, 2, 0xb0, 0x12, 0, 0]))) {
          commit = true
          commits++
        }
        tail = combined.subarray(-16)
        upstream.write(chunk)
      })
      upstream.on('data', (chunk) => {
        if (commit) {
          client.destroy()
          upstream.destroy()
        } else client.write(chunk)
      })
      for (const socket of [client, upstream]) {
        socket.on('error', () => {
          client.destroy()
          upstream.destroy()
        })
        socket.on('close', () => {
          sockets.delete(socket)
          client.destroy()
          upstream.destroy()
        })
      }
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxied = profileSchema.parse({
        ...profile,
        id: randomUUID(),
        port: (proxy.address() as net.AddressInfo).port,
      }),
      marker = tag + '_uncertain'
    try {
      expect((await service.connect(proxied, { password })).state).toBe('connected')
      await expect(
        service.query({
          connectionId: proxied.id,
          sessionId: 'lost-commit',
          requestId: 'one',
          database: 'neo4j',
          cypher: 'CREATE(n:HarborFixture {tag:$tag}) RETURN n',
          parameters: [{ name: 'tag', type: 'string', value: marker }],
          mode: 'mutation',
          pageSize: 25,
          confirm: neoConfirmation(proxied.id, 'neo4j'),
        }),
      ).rejects.toThrow('uncertain')
      const count = await native('MATCH(n:HarborFixture {tag:$tag}) RETURN count(n) AS count', {
        tag: marker,
      })
      expect(count.records[0]!.get('count').toString()).toBe('1')
      expect(commits).toBe(1)
    } finally {
      await service.disconnect(proxied.id)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await native('MATCH(n:HarborFixture {tag:$tag}) DETACH DELETE n', { tag: marker })
    }
  })
  it('verifies the native Bolt server through TLS without trusting unknown certificates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-neo-tls-')),
      key = join(directory, 'key.pem'),
      cert = join(directory, 'cert.pem'),
      sockets = new Set<net.Socket>()
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
      proxy = tls.createServer({ key: await readFile(key), cert: ca }, (client) => {
        const upstream = net.createConnection({ host: '127.0.0.1', port: 17687 })
        for (const socket of [client, upstream]) {
          sockets.add(socket)
          socket.on('error', () => {
            client.destroy()
            upstream.destroy()
          })
          socket.on('close', () => {
            sockets.delete(socket)
            client.destroy()
            upstream.destroy()
          })
        }
        client.pipe(upstream).pipe(client)
      })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const secure = profileSchema.parse({
      ...profile,
      id: randomUUID(),
      host: 'localhost',
      port: (proxy.address() as net.AddressInfo).port,
      tls: { enabled: true, rejectUnauthorized: true, ca },
    })
    try {
      const status = await service.connect(secure, { password })
      expect(status.state, status.error).toBe('connected')
      expect(await service.databases(secure.id)).toContain('neo4j')
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
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('bounds cancellation of an executing native query rather than only an idle cursor', async () => {
    const timed = profileSchema.parse({ ...profile, id: randomUUID(), queryTimeout: 1000 })
    expect((await service.connect(timed, { password })).state).toBe('connected')
    const started = performance.now()
    await expect(
      service.query({
        connectionId: timed.id,
        sessionId: 'active-deadline',
        requestId: 'expensive',
        database: 'neo4j',
        cypher: 'UNWIND range(1,10000) AS x UNWIND range(1,10000) AS y RETURN sum(x*y)',
        parameters: [],
        mode: 'read',
        pageSize: 25,
      }),
    ).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(4000)
  }, 6000)
  it('expires a cursor at its native and local deadline without replaying it', async () => {
    const timed = profileSchema.parse({ ...profile, id: randomUUID(), queryTimeout: 1000 })
    expect((await service.connect(timed, { password })).state).toBe('connected')
    const page = await service.query({
      connectionId: timed.id,
      sessionId: 'expires',
      requestId: 'initial',
      database: 'neo4j',
      cypher: 'UNWIND range(1,100) AS x RETURN x',
      parameters: [],
      mode: 'read',
      pageSize: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await expect(
      service.next({ connectionId: timed.id, sessionId: 'expires', requestId: 'next', cursor: page.cursor! }),
    ).rejects.toThrow('expired')
    expect(
      (await service.connect({ ...profile, id: randomUUID() }, { password: 'wrong disposable' })).state,
    ).toBe('failed')
  })
})
