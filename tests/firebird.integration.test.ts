import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TransactionImpl } from 'node-firebird-driver-wire/dist/lib/transaction.js'
import { FirebirdService } from '../src/main/engines/firebird'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'

const file = process.env.HARBOR_FIREBIRD_FIXTURE
describe.skipIf(!file)('Firebird 5 native exact values and transaction workflows', () => {
  const service = new FirebirdService(),
    table = 'HARBOR_' + randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  let writer: ConnectionProfile,
    reader: ConnectionProfile,
    password = ''
  async function query(
    sql: string,
    profile = writer,
    maxRows = 100,
    context?: { sessionId: string; requestId?: string },
  ) {
    const sessionId = context?.sessionId || randomUUID()
    try {
      return await service.execute({
        connectionId: profile.id,
        database: profile.database,
        sessionId,
        requestId: context?.requestId || randomUUID(),
        sql,
        maxRows,
        privateSession: true,
        confirm: profile.name,
      })
    } finally {
      if (!context) await service.closeSession({ connectionId: profile.id, sessionId })
    }
  }
  beforeAll(async () => {
    const config = JSON.parse(await readFile(file!, 'utf8'))
    password = config.password
    writer = profileSchema.parse({
      id: 'firebird-writer',
      name: 'Disposable Firebird writer',
      engine: 'firebird',
      host: '127.0.0.1',
      port: config.port,
      username: config.username,
      database: config.database,
      schema: '',
      readOnly: false,
      queryTimeout: 15000,
    })
    reader = profileSchema.parse({
      ...writer,
      id: 'firebird-reader',
      name: 'Disposable Firebird reader',
      readOnly: true,
    })
    const connected = await service.connect(writer, { password })
    expect(connected.state, connected.error).toBe('connected')
    expect((await service.connect(reader, { password })).state).toBe('connected')
    await query(
      `CREATE TABLE ${table} (ID BIGINT PRIMARY KEY, AMOUNT NUMERIC(38,18), SMALL_AMOUNT NUMERIC(18,4), LABEL VARCHAR(100), BYTES VARBINARY(10), STAMP TIMESTAMP, ZONED TIMESTAMP WITH TIME ZONE, NOTE BLOB SUB_TYPE TEXT, PAYLOAD BLOB SUB_TYPE BINARY)`,
    )
    await query(
      `INSERT INTO ${table} VALUES(9223372036854775807, 12345678901234567890.123456789012345678, 12345678901234.5678, '', x'00ff', TIMESTAMP '2026-09-18 12:34:56.1234', TIMESTAMP '2026-09-18 12:34:56.1234 +03:30', 'Unicode 🐦 note', x'00ff')`,
    )
    await query(`INSERT INTO ${table}(ID) VALUES(1)`)
  })
  afterAll(async () => {
    if (writer && service.status(writer.id).state === 'connected')
      await query(`DROP TABLE ${table}`).catch(() => {})
    await service.closeAll()
  })

  it('identifies native version, table catalogs and primary-key metadata', async () => {
    expect(service.status(writer.id).version).toMatch(/Firebird 5\.0/)
    expect(await service.listObjects({ connectionId: reader.id, database: reader.database })).toContainEqual({
      name: table,
      database: reader.database,
      schema: '',
      kind: 'table',
    })
    const metadata = await service.structure({
      connectionId: reader.id,
      database: reader.database,
      schema: '',
      table,
    })
    expect(metadata.columns[0]).toMatchObject({
      name: 'ID',
      type: 'BIGINT',
      primaryKey: true,
      nullable: false,
    })
    expect(metadata.columns[1].type).toBe('NUMERIC(38,18)')
  })
  it('preserves 64/128-bit numerics, scale, four-digit timestamps, timezone, binary, Unicode LOB and null/empty', async () => {
    const result = await query(`SELECT * FROM ${table} ORDER BY ID DESC`, reader)
    const row = result.sets[0].rows[0]
    expect(row.slice(0, 5)).toEqual([
      '9223372036854775807',
      '12345678901234567890.123456789012345678',
      '12345678901234.5678',
      '',
      { type: 'binary', base64: 'AP8=' },
    ])
    expect(row[5]).toBe('2026-09-18 12:34:56.1234')
    expect(row[6]).toMatch(/2026-09-18 12:34:56\.1234.*\+03:30/)
    expect(row[7]).toBe('Unicode 🐦 note')
    expect(row[8]).toEqual({ type: 'binary', base64: 'AP8=' })
    expect(result.sets[0].rows[1]).toEqual(['1', null, null, null, null, null, null, null, null])
  })
  it('preserves duplicate result labels and bounds loaded rows', async () => {
    const result = await query(`SELECT ID AS SAME, ID AS SAME FROM ${table} ORDER BY ID`, reader, 1)
    expect(result.sets[0].columns.map((column) => column.name)).toEqual(['SAME', 'SAME'])
    expect(result.sets[0].rows).toEqual([['1', '1']])
    expect(result.sets[0].truncated).toBe(true)
  })
  it('uses isolated explicit transactions with rollback, commit and failed-state guards', async () => {
    const context = { connectionId: writer.id, sessionId: randomUUID(), database: writer.database }
    try {
      await service.transaction({ ...context, action: 'begin' })
      await query(`INSERT INTO ${table}(ID) VALUES(20)`, writer, 100, context)
      expect((await query(`SELECT COUNT(*) FROM ${table} WHERE ID=20`, reader)).sets[0].rows).toEqual([['0']])
      await service.transaction({ ...context, action: 'rollback' })
      await service.transaction({ ...context, action: 'begin' })
      await query(`INSERT INTO ${table}(ID) VALUES(21)`, writer, 100, context)
      await service.transaction({ ...context, action: 'commit' })
      expect((await query(`SELECT COUNT(*) FROM ${table} WHERE ID=21`, reader)).sets[0].rows).toEqual([['1']])
      await service.transaction({ ...context, action: 'begin' })
      await expect(query(`INSERT INTO ${table}(ID) VALUES(21)`, writer, 100, context)).rejects.toThrow(
        'Firebird rejected',
      )
      await expect(service.transaction({ ...context, action: 'commit' })).rejects.toThrow('failed')
      await service.transaction({ ...context, action: 'rollback' })
    } finally {
      await service.closeSession(context)
      await query(`DELETE FROM ${table} WHERE ID IN(20,21)`)
    }
  })
  it('rejects unreviewed writes, raw transactions, changed attachment targets and unsupported TLS/remote plaintext', async () => {
    await expect(query(`DELETE FROM ${table}`, reader)).rejects.toThrow('read-only')
    await expect(
      service.execute({
        connectionId: writer.id,
        sessionId: 'unreviewed',
        requestId: 'unreviewed',
        sql: `DELETE FROM ${table}`,
        maxRows: 1,
        privateSession: true,
      }),
    ).rejects.toThrow('confirmation')
    await expect(query('COMMIT')).rejects.toThrow('transaction controls')
    await expect(
      service.listObjects({ connectionId: writer.id, database: '/other/file.fdb' }),
    ).rejects.toThrow('physical attachment')
    expect((await service.connect({ ...writer, id: 'remote', host: 'db.example' }, { password })).state).toBe(
      'failed',
    )
    expect(
      (await service.connect({ ...writer, id: 'tls', tls: { ...writer.tls, enabled: true } }, { password }))
        .state,
    ).toBe('failed')
    expect(
      (await service.connect({ ...writer, id: 'invalid-auth' }, { password: 'incorrect-fixture-password' }))
        .state,
    ).toBe('failed')
  })
  it('streams native cursor rows with backpressure and aborts without replay', async () => {
    let count = 0,
      active = 0,
      peak = 0
    await service.streamQuery(
      { connectionId: reader.id, database: reader.database, sql: `SELECT ID FROM ${table} ORDER BY ID` },
      {
        signal: new AbortController().signal,
        onColumns: async () => {},
        onRow: async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          count++
          active--
        },
      },
    )
    expect(count).toBe(2)
    expect(peak).toBe(1)
    const controller = new AbortController()
    await expect(
      service.streamQuery(
        { connectionId: reader.id, sql: `SELECT ID FROM ${table}` },
        {
          signal: controller.signal,
          onColumns: async () => {},
          onRow: async () => {
            controller.abort()
          },
        },
      ),
    ).rejects.toThrow('cancelled')
  })

  it('enforces native user privileges independently of the profile safeguard', async () => {
    const username = 'HU_' + randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(), secret = randomUUID().replaceAll('-', '')
    const restricted = { ...writer, id: 'firebird-restricted', username }
    await query(`CREATE USER ${username} PASSWORD '${secret}'`)
    try {
      await query(`GRANT SELECT ON ${table} TO USER ${username}`)
      expect((await service.connect(restricted, { password: secret })).state).toBe('connected')
      expect((await query(`SELECT COUNT(*) FROM ${table}`, restricted)).sets[0].rows).toEqual([['2']])
      await expect(query(`UPDATE ${table} SET LABEL='denied' WHERE ID=1`, restricted)).rejects.toThrow('Firebird rejected')
      expect((await query(`SELECT LABEL FROM ${table} WHERE ID=1`, reader)).sets[0].rows).toEqual([[null]])
    } finally { await service.disconnect(restricted.id); await query(`DROP USER ${username}`) }
  })

  it('reports uncertainty without replay when a real commit completes before an injected acknowledgement loss', async () => {
    const original = TransactionImpl.prototype.commit
    let committed = 0
    const spy = vi.spyOn(TransactionImpl.prototype, 'commit').mockImplementationOnce(async function (this: TransactionImpl) { await original.call(this); committed++; throw new Error('simulated lost acknowledgement') })
    try {
      await expect(query(`INSERT INTO ${table}(ID) VALUES(39)`)).rejects.toThrow('Commit acknowledgement is unknown')
      expect(committed).toBe(1)
    } finally { spy.mockRestore() }
    expect((await query(`SELECT COUNT(*) FROM ${table} WHERE ID=39`, reader)).sets[0].rows).toEqual([['1']])
    // Explicit reconnection is required after the uncertain write; nothing is replayed.
    expect((await service.connect(writer, { password })).state).toBe('connected')
    await query(`DELETE FROM ${table} WHERE ID=39`)
  })

  it('serializes competing transaction controls on the same tab', async () => {
    const context = { connectionId: writer.id, sessionId: randomUUID(), database: writer.database }
    try {
      const outcomes = await Promise.allSettled([service.transaction({ ...context, action: 'begin' }), service.transaction({ ...context, action: 'begin' })])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
      await service.transaction({ ...context, action: 'rollback' })
    } finally { await service.closeSession(context) }
  })

  it('cancels an actively executing native query while preserving another tab', async () => {
    const context = { sessionId: randomUUID(), requestId: randomUUID() }
    const running = query('SELECT COUNT(*) FROM RDB$TYPES a CROSS JOIN RDB$TYPES b CROSS JOIN RDB$TYPES c CROSS JOIN RDB$TYPES d', reader, 10, context).then(() => '', (error: Error) => error.message)
    await expect.poll(() => service.getSessionState({ connectionId: reader.id, sessionId: context.sessionId }).running).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await service.cancel({ connectionId: reader.id, ...context, requestId: 'wrong' })).requested).toBe(false)
    expect((await service.cancel({ connectionId: reader.id, ...context })).requested).toBe(true)
    expect(await running).toMatch(/cancelled|rejected/)
    await service.closeSession({ connectionId: reader.id, sessionId: context.sessionId })
    expect((await query('SELECT 1 FROM RDB$DATABASE', reader)).sets[0].rows).toEqual([['1']])
  })
})
