import { describe, expect, it } from 'vitest'
import { parseConnectionUrl } from '../src/shared/connection-uri'
import { connectionDiagnostic, redactConnectionMessage } from '../src/shared/connection-guidance'
import { duplicateProfile, recentConnectionIds } from '../src/shared/connection-hub'
import { profileSchema, type HistoryEntry } from '../src/shared/contracts'

describe('connection URL review', () => {
  it('preserves encoded credentials and IPv6, with verified TLS', () => {
    const result = parseConnectionUrl(
      'postgresql://u%40ser:p%40ss%2Fword@[::1]:5433/test%20db?sslmode=require',
    )
    expect(result.password).toBe('p@ss/word')
    expect(result.profile).toMatchObject({
      engine: 'postgres',
      username: 'u@ser',
      host: '::1',
      port: 5433,
      database: 'test db',
      tls: { enabled: true, rejectUnauthorized: true },
    })
  })
  it('keeps MySQL and MariaDB distinct and honors explicit TLS', () => {
    expect(parseConnectionUrl('mysql://localhost/db?ssl=true').profile).toMatchObject({
      engine: 'mysql',
      tls: { enabled: true },
    })
    expect(parseConnectionUrl('mariadb://localhost/db').profile.engine).toBe('mariadb')
    expect(parseConnectionUrl('rediss://localhost/4').profile).toMatchObject({
      engine: 'redis',
      redisDb: 4,
      tls: { enabled: true },
    })
  })
  it('retains MongoDB namespace/authSource and enforces supported SRV settings', () => {
    expect(parseConnectionUrl('mongodb+srv://user:secret@cluster.example/db').profile).toMatchObject({
      database: 'db',
      mongo: { srv: true, authSource: 'admin', directConnection: false },
      tls: { enabled: true },
    })
    expect(
      parseConnectionUrl('mongodb://localhost/db?authSource=accounts&replicaSet=rs').profile.mongo,
    ).toMatchObject({ authSource: 'accounts', replicaSet: 'rs' })
    expect(() => parseConnectionUrl('mongodb+srv://cluster.example/?tls=false')).toThrow(/requires TLS/)
    expect(() => parseConnectionUrl('mongodb+srv://cluster.example/?directConnection=true')).toThrow(
      /cannot be combined/,
    )
  })
  it.each([
    'postgres://localhost/db?sslmode=prefer',
    'postgres://localhost/db?sslmode=require&ssl=false',
    'postgres://localhost/db?application_name=hidden',
    'postgres://localhost/db?sslmode=require&sslmode=disable',
    'mongodb://localhost/db?tls=true&ssl=false',
    'mongodb://localhost/db?tls=1',
    'redis://localhost/1.5',
    'redis://localhost/-1',
    'redis://localhost/1?password=hidden',
    'postgres://localhost/db#hidden',
    'postgres://host1,host2/db',
  ])('rejects unsupported/ambiguous URL instead of silently changing its meaning: %s', (uri) => {
    expect(() => parseConnectionUrl(uri)).toThrow()
  })
})

describe('actionable connection diagnostics', () => {
  it.each([
    ['getaddrinfo ENOTFOUND db.local', 'DNS lookup'],
    ['ECONNREFUSED 127.0.0.1', 'Network or unavailable server'],
    ['SSH host key mismatch', 'SSH tunnel'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS certificate'],
    ['password authentication failed for user', 'Authentication'],
    [
      'ER_CANNOT_RETRIEVE_RSA_KEY: RSA public key is not available client side',
      'MySQL authentication transport',
    ],
    ['permission denied for schema private', 'Permission'],
    ['database "missing" does not exist', 'Missing database'],
    ['Unknown opaque driver error', 'Connection or configuration'],
  ])('classifies only supported error evidence: %s', (message, category) => {
    expect(connectionDiagnostic(message).category).toBe(category)
  })
  it('redacts supplied secrets, URI credentials and key-value credentials', () => {
    const output = redactConnectionMessage(
      'connection postgres://user:password@host/db failed token=abcd key super-secret',
      ['super-secret'],
    )
    expect(output).not.toMatch(/abcd|super-secret|user:password/)
    expect(connectionDiagnostic('CERT_HAS_EXPIRED').nextStep).toContain(
      'Keep certificate verification enabled',
    )
  })
})

describe('connection hub', () => {
  it('duplicates metadata without remembered credential flags, private-key paths or automatic connection', () => {
    const original = profileSchema.parse({
      id: 'source',
      name: 'production',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      hasPassword: true,
      hasSshPassword: true,
      hasPassphrase: true,
      autoReconnect: true,
      tls: { keyPath: '/private/key' },
      ssh: { privateKeyPath: '/private/ssh' },
    })
    const duplicate = duplicateProfile(original, 'copy')
    expect(duplicate).toMatchObject({
      id: 'copy',
      autoReconnect: false,
      hasPassword: false,
      hasSshPassword: false,
      hasPassphrase: false,
      tls: { keyPath: '' },
      ssh: { privateKeyPath: '' },
    })
    expect(original.tls.keyPath).toBe('/private/key')
  })
  it('orders existing history and session connection timestamps without creating history', () => {
    const history = [
      { connectionId: 'older', executedAt: '2026-01-01T00:00:00Z' },
      { connectionId: 'newest', executedAt: '2026-02-01T00:00:00Z' },
    ] as HistoryEntry[]
    expect(
      recentConnectionIds(history, {
        live: { state: 'connected', lastConnectedAt: '2026-03-01T00:00:00Z' },
        invalid: { state: 'failed', lastConnectedAt: 'invalid' },
      }),
    ).toEqual(['live', 'newest', 'older'])
    expect(history).toHaveLength(2)
  })
})
