import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema, type Cell, type QueryResult } from '../src/shared/contracts'
import { quoteIdentifier } from '../src/shared/sql'

const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const databaseA = `harbor_pg_a_${suffix}`
const databaseB = `harbor_pg_b_${suffix}:_metadata`
const secret = { password: 'harbor_test' }
const profile = profileSchema.parse({
  id: `postgres-server-${suffix}`,
  name: 'PostgreSQL server fixture',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 15432,
  username: 'harbor',
  database: '',
  schema: 'public',
  readOnly: false,
})
const service = new SqlService()
let admin: pg.Client | undefined
function execute(sql: string, sessionId: string, database?: string, connectionId = profile.id) {
  return service.execute({
    connectionId,
    database,
    sessionId,
    requestId: randomUUID(),
    sql,
    maxRows: 20,
    privateSession: true,
  })
}
function firstRow(result: QueryResult): Record<string, Cell> {
  return Object.fromEntries(
    result.sets[0].columns.map((column, index) => [column.name, result.sets[0].rows[0][index]]),
  )
}
const tableInput = {
  connectionId: profile.id,
  sessionId: 'table-b',
  schema: 'public',
  table: 'records',
  limit: 25,
  offset: 0,
  direction: 'asc' as const,
}

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')(
  'PostgreSQL server profiles with multiple databases',
  () => {
    beforeAll(async () => {
      admin = new pg.Client({
        host: '127.0.0.1',
        port: 15432,
        user: 'harbor',
        password: secret.password,
        database: 'harbor',
      })
      await admin.connect()
      for (const [database, label] of [
        [databaseA, 'database A'],
        [databaseB, 'database B'],
      ]) {
        await admin.query(`CREATE DATABASE ${quoteIdentifier(database, 'postgres')}`)
        const client = new pg.Client({
          host: '127.0.0.1',
          port: 15432,
          user: 'harbor',
          password: secret.password,
          database,
        })
        try {
          await client.connect()
          await client.query(
            `CREATE TABLE public.records (id integer PRIMARY KEY, label text NOT NULL${database === databaseB ? ', extra integer DEFAULT 7' : ''})`,
          )
          await client.query('INSERT INTO public.records(id,label) VALUES(1,$1)', [label])
        } finally {
          await client.end()
        }
      }
      expect((await service.connect(profile, secret)).state).toBe('connected')
    })
    afterAll(async () => {
      await service.closeAll()
      if (admin) {
        try {
          for (const database of [databaseA, databaseB])
            await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database, 'postgres')}`)
        } finally {
          await admin.end()
        }
      }
    })

    it('bootstraps a blank server profile and discovers each selected database without mutating the profile', async () => {
      expect(profile.database).toBe('')
      const databases = await service.listDatabases(profile.id)
      expect(databases).toContain(databaseA)
      expect(databases).toContain(databaseB)
      await expect(service.listObjects({ connectionId: profile.id })).rejects.toThrow(
        'Choose a PostgreSQL database',
      )
      await expect(execute('SELECT 1', 'unbound')).rejects.toThrow('Choose a PostgreSQL database')
      await expect(
        service.transaction({ connectionId: profile.id, sessionId: 'unbound', action: 'begin' }),
      ).rejects.toThrow('Choose a PostgreSQL database')
      for (const database of [databaseA, databaseB]) {
        const objects = await service.listObjects({ connectionId: profile.id, database })
        expect(objects).toContainEqual(
          expect.objectContaining({ name: 'records', schema: 'public', database, kind: 'table' }),
        )
        expect(objects.every((object) => object.database === database)).toBe(true)
      }
      const a = await service.structure({
        connectionId: profile.id,
        database: databaseA,
        schema: 'public',
        table: 'records',
      })
      const b = await service.structure({
        connectionId: profile.id,
        database: databaseB,
        schema: 'public',
        table: 'records',
      })
      expect(a.columns.map((column) => column.name)).toEqual(['id', 'label'])
      expect(b.columns.map((column) => column.name)).toEqual(['id', 'label', 'extra'])
    })

    it('binds each tab once, including concurrent creation, and reuses that target when omitted', async () => {
      expect(
        (await execute('SELECT current_database(),label FROM records', 'query-a', databaseA)).sets[0].rows,
      ).toEqual([[databaseA, 'database A']])
      expect(
        (await execute('SELECT current_database(),label FROM records', 'query-b', databaseB)).sets[0].rows,
      ).toEqual([[databaseB, 'database B']])
      expect((await execute('SELECT current_database()', 'query-a')).sets[0].rows).toEqual([[databaseA]])
      await expect(execute('SELECT current_database()', 'query-a', databaseB)).rejects.toThrow(
        'already bound',
      )
      await expect(
        service.transaction({
          connectionId: profile.id,
          sessionId: 'query-a',
          database: databaseB,
          action: 'begin',
        }),
      ).rejects.toThrow('already bound')
      const first = execute('SELECT current_database()', 'creating-tab', databaseA)
      const second = execute('SELECT current_database()', 'creating-tab', databaseB)
      await expect(second).rejects.toThrow('already bound')
      expect((await first).sets[0].rows).toEqual([[databaseA]])
    })

    it('routes table metadata, generated SQL and edits to the bound database only', async () => {
      const page = await service.table({ ...tableInput, database: databaseB })
      expect(firstRow(page)).toEqual({ id: '1', label: 'database B', extra: '7' })
      expect(
        await service.applyEdits({
          connectionId: profile.id,
          sessionId: tableInput.sessionId,
          schema: 'public',
          table: 'records',
          changes: [{ kind: 'update', original: firstRow(page), values: { label: 'edited B' } }],
        }),
      ).toEqual({ affectedRows: 1 })
      expect(firstRow(await service.table(tableInput)).label).toBe('edited B')
      expect((await execute(page.tableQuery!.editorSql, tableInput.sessionId)).sets[0].rows[0][1]).toBe(
        'edited B',
      )
      await expect(service.table({ ...tableInput, database: databaseA })).rejects.toThrow('already bound')
      await expect(
        service.applyEdits({
          connectionId: profile.id,
          sessionId: tableInput.sessionId,
          database: databaseA,
          schema: 'public',
          table: 'records',
          changes: [{ kind: 'delete', original: firstRow(page), values: {} }],
        }),
      ).rejects.toThrow('already bound')
      expect((await execute('SELECT label FROM records', 'query-a')).sets[0].rows).toEqual([['database A']])
    })

    it('keeps transaction commit, rollback, state and close bound when the database is omitted', async () => {
      await service.transaction({
        connectionId: profile.id,
        sessionId: 'tx-b',
        database: databaseB,
        action: 'begin',
      })
      await execute("UPDATE records SET label='pending B' WHERE id=1", 'tx-b')
      expect(service.getSessionState({ connectionId: profile.id, sessionId: 'tx-b' }).state).toBe('open')
      expect((await execute('SELECT label FROM records', 'query-b')).sets[0].rows).toEqual([['edited B']])
      await service.transaction({ connectionId: profile.id, sessionId: 'tx-b', action: 'rollback' })
      await service.transaction({ connectionId: profile.id, sessionId: 'tx-b', action: 'begin' })
      await execute("UPDATE records SET label='committed B' WHERE id=1", 'tx-b')
      await service.transaction({ connectionId: profile.id, sessionId: 'tx-b', action: 'commit' })
      expect((await execute('SELECT label FROM records', 'query-b')).sets[0].rows).toEqual([['committed B']])
      await service.transaction({ connectionId: profile.id, sessionId: 'tx-b', action: 'begin' })
      await execute("UPDATE records SET label='closed pending B' WHERE id=1", 'tx-b')
      await service.closeSession({ connectionId: profile.id, sessionId: 'tx-b' })
      expect((await execute('SELECT label FROM records', 'query-b')).sets[0].rows).toEqual([['committed B']])
      expect((await execute('SELECT current_database(),label FROM records', 'query-a')).sets[0].rows).toEqual(
        [[databaseA, 'database A']],
      )
    })

    it('cancels a selected database query without touching another tab', async () => {
      await execute('SELECT 1', 'slow-b', databaseB)
      const requestId = randomUUID()
      const running = service.execute({
        connectionId: profile.id,
        sessionId: 'slow-b',
        requestId,
        sql: 'SELECT pg_sleep(10)',
        maxRows: 10,
        privateSession: true,
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(
        (await service.cancel({ connectionId: profile.id, sessionId: 'slow-b', requestId })).requested,
      ).toBe(true)
      expect((await running).cancelled).toBe(true)
      expect((await execute('SELECT current_database()', 'slow-b')).sets[0].rows).toEqual([[databaseB]])
      expect((await execute('SELECT current_database()', 'query-a')).sets[0].rows).toEqual([[databaseA]])
    })

    it('keeps configured database profiles fixed and never falls back for an explicit missing database', async () => {
      const fixed = { ...profile, id: `${profile.id}-fixed`, database: databaseA }
      expect((await service.connect(fixed, secret)).state).toBe('connected')
      expect((await execute('SELECT current_database()', 'fixed', undefined, fixed.id)).sets[0].rows).toEqual(
        [[databaseA]],
      )
      await expect(execute('SELECT 1', 'other', databaseB, fixed.id)).rejects.toThrow(
        'configured for a different',
      )
      await expect(service.listObjects({ connectionId: fixed.id, database: databaseB })).rejects.toThrow(
        'configured for a different',
      )
      expect(
        (
          await service.connect(
            { ...fixed, id: `${profile.id}-missing`, database: `${databaseA}_missing` },
            secret,
          )
        ).state,
      ).toBe('failed')
      await service.disconnect(fixed.id)
    })

    it('protects metadata session identifiers across all public session operations', async () => {
      const sessionId = `_metadata:${databaseB}`
      await expect(execute('SELECT 1', sessionId, databaseB)).rejects.toThrow('reserved')
      await expect(
        service.transaction({ connectionId: profile.id, sessionId, database: databaseB, action: 'begin' }),
      ).rejects.toThrow('reserved')
      await expect(service.closeSession({ connectionId: profile.id, sessionId })).rejects.toThrow('reserved')
      await expect(
        service.cancel({ connectionId: profile.id, sessionId, requestId: 'none' }),
      ).rejects.toThrow('reserved')
      expect(() => service.getSessionState({ connectionId: profile.id, sessionId })).toThrow('reserved')
      expect(await service.listObjects({ connectionId: profile.id, database: databaseB })).toContainEqual(
        expect.objectContaining({ name: 'records', database: databaseB }),
      )
    })

    it.each([
      {
        name: 'missing maintenance database',
        code: '3D000',
        message: 'database does not exist',
        failUsername: false,
        expected: ['postgres', 'harbor'],
        connected: true,
      },
      {
        name: 'denied CONNECT privilege',
        code: '42501',
        message: 'permission denied for database "postgres"',
        failUsername: false,
        expected: ['postgres', 'harbor'],
        connected: true,
      },
      {
        name: 'missing maintenance and username databases',
        code: '3D000',
        message: 'database does not exist',
        failUsername: true,
        expected: ['postgres', 'harbor', 'template1'],
        connected: true,
      },
      {
        name: 'authentication error',
        code: '28P01',
        message: 'password authentication failed',
        failUsername: false,
        expected: ['postgres'],
        connected: false,
      },
      {
        name: 'unrelated permission error',
        code: '42501',
        message: 'permission denied to set parameter',
        failUsername: false,
        expected: ['postgres'],
        connected: false,
      },
    ])(
      'limits bootstrap fallback for $name',
      async ({ code, message, failUsername, expected, connected }) => {
        const originalConnect = pg.Client.prototype.connect
        const attempts: string[] = []
        // Inject only the otherwise hard-to-provision startup failures; successful
        // fallback candidates still connect to the real local PostgreSQL server.
        const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (
          this: pg.Client,
        ) {
          const database = this.database || ''
          attempts.push(database)
          if (database === 'postgres' || (failUsername && database === 'harbor'))
            return Promise.reject(Object.assign(new Error(message), { code }))
          return Reflect.apply(originalConnect, this, []) as Promise<pg.Client>
        })
        const fallback = { ...profile, id: `${profile.id}-fallback-${randomUUID().slice(0, 8)}` }
        try {
          const result = await service.connect(fallback, secret)
          expect(result.state).toBe(connected ? 'connected' : 'failed')
          expect(attempts).toEqual(expected)
          if (connected) expect(await service.listDatabases(fallback.id)).toContain(databaseA)
          expect(fallback.database).toBe('')
        } finally {
          connect.mockRestore()
          await service.disconnect(fallback.id)
        }
      },
    )

    it('disconnects every database metadata/tab session and rolls back pending work', async () => {
      await service.transaction({
        connectionId: profile.id,
        sessionId: 'disconnect-a',
        database: databaseA,
        action: 'begin',
      })
      await execute("UPDATE records SET label='must roll back' WHERE id=1", 'disconnect-a')
      await service.disconnect(profile.id)
      expect(service.status(profile.id).state).toBe('disconnected')
      expect(service.getSessionState({ connectionId: profile.id, sessionId: 'query-a' }).connected).toBe(
        false,
      )
      await expect(execute('SELECT 1', 'query-a')).rejects.toThrow('disconnected')
      const sessions = await admin!.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND application_name='Harbor DB'",
        [[databaseA, databaseB]],
      )
      expect(sessions.rows[0].count).toBe(0)
      const reader = new pg.Client({
        host: '127.0.0.1',
        port: 15432,
        user: 'harbor',
        password: secret.password,
        database: databaseA,
      })
      try {
        await reader.connect()
        expect((await reader.query('SELECT label FROM records')).rows[0].label).toBe('database A')
      } finally {
        await reader.end()
      }
    })
  },
)
