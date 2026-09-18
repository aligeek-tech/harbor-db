import { randomUUID } from 'node:crypto'
import net from 'node:net'
import pg from 'pg'
import mariadb, { type Connection as MariaConnection } from 'mariadb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompatibleSqlService } from '../src/main/engines/compatible-sql'
import { profileSchema, type QueryInput } from '../src/shared/contracts'
import { isCompatibleSqlEngine, type CompatibleSqlEngine } from '../src/shared/compatible-sql'

const requested = process.env.HARBOR_COMPATIBLE ?? ''
const enabled = isCompatibleSqlEngine(requested) && requested !== 'redshift'
const engine: CompatibleSqlEngine = enabled ? (requested as CompatibleSqlEngine) : 'cockroachdb'
const mysql = engine === 'tidb' || engine === 'vitess'
const port = { cockroachdb: 26258, yugabytedb: 15435, tidb: 14000, vitess: 15306, redshift: 5439 }[engine]
const database = {
  cockroachdb: 'defaultdb',
  yugabytedb: 'yugabyte',
  tidb: 'test',
  vitess: 'harbor',
  redshift: 'not-configured',
}[engine]
const username = engine === 'yugabytedb' ? 'yugabyte' : 'root'
const profile = profileSchema.parse({
  id: `${engine}-integration`,
  name: 'Disposable compatible target',
  engine,
  host: '127.0.0.1',
  port,
  database,
  username,
  readOnly: engine === 'vitess',
  queryTimeout: 10000,
})
const service = new CompatibleSqlService()
const table = `compat_${randomUUID().replaceAll('-', '').slice(0, 16)}`
const schema = mysql ? database : 'public'
const target = mysql ? `\`${database}\`.\`${table}\`` : `"public"."${table}"`
let nativePg: pg.Client | undefined
let nativeMysql: MariaConnection | undefined
let created = false
const fixture = async (sql: string) => (nativePg ? nativePg.query(sql) : nativeMysql!.query(sql))
const query = (sql: string, options: Partial<QueryInput> = {}) =>
  service.execute({
    connectionId: profile.id,
    database,
    sessionId: 'query',
    requestId: randomUUID(),
    sql,
    maxRows: 1000,
    privateSession: true,
    confirm: profile.name,
    ...options,
  })

describe.skipIf(!enabled)(`real ${engine} independent product adapter`, () => {
  beforeAll(async () => {
    if (mysql)
      nativeMysql = await mariadb.createConnection({
        host: '127.0.0.1',
        port,
        database,
        user: username,
        bigIntAsNumber: false,
        decimalAsNumber: false,
      })
    else {
      nativePg = new pg.Client({ host: '127.0.0.1', port, database, user: username })
      await nativePg.connect()
    }
    await fixture(
      `CREATE TABLE ${target} (id BIGINT PRIMARY KEY,amount DECIMAL(38,9),payload ${mysql ? 'VARBINARY(64)' : 'BYTEA'},label ${mysql ? 'VARCHAR(255)' : 'TEXT'},optional TEXT)`,
    )
    created = true
    await fixture(
      `INSERT INTO ${target} VALUES (9223372036854775807,12345678901234567890123456789.123456789,${mysql ? "X'0001feff'" : "decode('0001feff','hex')"},'سلام 🌊',NULL)`,
    )
    expect(await service.connect(profile)).toMatchObject({ state: 'connected' })
  })
  afterAll(async () => {
    await service.closeAll()
    try {
      if (created) await fixture(`DROP TABLE IF EXISTS ${target}`)
    } finally {
      await nativePg?.end()
      await nativeMysql?.end()
    }
  })

  it('verifies a distinct server product and catalog with exact values and duplicate output names', async () => {
    expect(service.status(profile.id).version).toMatch(
      engine === 'cockroachdb'
        ? /CockroachDB/i
        : engine === 'yugabytedb'
          ? /YB-|Yugabyte/i
          : engine === 'tidb'
            ? /TiDB/i
            : /Vitess|8\.4/i,
    )
    expect(await service.listDatabases(profile.id)).toEqual([database])
    expect(await service.listObjects({ connectionId: profile.id, database, schema })).toContainEqual({
      name: table,
      schema,
      database,
      kind: 'table',
    })
    const structure = await service.structure({ connectionId: profile.id, database, schema, table })
    expect(structure.columns.map((column) => column.name)).toEqual([
      'id',
      'amount',
      'payload',
      'label',
      'optional',
    ])
    expect(structure.ddl).toContain('not inspected, not absent')
    const result = await query(
      `SELECT id AS duplicate,amount AS duplicate,payload,label,optional FROM ${target}`,
    )
    expect(result.sets[0].columns.map((column) => column.name)).toEqual([
      'duplicate',
      'duplicate',
      'payload',
      'label',
      'optional',
    ])
    expect(result.sets[0].rows).toEqual([
      [
        '9223372036854775807',
        '12345678901234567890123456789.123456789',
        { type: 'binary', base64: 'AAH+/w==' },
        'سلام 🌊',
        null,
      ],
    ])
    await expect(query('SELECT 1', { database: 'different' })).rejects.toThrow(/bound to another/)
    const browsed = await service.table({
      connectionId: profile.id,
      database,
      sessionId: 'table',
      schema,
      table,
      limit: 20,
      offset: 0,
      direction: 'asc',
      filters: { match: 'all', conditions: [{ column: 'label', operator: 'equals', value: 'سلام 🌊' }] },
    })
    expect(browsed.sets[0].rows).toHaveLength(1)
    expect(browsed.tableQuery?.parameters).toContain('سلام 🌊')
  })

  it('binds exact parameters and redacts private error values', async () => {
    const result = await query(
      `SELECT CAST(${mysql ? '?' : '$1'} AS ${mysql ? 'DECIMAL(38,9)' : 'NUMERIC(38,9)'}) AS amount`,
      {
        parameters: [
          {
            name: 'amount',
            type: 'decimal',
            secret: false,
            value: '12345678901234567890123456789.123456789',
          },
        ],
      },
    )
    expect(result.sets[0].rows).toEqual([['12345678901234567890123456789.123456789']])
    await expect(
      query(`SELECT harbor_missing_private_function(${mysql ? '?' : '$1'})`, {
        parameters: [{ name: 'private', type: 'text', secret: true, value: 'never-print-private-value' }],
      }),
    ).rejects.toThrow('Query failed while using a private parameter.')
    expect((await query('SELECT 42 AS answer')).sets[0].rows[0][0]).toBe('42')
  })

  it('preserves native temporal microseconds and JSON integer tokens', async () => {
    const temporal = await query(
      mysql
        ? "SELECT CAST('2026-09-18 12:34:56.123456' AS DATETIME(6)) AS precise"
        : "SELECT '2026-09-18 12:34:56.123456+00'::TIMESTAMPTZ AS precise",
    )
    expect(String(temporal.sets[0].rows[0][0])).toContain('2026-09-18 12:34:56.123456')
    const json = await query(
      mysql
        ? 'SELECT CAST(\'{"exact":9007199254740993}\' AS JSON) AS doc'
        : 'SELECT \'{"exact":9007199254740993}\'::JSONB AS doc',
    )
    expect(String(json.sets[0].rows[0][0])).toContain('9007199254740993')
  })

  it.skipIf(engine !== 'tidb')(
    'shows the actual TiDB implicit DDL commit without promising transactional rollback',
    async () => {
      const ddlTable = `\`${database}\`.\`${table}_ddl\``
      const sessionId = 'ddl-boundary'
      try {
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'begin' })
        await query(`INSERT INTO ${target}(id,label) VALUES(7000,'committed-before-ddl')`, { sessionId })
        await query(`CREATE TABLE ${ddlTable}(id INT)`, { sessionId })
        expect(service.getSessionState({ connectionId: profile.id, sessionId }).state).toBe('idle')
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'rollback' })
        expect((await query(`SELECT label FROM ${target} WHERE id=7000`)).sets[0].rows).toEqual([
          ['committed-before-ddl'],
        ])
      } finally {
        await fixture(`DROP TABLE IF EXISTS ${ddlTable}`)
        await fixture(`DELETE FROM ${target} WHERE id=7000`)
      }
    },
  )

  it('bounds displayed rows while streaming an explicit rerun with backpressure, cancellation and sink-failure cleanup', async () => {
    await fixture(
      `INSERT INTO ${target}(id,label) VALUES ${Array.from({ length: 1200 }, (_, index) => `(${index},'row_${index}')`).join(',')}`,
    )
    const statement = `SELECT id,label FROM ${target} ORDER BY id`
    const limited = await query(statement, { maxRows: 7 })
    expect(limited.sets[0]).toMatchObject({ truncated: true })
    expect(limited.sets[0].rows).toHaveLength(7)
    let rows = 0,
      active = 0,
      maxActive = 0,
      announced = 0
    await service.streamQuery(
      { connectionId: profile.id, database, sql: statement },
      {
        signal: new AbortController().signal,
        onColumns: async (columns) => {
          announced++
          expect(columns).toHaveLength(2)
        },
        onRow: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          rows++
          if (rows % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
          active--
        },
      },
    )
    expect({ rows, maxActive, announced }).toEqual({ rows: 1201, maxActive: 1, announced: 1 })
    const controller = new AbortController()
    let cancelledRows = 0
    await expect(
      service.streamQuery(
        { connectionId: profile.id, database, sql: statement },
        {
          signal: controller.signal,
          onColumns: async () => {},
          onRow: async () => {
            if (++cancelledRows === 3) controller.abort()
          },
        },
      ),
    ).rejects.toThrow(/cancelled|ended/i)
    expect(cancelledRows).toBe(3)
    await expect(
      service.streamQuery(
        { connectionId: profile.id, database, sql: statement },
        {
          signal: new AbortController().signal,
          onColumns: async () => {},
          onRow: async () => {
            throw new Error('Synthetic output sink failure')
          },
        },
      ),
    ).rejects.toThrow(/sink failure/)
    expect((await query('SELECT 1')).sets[0].rows).toHaveLength(1)
  })

  it.skipIf(engine === 'vitess')(
    'uses real per-tab transactions, rejects failed commits, and never replays a batch',
    async () => {
      const sessionId = 'transaction'
      expect(
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'begin' }),
      ).toEqual({ state: 'open' })
      await query(`INSERT INTO ${target}(id,label) VALUES (5000,'rolled-back')`, { sessionId })
      expect(
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'rollback' }),
      ).toEqual({ state: 'idle' })
      expect((await query(`SELECT id FROM ${target} WHERE id=5000`)).sets[0].rows).toEqual([])
      await service.transaction({ connectionId: profile.id, database, sessionId, action: 'begin' })
      await query(`INSERT INTO ${target}(id,label) VALUES (5001,'committed-once')`, { sessionId })
      await service.transaction({ connectionId: profile.id, database, sessionId, action: 'commit' })
      expect((await query(`SELECT id FROM ${target} WHERE id=5001`)).sets[0].rows).toEqual([['5001']])
      if (!mysql) {
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'begin' })
        await expect(query(`INSERT INTO ${target}(id) VALUES (5001)`, { sessionId })).rejects.toThrow()
        expect(service.getSessionState({ connectionId: profile.id, sessionId }).state).toBe('failed')
        await expect(
          service.transaction({ connectionId: profile.id, database, sessionId, action: 'commit' }),
        ).rejects.toThrow(/failed/)
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'rollback' })
      }
    },
  )

  it('rejects session mutation/scripts and guarded writes without changing fixture contents', async () => {
    for (const sql of ['SELECT 1; SELECT 2', 'SET autocommit=0', 'BEGIN'])
      await expect(query(sql)).rejects.toThrow()
    const guarded = { ...profile, id: `${profile.id}-guarded`, readOnly: true }
    expect(await service.connect(guarded)).toMatchObject({ state: 'connected' })
    await expect(query(`DELETE FROM ${target}`, { connectionId: guarded.id })).rejects.toThrow(/read-only/)
    expect((await query(`SELECT id FROM ${target} WHERE id=9223372036854775807`)).sets[0].rows).toHaveLength(
      1,
    )
    await service.disconnect(guarded.id)
  })

  it.skipIf(engine !== 'cockroachdb')(
    'surfaces a real serializable conflict without restarting the transaction',
    async () => {
      const a = 'serial-a',
        b = 'serial-b'
      for (const sessionId of [a, b]) {
        await service.transaction({ connectionId: profile.id, database, sessionId, action: 'begin' })
        await query(`SELECT label FROM ${target} WHERE id=5001`, { sessionId })
      }
      await query(`UPDATE ${target} SET label='first-transaction' WHERE id=5001`, { sessionId: a })
      await service.transaction({ connectionId: profile.id, database, sessionId: a, action: 'commit' })
      await expect(
        query(`UPDATE ${target} SET label='must-not-replay' WHERE id=5001`, { sessionId: b }),
      ).rejects.toThrow(/restart|retry|serializ/i)
      expect(service.getSessionState({ connectionId: profile.id, sessionId: b }).state).toBe('failed')
      await service.transaction({ connectionId: profile.id, database, sessionId: b, action: 'rollback' })
      expect((await query(`SELECT label FROM ${target} WHERE id=5001`)).sets[0].rows).toEqual([
        ['first-transaction'],
      ])
    },
  )

  it.skipIf(engine === 'vitess')(
    'reports a lost real COMMIT acknowledgement without reconnecting or replaying the write',
    async () => {
      const sockets = new Set<net.Socket>()
      let commits = 0,
        cut = false
      const proxy = net.createServer((client) => {
        const upstream = net.connect(port, '127.0.0.1')
        sockets.add(client)
        sockets.add(upstream)
        client.on('error', () => {})
        upstream.on('error', () => client.destroy())
        client.on('close', () => {
          sockets.delete(client)
          upstream.destroy()
        })
        upstream.on('close', () => {
          sockets.delete(upstream)
          client.destroy()
        })
        let commit = false
        client.on('data', (chunk) => {
          if (chunk.includes(Buffer.from('COMMIT'))) {
            commit = true
            commits++
          }
          upstream.write(chunk)
        })
        upstream.on('data', (chunk) => {
          if (commit && !cut) {
            cut = true
            client.destroy()
            upstream.destroy()
          } else client.write(chunk)
        })
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      const proxied = {
        ...profile,
        id: `${profile.id}-lost-ack`,
        port: (proxy.address() as net.AddressInfo).port,
      }
      try {
        expect(await service.connect(proxied)).toMatchObject({ state: 'connected' })
        await service.transaction({
          connectionId: proxied.id,
          database,
          sessionId: 'lost-ack',
          action: 'begin',
        })
        await query(`INSERT INTO ${target}(id,label) VALUES (6000,'uncertain-commit')`, {
          connectionId: proxied.id,
          sessionId: 'lost-ack',
        })
        await expect(
          service.transaction({
            connectionId: proxied.id,
            database,
            sessionId: 'lost-ack',
            action: 'commit',
          }),
        ).rejects.toThrow(/may have reached|Inspect the outcome/)
        expect({ cut, commits }).toEqual({ cut: true, commits: 1 })
        expect((await query(`SELECT id FROM ${target} WHERE id=6000`)).sets[0].rows).toEqual([['6000']])
        await expect(query('SELECT 1', { connectionId: proxied.id, sessionId: 'lost-ack' })).rejects.toThrow(
          /session ended/,
        )
      } finally {
        await service.disconnect(proxied.id)
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
      }
    },
  )

  it('closes cancelled and timed-out physical sessions and requires an explicit new connection', async () => {
    const requestId = randomUUID(),
      sessionId = 'cancel'
    const pending = query(mysql ? 'SELECT SLEEP(5)' : 'SELECT pg_sleep(5)', { requestId, sessionId })
    const assertion = expect(pending).rejects.toThrow(/closed|ended|cancel/i)
    const deadline = Date.now() + 10000
    while (!service.getSessionState({ connectionId: profile.id, sessionId }).running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await service.cancel({ connectionId: profile.id, sessionId, requestId })).toMatchObject({
      requested: true,
    })
    await assertion
    await expect(query('SELECT 1', { sessionId })).rejects.toThrow(/session ended/)
    const timed = { ...profile, id: `${profile.id}-timeout`, queryTimeout: 1000 }
    expect(await service.connect(timed)).toMatchObject({ state: 'connected' })
    await expect(
      query(mysql ? 'SELECT SLEEP(5)' : 'SELECT pg_sleep(5)', {
        connectionId: timed.id,
        sessionId: 'timeout',
      }),
    ).rejects.toThrow(/time|deadline|cancel/i)
    await service.disconnect(timed.id)
  })

  it.skipIf(engine !== 'tidb')(
    'enforces native password authentication and server SELECT-only grants independently of the SQL guard',
    async () => {
      const user = `compat_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const password = `fixture_${randomUUID().replaceAll('-', '')}`
      const account = `'${user}'@'%'`
      const p = { ...profile, id: 'tidb-native-reader', username: user, readOnly: false }
      await fixture(`CREATE USER ${account} IDENTIFIED BY '${password}'`)
      try {
        await fixture(`GRANT SELECT ON ${target} TO ${account}`)
        const denied = await service.connect(p, { password: `${password}_wrong` })
        expect(denied.state).toBe('failed')
        expect(denied.error).not.toContain(password)
        const connected = await service.connect(p, { password })
        expect(connected.state, connected.error).toBe('connected')
        expect(
          (await query(`SELECT id FROM ${target} WHERE id=9223372036854775807`, { connectionId: p.id }))
            .sets[0].rows,
        ).toEqual([['9223372036854775807']])
        await expect(
          query(`INSERT INTO ${target}(id,label) VALUES(7100,'must-not-write')`, { connectionId: p.id }),
        ).rejects.toThrow(/denied|privilege/i)
        expect((await query(`SELECT id FROM ${target} WHERE id=7100`)).sets[0].rows).toEqual([])
      } finally {
        await service.disconnect(p.id)
        await fixture(`DROP USER ${account}`)
      }
    },
  )
})
