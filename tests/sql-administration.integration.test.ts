import pg from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { SqlAdministrationService } from '../src/main/persistence/sql-administration'
import { profileSchema } from '../src/shared/contracts'
import { qualifiedName, quoteIdentifier } from '../src/shared/sql'

const engines = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
]
describe.skipIf(!engines.length)('native reviewed SQL administration', () => {
  for (const engine of engines)
    describe(engine, () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
        table = `admin_${suffix}`,
        role = `admin_reader_${suffix}`,
        readerPassword = randomUUID()
      const schema = engine === 'postgres' ? 'public' : 'harbor',
        port = engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307
      const ssl =
        engine === 'mysql'
          ? {
              rejectUnauthorized: !!process.env.HARBOR_MYSQL_TLS_CA,
              ca: process.env.HARBOR_MYSQL_TLS_CA
                ? readFileSync(process.env.HARBOR_MYSQL_TLS_CA, 'utf8')
                : undefined,
            }
          : undefined
      const profile = profileSchema.parse({
        id: randomUUID(),
        name: 'Local administration fixture',
        engine,
        host: '127.0.0.1',
        port,
        username: engine === 'postgres' ? 'harbor' : 'root',
        database: 'harbor',
        schema,
        readOnly: false,
        queryTimeout: 10000,
        tls: ssl ? { enabled: true, ...ssl } : undefined,
      })
      const password = engine === 'postgres' ? 'harbor_test' : 'harbor_root',
        native = new SqlService(),
        service = new SqlAdministrationService({ profile: () => profile, adapter: () => native })
      const target = { connectionId: profile.id, database: 'harbor', schema, table },
        qualified = qualifiedName(schema, table, engine)
      let admin: pg.Client | Connection
      const query = async (sql: string) => (admin instanceof pg.Client ? admin.query(sql) : admin.query(sql))
      const connect = async () => {
        if (engine === 'postgres') {
          const client = new pg.Client({
            host: '127.0.0.1',
            port,
            user: profile.username,
            password,
            database: 'harbor',
          })
          await client.connect()
          return client
        }
        return mariadb.createConnection({
          host: '127.0.0.1',
          port,
          user: profile.username,
          password,
          database: 'harbor',
          ssl,
        })
      }
      beforeAll(async () => {
        admin = await connect()
        expect(await native.connect(profile, { password })).toMatchObject({ state: 'connected' })
        await query(`CREATE TABLE ${qualified}(id integer NOT NULL PRIMARY KEY,value integer)`)
        await query(
          engine === 'postgres'
            ? `CREATE ROLE ${quoteIdentifier(role, engine)} LOGIN PASSWORD '${readerPassword}'`
            : `CREATE USER '${role}'@'%' IDENTIFIED BY '${readerPassword}'`,
        )
      })
      afterAll(async () => {
        await query(`DROP TABLE IF EXISTS ${qualified}`).catch(() => undefined)
        await query(
          engine === 'postgres'
            ? `DROP ROLE IF EXISTS ${quoteIdentifier(role, engine)}`
            : `DROP USER IF EXISTS '${role}'@'%'`,
        ).catch(() => undefined)
        await native.closeAll()
        await admin?.end()
      })
      it('inspects real catalogs and reports unavailable extensions without installing them', async () => {
        for (const kind of [
          'sessions',
          'health',
          'partitions',
          'routines',
          'permissions',
          'index-usage',
        ] as const) {
          const result = await service.inspect({ ...target, kind, includeQueryText: false })
          expect(result.available, `${kind}: ${result.warnings.join('\n')}`).toBe(true)
          expect(result.sets.every((set) => set.rows.length <= 200)).toBe(true)
        }
        if (engine !== 'postgres')
          expect(
            (await service.inspect({ ...target, kind: 'events', includeQueryText: false })).available,
          ).toBe(true)
        const missing = await service.inspect({ ...target, kind: 'timescale', includeQueryText: false })
        expect(missing.available).toBe(false)
        expect(missing.warnings.join(' ')).toMatch(/not installed|requires PostgreSQL/)
      })
      it('grants and revokes existing-account privileges with exact review and native verification', async () => {
        for (const mode of ['grant', 'revoke'] as const) {
          const preview = await service.preview({
            target,
            action: {
              kind: 'privilege',
              mode,
              principal: role,
              ...(engine === 'postgres' ? {} : { host: '%' }),
              privileges: ['SELECT'],
            },
          })
          expect(preview.blockedReasons, JSON.stringify(preview)).toEqual([])
          await expect(service.execute({ token: preview.token, confirm: 'wrong target' })).rejects.toThrow(
            /exact target/,
          )
          const result = await service.execute({ token: preview.token, confirm: preview.confirmation })
          expect(result.state, JSON.stringify(result)).toBe('committed')
          await expect(
            service.execute({ token: preview.token, confirm: preview.confirmation }),
          ).rejects.toThrow(/expired/)
          const verification = await query(
            engine === 'postgres'
              ? `SELECT has_table_privilege('${role}','${qualified}','SELECT') AS allowed`
              : `SELECT COUNT(*) AS allowed FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE="'${role}'@'%'" AND TABLE_SCHEMA='harbor' AND TABLE_NAME='${table}' AND PRIVILEGE_TYPE='SELECT'`,
          )
          const allowed =
            engine === 'postgres' ? verification.rows[0].allowed : Number(verification[0].allowed) > 0
          expect(allowed).toBe(mode === 'grant')
        }
        const missing = await service.preview({
          target,
          action: {
            kind: 'privilege',
            mode: 'grant',
            principal: `missing_${suffix}`,
            host: '%',
            privileges: ['SELECT'],
          },
        })
        expect(missing.blockedReasons.join(' ')).toMatch(/existing principal/)
        profile.readOnly = true
        expect(
          (
            await service.preview({
              target,
              action: {
                kind: 'privilege',
                mode: 'grant',
                principal: role,
                host: '%',
                privileges: ['SELECT'],
              },
            })
          ).blockedReasons.join(' '),
        ).toMatch(/read-only/)
        profile.readOnly = false
      })
      it('cancels one real running query and preserves the connection, then rejects a stale session review', async () => {
        const worker = await connect()
        try {
          const identity =
            worker instanceof pg.Client
              ? (await worker.query('SELECT pg_backend_pid() AS id')).rows[0].id
              : (await worker.query('SELECT CONNECTION_ID() AS id'))[0].id
          const sleeping = (
            worker instanceof pg.Client ? worker.query('SELECT pg_sleep(8)') : worker.query('SELECT SLEEP(8)')
          ).then(
            () => ({ cancelled: false }),
            () => ({ cancelled: true }),
          )
          await expect
            .poll(async () => {
              const state = await service.inspect({ ...target, kind: 'sessions', includeQueryText: false })
              return state.sessions?.find((session) => session.id === String(identity))?.state
            })
            .toMatch(/active|Query/)
          const preview = await service.preview({
            target,
            action: { kind: 'session', mode: 'cancel', sessionId: String(identity) },
          })
          expect(preview.blockedReasons, JSON.stringify(preview)).toEqual([])
          const result = await service.execute({ token: preview.token, confirm: preview.confirmation })
          expect(result.state, JSON.stringify(result)).toBe('requested')
          const completion = await sleeping
          // MySQL can return SLEEP's interrupted result instead of a driver error; the public connection remains usable.
          if (engine !== 'mysql') expect(completion.cancelled).toBe(true)
          await (worker instanceof pg.Client ? worker.query('SELECT 1') : worker.query('SELECT 1'))
          const termination = await service.preview({
            target,
            action: { kind: 'session', mode: 'terminate', sessionId: String(identity) },
          })
          expect(termination.blockedReasons, JSON.stringify(termination)).toEqual([])
          await worker.end()
          const stale = await service.execute({ token: termination.token, confirm: termination.confirmation })
          expect(stale.state, JSON.stringify(stale)).toBe('not-applied')
        } finally {
          await worker.end().catch(() => undefined)
        }
      }, 20000)
      it('terminates only the reviewed disposable physical session', async () => {
        const worker = await connect()
        worker.on('error', () => undefined)
        try {
          const identity =
            worker instanceof pg.Client
              ? (await worker.query('SELECT pg_backend_pid() AS id')).rows[0].id
              : (await worker.query('SELECT CONNECTION_ID() AS id'))[0].id
          const preview = await service.preview({
            target,
            action: { kind: 'session', mode: 'terminate', sessionId: String(identity) },
          })
          expect(preview.blockedReasons, JSON.stringify(preview)).toEqual([])
          const result = await service.execute({ token: preview.token, confirm: preview.confirmation })
          expect(result.state, JSON.stringify(result)).toBe('requested')
          await expect
            .poll(async () =>
              (
                await service.inspect({ ...target, kind: 'sessions', includeQueryText: false })
              ).sessions?.some((session) => session.id === String(identity)),
            )
            .toBe(false)
        } finally {
          await worker.end().catch(() => undefined)
        }
      })
      it('expires reviews, rejects changed profiles, and does not grant on a stale privilege snapshot', async () => {
        let now = Date.now()
        const timed = new SqlAdministrationService(
          { profile: () => profile, adapter: () => native },
          () => now,
        )
        const request = {
          target,
          action: {
            kind: 'privilege' as const,
            mode: 'grant' as const,
            principal: role,
            host: '%',
            privileges: ['SELECT' as const],
          },
        }
        const expired = await timed.preview(request)
        expect(expired.blockedReasons).toEqual([])
        now += 300001
        await expect(timed.execute({ token: expired.token, confirm: expired.confirmation })).rejects.toThrow(
          /expired/,
        )
        const changed = await service.preview(request)
        const original = profile.name
        profile.name += ' changed'
        try {
          await expect(
            service.execute({ token: changed.token, confirm: changed.confirmation }),
          ).rejects.toThrow(/profile changed/)
        } finally {
          profile.name = original
        }
        const stale = await service.preview(request)
        await query(
          `GRANT INSERT ON ${engine === 'postgres' ? 'TABLE ' : ''}${qualified} TO ${engine === 'postgres' ? quoteIdentifier(role, engine) : `'${role}'@'%'`}`,
        )
        const result = await service.execute({ token: stale.token, confirm: stale.confirmation })
        expect(result.state, JSON.stringify(result)).toBe('not-applied')
        expect(result.warnings.join(' ')).toMatch(/state changed/)
        await query(
          `REVOKE INSERT ON ${engine === 'postgres' ? 'TABLE ' : ''}${qualified} FROM ${engine === 'postgres' ? quoteIdentifier(role, engine) : `'${role}'@'%'`}`,
        )
      })
      it('respects server denial for an unprivileged account without escalating it', async () => {
        const restrictedProfile = profileSchema.parse({
          ...profile,
          id: randomUUID(),
          username: role,
          database: engine === 'postgres' ? 'harbor' : '',
        })
        const restrictedNative = new SqlService()
        const restricted = new SqlAdministrationService({
          profile: () => restrictedProfile,
          adapter: () => restrictedNative,
        })
        try {
          expect(
            await restrictedNative.connect(restrictedProfile, { password: readerPassword }),
          ).toMatchObject({ state: 'connected' })
          const review = await restricted.preview({
            target: { ...target, connectionId: restrictedProfile.id },
            action: { kind: 'privilege', mode: 'grant', principal: role, host: '%', privileges: ['SELECT'] },
          })
          if (engine === 'postgres') {
            expect(review.blockedReasons).toEqual([])
            const result = await restricted.execute({ token: review.token, confirm: review.confirmation })
            expect(result.state, JSON.stringify(result)).toBe('rolled-back')
            expect(result.warnings.join(' ')).toMatch(/permission denied/)
          } else expect(review.blockedReasons.join(' ')).toMatch(/denied/)
          const verification = await query(
            engine === 'postgres'
              ? `SELECT has_table_privilege('${role}','${qualified}','SELECT') AS allowed`
              : `SELECT COUNT(*) AS allowed FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE="'${role}'@'%'" AND TABLE_SCHEMA='harbor' AND TABLE_NAME='${table}' AND PRIVILEGE_TYPE='SELECT'`,
          )
          expect(
            engine === 'postgres' ? verification.rows[0].allowed : Number(verification[0].allowed) > 0,
          ).toBe(false)
        } finally {
          await restrictedNative.closeAll()
        }
      })
      if (engine === 'postgres')
        it('preserves an unknown commit outcome without replaying an acknowledged server grant', async () => {
          let grantsSent = 0
          const uncertain = new SqlAdministrationService({
            profile: () => profile,
            adapter: () => ({
              execute: (input) => {
                if (/^GRANT /.test(input.sql)) grantsSent++
                return native.execute(input)
              },
              transaction: async (input) => {
                const result = await native.transaction(input)
                if (input.action === 'commit')
                  throw new Error('Simulated lost commit acknowledgement after the actual server commit')
                return result
              },
              closeSession: (input) => native.closeSession(input),
            }),
          })
          const review = await uncertain.preview({
            target,
            action: { kind: 'privilege', mode: 'grant', principal: role, privileges: ['SELECT'] },
          })
          expect(review.blockedReasons).toEqual([])
          const result = await uncertain.execute({ token: review.token, confirm: review.confirmation })
          expect(result.state, JSON.stringify(result)).toBe('unknown')
          await expect(
            uncertain.execute({ token: review.token, confirm: review.confirmation }),
          ).rejects.toThrow(/expired/)
          expect(grantsSent).toBe(1)
          try {
            expect(
              (await query(`SELECT has_table_privilege('${role}','${qualified}','SELECT') AS allowed`))
                .rows[0].allowed,
            ).toBe(true)
          } finally {
            await query(`REVOKE SELECT ON TABLE ${qualified} FROM ${quoteIdentifier(role, engine)}`)
          }
        })
    })
})

describe.skipIf(process.env.HARBOR_TIMESCALE !== '1')('native Timescale policy administration', () => {
  const table = `admin_policy_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Disposable policy fixture',
      engine: 'postgres',
      host: '127.0.0.1',
      port: Number(process.env.HARBOR_TIMESCALE_PORT || 15433),
      username: 'harbor',
      database: 'harbor',
      schema: 'public',
      readOnly: false,
    })
  const native = new SqlService(),
    service = new SqlAdministrationService({ profile: () => profile, adapter: () => native })
  const client = new pg.Client({
      host: profile.host,
      port: profile.port,
      user: profile.username,
      password: 'harbor_test',
      database: profile.database,
    }),
    target = { connectionId: profile.id, database: profile.database, schema: 'public', table },
    name = `public."${table}"`
  beforeAll(async () => {
    await client.connect()
    expect(
      (await client.query("SELECT extname FROM pg_extension WHERE extname='timescaledb'")).rowCount,
    ).toBe(1)
    await client.query(`CREATE TABLE ${name}(time timestamptz NOT NULL,value integer)`)
    await client.query('SELECT create_hypertable($1::regclass,$2::name)', [name, 'time'])
    await client.query(
      `ALTER TABLE ${name} SET(timescaledb.compress,timescaledb.compress_orderby='time DESC')`,
    )
    expect(await native.connect(profile, { password: 'harbor_test' })).toMatchObject({ state: 'connected' })
  })
  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS ${name}`).catch(() => undefined)
    await native.closeAll()
    await client.end()
  })
  it('inspects native metadata and adds, pauses, reschedules and removes explicit future policies', async () => {
    const snapshot = await service.inspect({ ...target, kind: 'timescale', includeQueryText: false })
    expect(snapshot.available, snapshot.warnings.join('\n')).toBe(true)
    const future = new Date(Date.now() + 86400000).toISOString()
    for (const policy of ['retention', 'compression'] as const) {
      const preview = await service.preview({
        target,
        action: {
          kind: 'timescale-policy',
          mode: 'add',
          policy,
          ageHours: 48,
          scheduleHours: 24,
          initialStart: future,
        },
      })
      expect(preview.blockedReasons, JSON.stringify(preview)).toEqual([])
      expect((await service.execute({ token: preview.token, confirm: preview.confirmation })).state).toBe(
        'committed',
      )
      const job = (
        await client.query(
          'SELECT job_id FROM timescaledb_information.jobs WHERE hypertable_schema=$1 AND hypertable_name=$2 AND proc_name=$3',
          ['public', table, `policy_${policy}`],
        )
      ).rows[0].job_id
      for (const scheduled of [false, true]) {
        const change = await service.preview({
          target,
          action: {
            kind: 'timescale-job',
            jobId: job,
            scheduled,
            scheduleHours: 48,
            ...(scheduled ? { nextStart: future } : {}),
          },
        })
        expect(change.blockedReasons, JSON.stringify(change)).toEqual([])
        const result = await service.execute({ token: change.token, confirm: change.confirmation })
        expect(result.state, JSON.stringify(result)).toBe('committed')
        expect(
          (await client.query('SELECT scheduled FROM timescaledb_information.jobs WHERE job_id=$1', [job]))
            .rows[0].scheduled,
        ).toBe(scheduled)
      }
      const remove = await service.preview({
        target,
        action: { kind: 'timescale-policy', mode: 'remove', policy },
      })
      expect(remove.blockedReasons, JSON.stringify(remove)).toEqual([])
      const result = await service.execute({ token: remove.token, confirm: remove.confirmation })
      expect(result.state, JSON.stringify(result)).toBe('committed')
      expect(
        (await client.query('SELECT job_id FROM timescaledb_information.jobs WHERE job_id=$1', [job]))
          .rowCount,
      ).toBe(0)
    }
    expect(
      (
        await service.preview({
          target,
          action: {
            kind: 'timescale-policy',
            mode: 'add',
            policy: 'retention',
            ageHours: 48,
            scheduleHours: 24,
            initialStart: new Date().toISOString(),
          },
        })
      ).blockedReasons.join(' '),
    ).toMatch(/future/)
  }, 30000)
})
