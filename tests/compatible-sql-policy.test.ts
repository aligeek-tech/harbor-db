import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import {
  assertCompatibleProfile,
  compatibleQuerySafety,
  verifyCompatibleProduct,
  type CompatibleSqlEngine,
} from '../src/shared/compatible-sql'
import { sqlDialect } from '../src/shared/sql'

describe('distinct compatible SQL products', () => {
  it('requires independent product markers rather than PostgreSQL/MySQL version compatibility', () => {
    const versions: Record<CompatibleSqlEngine, string> = {
      cockroachdb: 'CockroachDB CCL v25.4.0 (aarch64-unknown-linux-gnu)',
      yugabytedb: 'PostgreSQL 15.12-YB-2026.1.1.2-b9 on aarch64',
      tidb: '8.0.11-TiDB-v8.5.5',
      vitess: '8.4.6-Vitess',
      redshift: 'PostgreSQL 8.0.2 on x86_64, Redshift 1.0.12345',
    }
    for (const [engine, version] of Object.entries(versions)) {
      expect(() => verifyCompatibleProduct(engine as CompatibleSqlEngine, version)).not.toThrow()
      expect(() => verifyCompatibleProduct(engine as CompatibleSqlEngine, 'PostgreSQL 17.5')).toThrow(
        /does not identify/,
      )
      expect(() =>
        verifyCompatibleProduct(engine as CompatibleSqlEngine, '8.4.6', 'MySQL Community Server'),
      ).toThrow(/does not identify/)
    }
    expect(() => verifyCompatibleProduct('vitess', '8.4.6', 'Vitess VTGate')).not.toThrow()
  })

  it('blocks product routing/session changes and executable comments, preserving harmless quoted text', () => {
    for (const engine of ['cockroachdb', 'yugabytedb', 'tidb', 'vitess', 'redshift'] as const) {
      expect(() => compatibleQuerySafety(engine, 'SELECT 1; SELECT 2')).toThrow(/one statement/)
      expect(() => compatibleQuerySafety(engine, 'SET search_path=other')).toThrow(
        /explicit transaction controls/,
      )
      expect(() => compatibleQuerySafety(engine, 'BEGIN')).toThrow(/explicit transaction controls/)
      expect(() => compatibleQuerySafety(engine, "SELECT 'BEGIN; DELETE FROM t' AS text")).not.toThrow()
    }
    for (const sql of ['SELECT 1 /*!; DROP TABLE t */', '/*vt+ TARGET=other@replica */ SELECT 1'])
      expect(() => compatibleQuerySafety('vitess', sql)).toThrow(/comments|directives/)
    expect(() => compatibleQuerySafety('redshift', "COPY t FROM 's3://bucket/file'")).toThrow(/read-only/)
    expect(() => compatibleQuerySafety('vitess', 'DELETE FROM t')).toThrow(/read-only/)
    expect(sqlDialect('redshift')).toBe('postgres')
    expect(sqlDialect('tidb')).toBe('mysql')
  })

  it('requires explicit routing and keeps Redshift credential expiry strict, UTC and secret-free', () => {
    const p = profileSchema.parse({
      id: 'scope',
      name: 'Scope',
      engine: 'redshift',
      host: 'warehouse.example.invalid',
      port: 5439,
      username: 'reader',
      database: 'warehouse',
      tls: { enabled: true, rejectUnauthorized: true },
    })
    expect(() => assertCompatibleProfile(p)).not.toThrow()
    expect(() => assertCompatibleProfile({ ...p, readOnly: false })).toThrow(/guarded browsing/)
    expect(() => assertCompatibleProfile({ ...p, database: '' })).toThrow(/explicit database/)
    expect(() => assertCompatibleProfile({ ...p, autoReconnect: true })).toThrow(/Automatic reconnect/)
    expect(() => assertCompatibleProfile({ ...p, managed: { ...p.managed, provider: 'neon' } })).toThrow(
      /matching base engine/,
    )
    expect(() => assertCompatibleProfile({ ...p, tls: { ...p.tls, rejectUnauthorized: false } })).toThrow(
      /TLS/,
    )
    expect(() =>
      assertCompatibleProfile({ ...p, engine: 'vitess', database: 'keyspace/-80@replica' }),
    ).toThrow(/routing directives/)
    const now = Date.parse('2026-09-18T12:00:00Z')
    for (const expiresAt of [
      '',
      'invalid',
      '2026-09-18T12:20:00',
      '2026-09-18T12:20:00+00:00',
      '2026-02-30T12:20:00Z',
      '2026-09-18T12:00:30Z',
    ])
      expect(() =>
        assertCompatibleProfile(
          { ...p, redshift: { ...p.redshift, authentication: 'temporary-password', expiresAt } },
          now,
        ),
      ).toThrow(/UTC ISO/)
    expect(() =>
      assertCompatibleProfile(
        {
          ...p,
          redshift: {
            ...p.redshift,
            authentication: 'temporary-password',
            expiresAt: '2026-09-18T12:20:00Z',
          },
        },
        now,
      ),
    ).not.toThrow()
    expect(
      profileSchema.safeParse({ ...p, redshift: { ...p.redshift, password: 'not-profile-metadata' } })
        .success,
    ).toBe(false)
  })
})
