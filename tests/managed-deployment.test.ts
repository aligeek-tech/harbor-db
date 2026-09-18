import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import {
  assertManagedSession,
  assertManagedTarget,
  assertManagedIpcTargets,
  managedCatalogTarget,
  defaultManagedDeployment,
  managedDeploymentSchema,
  managedPresetDefaults,
  type ManagedProfile,
} from '../src/shared/managed-deployment'

const now = Date.parse('2026-09-18T12:00:00Z')
function profile(overrides: Partial<ManagedProfile> = {}): ManagedProfile {
  return {
    ...profileSchema.parse({
      id: 'managed-test',
      name: 'Managed test',
      engine: 'postgres',
      host: 'db.example.invalid',
      port: 5432,
      username: 'reader',
      database: 'app',
      tls: { enabled: true, rejectUnauthorized: true },
    }),
    managed: { ...defaultManagedDeployment, provider: 'rds-postgres' },
    ...overrides,
  }
}

describe('managed deployment boundaries', () => {
  it('preserves old profiles and rejects mismatched engine, weak TLS, fallback databases and automatic reconnect', () => {
    expect(() => assertManagedSession({ ...profile(), managed: undefined })).not.toThrow()
    expect(() => assertManagedSession(profile({ engine: 'mysql' }))).toThrow(/requires the postgres/)
    for (const tls of [
      { enabled: false, rejectUnauthorized: true },
      { enabled: true, rejectUnauthorized: false },
    ])
      expect(() => assertManagedSession(profile({ tls: { ...profile().tls, ...tls } }))).toThrow(
        /certificate and hostname/,
      )
    expect(() => assertManagedSession(profile({ database: '' }))).toThrow(/explicit username and database/)
    expect(() => assertManagedSession(profile({ username: '' }))).toThrow(/explicit username and database/)
    expect(() => assertManagedSession(profile(), 'other')).toThrow(/bound to its configured database/)
    expect(() => assertManagedSession(profile({ autoReconnect: true }))).toThrow(/explicit reconnect/)
  })

  it('prevents transaction pooling from masquerading as a persistent tab session', () => {
    const managed = { ...defaultManagedDeployment, provider: 'supabase' as const }
    expect(() => assertManagedSession(profile({ managed: { ...managed, endpoint: 'transaction' } }))).toThrow(
      /Transaction pooling/,
    )
    expect(() =>
      assertManagedSession(
        profile({
          host: 'aws-0-test.pooler.supabase.com',
          port: 6543,
          managed: { ...managed, endpoint: 'session' },
        }),
      ),
    ).toThrow(/transaction pooler/)
    expect(() => assertManagedSession(profile({ host: 'aws-0-test.pooler.supabase.com', managed }))).toThrow(
      /session mode/,
    )
    expect(() =>
      assertManagedSession(
        profile({ host: 'aws-0-test.pooler.supabase.com', managed: { ...managed, endpoint: 'session' } }),
      ),
    ).not.toThrow()
    expect(() =>
      assertManagedSession(
        profile({ host: 'ep-test-pooler.eu.neon.tech', managed: { ...managed, provider: 'neon' } }),
      ),
    ).toThrow(/Neon transaction-pooler/)
    expect(() =>
      assertManagedSession(profile({ managed: { ...managed, provider: 'neon', endpoint: 'session' } })),
    ).toThrow(/Only the Supabase/)
  })

  it('requires explicit unexpired temporary credentials for every new session without treating an identity token as a SQL Server password', () => {
    const managed = {
      ...defaultManagedDeployment,
      provider: 'rds-postgres' as const,
      authentication: 'temporary-password' as const,
      expiresAt: '2026-09-18T12:15:00Z',
    }
    const current = profile({ managed })
    expect(() => assertManagedSession(current, 'app', now)).not.toThrow()
    expect(() => assertManagedSession(current, 'app', now + 15 * 60000)).toThrow(/expired/)
    expect(() => assertManagedSession(current, 'app', now + 15 * 60000 - 30000)).toThrow(/30 seconds/)
    for (const expiresAt of ['', 'invalid', '2026-09-18T12:15:00'])
      expect(() => assertManagedSession(profile({ managed: { ...managed, expiresAt } }), 'app', now)).toThrow(
        /ISO timestamp/,
      )
    expect(() =>
      assertManagedSession(
        profile({ engine: 'mssql', managed: { ...managed, provider: 'azure-sql' } }),
        'app',
        now,
      ),
    ).toThrow(/Identity access tokens/)
  })

  it('keeps presets secret-free and changes only reviewed security defaults', () => {
    const source = profile({
      autoReconnect: true,
      tls: { ...profile().tls, enabled: false, rejectUnauthorized: false },
    })
    const defaults = managedPresetDefaults('neon', source)
    expect(defaults).toMatchObject({
      managed: { provider: 'neon', endpoint: 'direct', authentication: 'password' },
      tls: { enabled: true, rejectUnauthorized: true },
      autoReconnect: false,
    })
    expect(source.tls.enabled).toBe(false)
    expect(source.autoReconnect).toBe(true)
    expect(
      managedDeploymentSchema.safeParse({ ...defaults.managed, password: 'not-permitted' }).success,
    ).toBe(false)
    expect(managedDeploymentSchema.safeParse({ ...defaults.managed, token: 'not-permitted' }).success).toBe(
      false,
    )
  })

  it('rejects forged database/schema context on direct and nested transfer IPC inputs', () => {
    const bound = profileSchema.parse({ ...profile(), managed: profile().managed })
    expect(() => assertManagedTarget(bound, { database: 'app', schema: 'public' })).not.toThrow()
    expect(() => assertManagedTarget(bound, { database: 'other' })).toThrow(/configured database/)
    expect(() => assertManagedTarget(bound, { schema: 'other' })).toThrow(/configured schema/)
    const mysql = {
      ...bound,
      engine: 'mysql' as const,
      managed: { ...bound.managed, provider: 'rds-mysql' as const },
    }
    expect(() => assertManagedTarget(mysql, { schema: 'app' })).not.toThrow()
    expect(() => assertManagedTarget(mysql, { schema: 'public' })).toThrow(/configured schema/)
    for (const input of [
      { connectionId: bound.id, database: 'other' },
      { source: { connectionId: bound.id, database: 'other' } },
      { target: { connectionId: bound.id, schema: 'other' } },
    ])
      expect(() => assertManagedIpcTargets(input, () => bound)).toThrow(/configured/)
    expect(managedCatalogTarget(bound, { connectionId: bound.id })).toEqual({
      connectionId: bound.id,
      database: 'app',
      schema: 'public',
    })
    expect(managedCatalogTarget(mysql, { connectionId: bound.id })).toEqual({
      connectionId: bound.id,
      database: 'app',
      schema: 'app',
    })
    expect(() =>
      assertManagedTarget(
        { ...bound, managed: defaultManagedDeployment },
        { database: 'other', schema: 'other' },
      ),
    ).not.toThrow()
  })
})
