import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import cassandra from 'cassandra-driver'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { cqlConfirmation, cqlExecuteSchema, type CqlExecute, type CqlPage } from '../src/shared/cql'
import { CqlService } from '../src/main/engines/cql'
import { cqlFixtureProxy } from './cql-fixture-proxy'
const enabled = process.env.HARBOR_CASSANDRA_FIXTURE === '1'
const keyspace = 'harbor_' + randomUUID().replaceAll('-', '')
const actor = keyspace + '_actor',
  reader = keyspace + '_reader',
  password = randomUUID()
const service = new CqlService()
const profile = profileSchema.parse({
  id: randomUUID(),
  name: 'Cassandra fixture',
  engine: 'cassandra',
  host: '127.0.0.1',
  port: 19042,
  username: actor,
  readOnly: false,
  queryTimeout: 7000,
})
const target = { connectionId: profile.id, keyspace, table: 'records' }
let control: cassandra.Client | undefined
const params = [
  { type: 'text', value: 'tenant' },
  { type: 'int', value: '1' },
] as const
const input = (extra: Partial<CqlExecute> = {}) =>
  cqlExecuteSchema.parse({
    ...target,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    cql: `SELECT * FROM ${keyspace}.records WHERE tenant = ? AND bucket = ? LIMIT 100`,
    parameters: params,
    ...extra,
  })
const read = (extra: Partial<CqlExecute> = {}) => service.execute(input(extra))
const record = (page: CqlPage, row = 0) =>
  Object.fromEntries(page.columns.map((c, i) => [c.name, JSON.parse(page.rows[row]![i]!)]))
const mutation = (extra: Partial<CqlExecute> = {}) =>
  input({
    mode: 'mutation',
    confirm: cqlConfirmation(profile.id, keyspace, 'records'),
    cql: `UPDATE ${keyspace}.records SET version = ? WHERE tenant = ? AND bucket = ? AND seq = ? IF version = ?`,
    parameters: [
      { type: 'int', value: '2' },
      ...params,
      { type: 'bigint', value: '0' },
      { type: 'int', value: '1' },
    ],
    ...extra,
  })
describe.skipIf(!enabled)('Cassandra native partition and conditional workflows', () => {
  beforeAll(async () => {
    const credentials = JSON.parse(readFileSync(process.env.HARBOR_CASSANDRA_CREDENTIALS!, 'utf8'))
    control = new cassandra.Client({
      contactPoints: ['127.0.0.1:19042'],
      localDataCenter: 'datacenter1',
      authProvider: new cassandra.auth.PlainTextAuthProvider(credentials.username, credentials.password),
      policies: {
        retry: new cassandra.policies.retry.FallthroughRetryPolicy(),
        speculativeExecution: new cassandra.policies.speculativeExecution.NoSpeculativeExecutionPolicy(),
      },
      queryOptions: { isIdempotent: false, consistency: cassandra.types.consistencies.localOne },
    })
    await control.execute(
      `CREATE KEYSPACE ${keyspace} WITH replication = {'class':'SimpleStrategy','replication_factor':1}`,
    )
    await control.execute(`CREATE TYPE ${keyspace}.detail (label text, exact varint)`)
    await control.execute(
      `CREATE TABLE ${keyspace}.records (tenant text, bucket int, seq bigint, version int, exact decimal, large varint, day date, clock time, moment timestamp, identifier uuid, bytes blob, items list<bigint>, tags set<text>, pairs map<text,varint>, pair frozen<tuple<text,bigint>>, detail frozen<detail>, PRIMARY KEY ((tenant,bucket),seq))`,
    )
    for (const user of [actor, reader])
      await control.execute(`CREATE ROLE ${user} WITH PASSWORD = '${password}' AND LOGIN = true`)
    await control.execute(`GRANT SELECT ON KEYSPACE ${keyspace} TO ${actor}`)
    await control.execute(`GRANT MODIFY ON KEYSPACE ${keyspace} TO ${actor}`)
    await control.execute(`GRANT SELECT ON KEYSPACE ${keyspace} TO ${reader}`)
    for (let i = 0; i < 30; i++)
      await control.execute(
        `INSERT INTO ${keyspace}.records (tenant,bucket,seq,version,exact,large,day,clock,moment,identifier,bytes,items,tags,pairs,pair,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'tenant',
          1,
          cassandra.types.Long.fromNumber(i),
          1,
          cassandra.types.BigDecimal.fromString('12345678901234567890.123456789'),
          cassandra.types.Integer.fromString('9007199254740993123456789'),
          cassandra.types.LocalDate.fromString('2026-09-18'),
          cassandra.types.LocalTime.fromString('12:34:56.123456789'),
          new Date('2026-09-18T09:00:00.123Z'),
          cassandra.types.Uuid.fromString('123e4567-e89b-12d3-a456-426614174000'),
          Buffer.from([0, 255, 128]),
          [cassandra.types.Long.fromString('9007199254740993')],
          ['a', 'ب'],
          { x: cassandra.types.Integer.fromString('9007199254740993') },
          new cassandra.types.Tuple('سلام', cassandra.types.Long.fromString('9007199254740993')),
          { label: '🌊', exact: cassandra.types.Integer.fromString('9007199254740993') },
        ],
        { prepare: true },
      )
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toMatch(/Apache Cassandra 5\.0\./)
  }, 60000)
  afterAll(async () => {
    await service.closeAll()
    if (control) {
      await control.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`)
      for (const user of [actor, reader]) await control.execute(`DROP ROLE IF EXISTS ${user}`)
      await control.shutdown()
    }
  }, 20000)
  it('discovers composite partition and clustering metadata without scanning data', async () => {
    expect(await service.keyspaces(profile.id)).toContain(keyspace)
    expect(await service.tables({ connectionId: profile.id, keyspace })).toContain('records')
    expect(await service.structure(target)).toMatchObject({
      partition: ['tenant', 'bucket'],
      clustering: ['seq'],
    })
  })
  it('preserves native exact, temporal, binary and nested values', async () => {
    const request = input({ pageSize: 1 }),
      page = await service.execute(request),
      row = record(page)
    expect(row.exact).toEqual({ type: 'decimal', value: '12345678901234567890.123456789' })
    expect(row.large).toEqual({ type: 'varint', value: '9007199254740993123456789' })
    expect(row.day).toEqual({ type: 'date', value: '2026-09-18' })
    expect(row.clock).toEqual({ type: 'time', value: '12:34:56.123456789' })
    expect(row.moment).toEqual({ type: 'timestamp', value: '2026-09-18T09:00:00.123Z' })
    expect(row.bytes).toEqual({ type: 'blob', base64: 'AP+A' })
    expect(row.items).toEqual([{ type: 'bigint', value: '9007199254740993' }])
    expect(row.pairs).toEqual({
      type: 'map',
      entries: [['x', { type: 'varint', value: '9007199254740993' }]],
    })
    expect(row.pair).toEqual({
      type: 'tuple',
      value: ['سلام', { type: 'bigint', value: '9007199254740993' }],
    })
    expect(row.detail).toEqual({ label: '🌊', exact: { type: 'varint', value: '9007199254740993' } })
    await service.closeSession({ connectionId: profile.id, sessionId: request.sessionId })
  })
  it('rotates partition cursors and rejects cross-session and replay use', async () => {
    const first = input(),
      page = await service.execute(first)
    expect(page.rows).toHaveLength(25)
    expect(page.cursor).toBeTruthy()
    await expect(
      service.next({
        connectionId: profile.id,
        sessionId: randomUUID(),
        requestId: randomUUID(),
        cursor: page.cursor!,
      }),
    ).rejects.toThrow(/belongs/)
    const next = { ...first, cursor: page.cursor! }
    const final = await service.next({
      connectionId: profile.id,
      sessionId: first.sessionId,
      requestId: randomUUID(),
      cursor: next.cursor,
    })
    expect(final.rows).toHaveLength(5)
    expect(final.cursor).toBeUndefined()
    await expect(
      service.next({
        connectionId: profile.id,
        sessionId: first.sessionId,
        requestId: randomUUID(),
        cursor: next.cursor,
      }),
    ).rejects.toThrow(/expired/)
  })
  it('rejects unrestricted partitions and filtering without explicit consent', async () => {
    await expect(
      read({ cql: `SELECT * FROM ${keyspace}.records LIMIT 100`, parameters: [] }),
    ).rejects.toThrow(/partition/)
    await expect(
      read({
        cql: `SELECT * FROM ${keyspace}.records WHERE version = ? LIMIT 10 ALLOW FILTERING`,
        parameters: [{ type: 'int', value: '1' }],
        allowScan: true,
      }),
    ).rejects.toThrow(/filter/i)
  })
  it('acknowledges conditional apply, stale conflict and native persistence', async () => {
    expect(await service.execute(mutation())).toMatchObject({ acknowledged: true, applied: true })
    expect(await service.execute(mutation())).toMatchObject({ acknowledged: true, applied: false })
    const row = (
      await control!.execute(
        `SELECT version FROM ${keyspace}.records WHERE tenant='tenant' AND bucket=1 AND seq=0`,
      )
    ).first()
    expect(row.version).toBe(2)
  })
  it('uses selectable native consistency and returns a single-replica quorum result', async () => {
    const request = input({ consistency: 'localQuorum', pageSize: 100 })
    expect((await service.execute(request)).consistency).toBe('localQuorum')
  })
  it('creates exact typed values conditionally and deletes only with a matching native condition', async () => {
    const request = mutation({
      cql: `INSERT INTO ${keyspace}.records (tenant,bucket,seq,version,exact,large,bytes) VALUES (?,?,?,?,?,?,?) IF NOT EXISTS`,
      parameters: [
        { type: 'text', value: 'write' },
        { type: 'int', value: '1' },
        { type: 'bigint', value: '9007199254740993' },
        { type: 'int', value: '1' },
        { type: 'decimal', value: '12345678901234567890.123456789' },
        { type: 'varint', value: '9007199254740993123456789' },
        { type: 'blob', value: 'AP+A' },
      ],
    })
    expect((await service.execute(request)).applied).toBe(true)
    expect((await service.execute({ ...request, requestId: randomUUID() })).applied).toBe(false)
    const native = (
      await control!.execute(
        `SELECT seq, exact, large, bytes FROM ${keyspace}.records WHERE tenant='write' AND bucket=1`,
      )
    ).first()
    expect(native.seq.toString()).toBe('9007199254740993')
    expect(native.exact.toString()).toBe('12345678901234567890.123456789')
    expect(native.large.toString()).toBe('9007199254740993123456789')
    expect(native.bytes.toString('base64')).toBe('AP+A')
    const deletion = mutation({
      cql: `DELETE FROM ${keyspace}.records WHERE tenant = ? AND bucket = ? AND seq = ? IF version = ?`,
      parameters: [
        { type: 'text', value: 'write' },
        { type: 'int', value: '1' },
        { type: 'bigint', value: '9007199254740993' },
        { type: 'int', value: '2' },
      ],
    })
    expect((await service.execute(deletion)).applied).toBe(false)
    deletion.parameters[3] = { type: 'int', value: '1' }
    expect((await service.execute({ ...deletion, requestId: randomUUID() })).applied).toBe(true)
    expect(
      (await control!.execute(`SELECT seq FROM ${keyspace}.records WHERE tenant='write' AND bucket=1`)).rows,
    ).toHaveLength(0)
  })
  it('rejects wrong credentials and enforces native limited-role write denial', async () => {
    const wrong = { ...profile, id: randomUUID() }
    expect((await service.connect(wrong, { password: randomUUID() })).state).toBe('failed')
    const restricted = { ...profile, id: randomUUID(), username: reader }
    const status = await service.connect(restricted, { password })
    expect(status.state, status.error).toBe('connected')
    expect((await read({ connectionId: restricted.id, pageSize: 100 })).rows).toHaveLength(30)
    await expect(
      service.execute(
        mutation({
          connectionId: restricted.id,
          confirm: cqlConfirmation(restricted.id, keyspace, 'records'),
        }),
      ),
    ).rejects.toThrow(/native code 8448/)
    await service.disconnect(restricted.id)
  })
  it('requires exact mutation confirmation and a writable profile', async () => {
    await expect(service.execute(mutation({ confirm: 'wrong' }))).rejects.toThrow(/confirmation/)
    const restricted = { ...profile, id: randomUUID(), readOnly: true }
    expect((await service.connect(restricted, { password })).state).toBe('connected')
    await expect(
      service.execute(
        mutation({
          connectionId: restricted.id,
          confirm: cqlConfirmation(restricted.id, keyspace, 'records'),
        }),
      ),
    ).rejects.toThrow(/writable/)
    await service.disconnect(restricted.id)
  })
  it('cancels an active native read promptly by closing dedicated local sockets', async () => {
    const proxy = await cqlFixtureProxy(),
      selected = { ...profile, id: randomUUID(), port: proxy.port }
    try {
      expect((await service.connect(selected, { password })).state).toBe('connected')
      proxy.arm('hold', `SELECT * FROM ${keyspace}.records`)
      const request = input({ connectionId: selected.id })
      const running = service.execute(request).then(
        () => 'unexpected success',
        (error) => String(error.message),
      )
      await proxy.wait()
      const start = performance.now()
      expect((await service.cancel(request)).requested).toBe(true)
      expect(await running).toMatch(/cancelled locally/)
      expect(performance.now() - start).toBeLessThan(1500)
      expect(proxy.hits).toBe(1)
    } finally {
      await service.disconnect(selected.id)
      await proxy.close()
    }
  })
  it('reports a lost native mutation acknowledgement as uncertain without retrying', async () => {
    const proxy = await cqlFixtureProxy(),
      selected = { ...profile, id: randomUUID(), port: proxy.port }
    try {
      expect((await service.connect(selected, { password })).state).toBe('connected')
      proxy.arm('drop', `UPDATE ${keyspace}.records`)
      const request = mutation({
        connectionId: selected.id,
        confirm: cqlConfirmation(selected.id, keyspace, 'records'),
        parameters: [
          { type: 'int', value: '3' },
          ...params,
          { type: 'bigint', value: '0' },
          { type: 'int', value: '2' },
        ],
      })
      await expect(service.execute(request)).rejects.toThrow(/outcome is uncertain/)
      expect(proxy.hits).toBe(1)
      const row = (
        await control!.execute(
          `SELECT version FROM ${keyspace}.records WHERE tenant='tenant' AND bucket=1 AND seq=0`,
        )
      ).first()
      expect(row.version).toBe(3)
    } finally {
      await service.disconnect(selected.id)
      await proxy.close()
    }
  })
  it('bounds admission at two active native operations and releases cancelled slots', async () => {
    const proxy = await cqlFixtureProxy(),
      selected = { ...profile, id: randomUUID(), port: proxy.port }
    try {
      expect((await service.connect(selected, { password })).state).toBe('connected')
      proxy.arm('hold', `SELECT * FROM ${keyspace}.records`)
      const a = input({ connectionId: selected.id }),
        b = input({ connectionId: selected.id })
      const one = service.execute(a).catch((error) => String(error.message))
      await proxy.wait()
      proxy.arm('hold', `SELECT * FROM ${keyspace}.records`)
      const two = service.execute(b).catch((error) => String(error.message))
      await proxy.wait()
      await expect(read({ connectionId: selected.id })).rejects.toThrow(/Two CQL requests/)
      await service.cancel(a)
      await service.cancel(b)
      expect(await one).toMatch(/cancelled/)
      expect(await two).toMatch(/cancelled/)
      proxy.forward()
      expect((await read({ connectionId: selected.id, pageSize: 100 })).rows).toHaveLength(30)
    } finally {
      await service.disconnect(selected.id)
      await proxy.close()
    }
  })
  it('verifies the native CQL server through TLS without trusting unknown certificates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-cql-tls-')),
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
        const upstream = net.createConnection({ host: '127.0.0.1', port: 19042 })
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
      expect(await service.keyspaces(secure.id)).toContain(keyspace)
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
})
