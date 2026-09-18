import { describe, expect, it } from 'vitest'
import {
  createDiagnosticBundle,
  diagnosticBundleSchema,
  MAX_DIAGNOSTIC_BUNDLE_BYTES,
  redactDiagnosticText,
  serializeDiagnosticBundle,
} from '../src/shared/diagnostic-bundle'

const input = () => ({
  generatedAt: '2026-09-18T12:00:00.000Z',
  applicationVersion: '0.1.7',
  platform: 'darwin',
  architecture: 'arm64',
  nodeVersion: 'v24.19.0',
  electronVersion: '44.3.0',
  packaged: true,
  storageSchemaVersion: 5,
  storageCounts: {
    profiles: 3,
    savedQueries: 4,
    reports: 2,
    historyEntries: 5,
    openTabs: 6,
    archivedWorkspaces: 1,
  },
  connectionCounts: {
    connected: 1,
    connecting: 0,
    reconnecting: 0,
    degraded: 0,
    authenticationFailed: 0,
    disconnected: 1,
    failed: 1,
  },
  secureStorage: { available: true, backend: 'keychain' },
})

describe('privacy-safe diagnostic bundle', () => {
  it('contains strict aggregate runtime facts and never infers signing or notarization', () => {
    const bundle = createDiagnosticBundle(input())
    expect(bundle).toMatchObject({
      format: 'harbor-db-diagnostics',
      version: 1,
      distribution: {
        packaged: true,
        signatureVerification: 'unknown',
        notarizationVerification: 'unknown',
        automaticUpdates: false,
        updatePolicy: 'manual-download',
      },
      secureStorage: { available: true, backend: 'keychain' },
      connections: {
        connected: 1,
        connecting: 0,
        reconnecting: 0,
        degraded: 0,
        authenticationFailed: 0,
        disconnected: 1,
        failed: 1,
      },
    })
    expect(bundle.events.map((event) => event.code)).toEqual([
      'metadata_integrity_ok',
      'protected_storage_available',
      'manual_updates_only',
      'packaged_runtime',
      'connection_failures_present',
    ])
    expect(bundle.shippedEngines).toContainEqual(
      expect.objectContaining({ id: 'postgres', model: 'relational' }),
    )
    expect(bundle.shippedEngines).toContainEqual(
      expect.objectContaining({ id: 'redis', model: 'key-value' }),
    )
  })

  it('drops untrusted profile, SQL, result, credential, path, environment and argument fields', () => {
    const canaries = {
      profileName: 'CANARY_PROFILE_CUSTOMER_PRODUCTION',
      endpoint: 'db.private.example:5432',
      sql: "SELECT 'CANARY_SQL_PRIVATE'",
      result: 'CANARY_RESULT_PRIVATE',
      password: 'CANARY_PASSWORD_PRIVATE',
      ciphertext: 'CANARY_CIPHERTEXT_PRIVATE',
      homePath: '/Users/private-customer/harbor.sqlite3',
      env: 'HARBOR_SECRET=CANARY_ENV_PRIVATE',
      argv: '--customer=CANARY_ARG_PRIVATE',
    }
    const text = serializeDiagnosticBundle(createDiagnosticBundle({ ...input(), ...canaries }))
    for (const value of Object.values(canaries)) expect(text).not.toContain(value)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_DIAGNOSTIC_BUNDLE_BYTES)
    expect(diagnosticBundleSchema.parse(JSON.parse(text))).toBeTruthy()
  })

  it('uses allowlisted storage backends and structured event codes only', () => {
    expect(
      createDiagnosticBundle({
        ...input(),
        packaged: false,
        secureStorage: { available: false, backend: 'plaintext-with-private-name' },
        connectionCounts: {
          connected: 0,
          connecting: 0,
          reconnecting: 0,
          degraded: 0,
          authenticationFailed: 0,
          disconnected: 0,
          failed: 0,
        },
      }),
    ).toMatchObject({
      secureStorage: { available: false, backend: 'unavailable' },
      events: [
        { code: 'metadata_integrity_ok' },
        { code: 'protected_storage_unavailable' },
        { code: 'manual_updates_only' },
        { code: 'development_runtime' },
      ],
    })
    const bundle = createDiagnosticBundle(input())
    expect(() =>
      diagnosticBundleSchema.parse({
        ...bundle,
        events: [{ code: 'metadata_integrity_ok', at: bundle.generatedAt, message: 'freeform' }],
      }),
    ).toThrow()
    expect(() => diagnosticBundleSchema.parse({ ...bundle, profiles: [] })).toThrow()
  })

  it('redacts credential-shaped text, URI userinfo, endpoints, paths, email and IP canaries', () => {
    const redacted = redactDiagnosticText(
      'postgres://admin:private@db.example/harbor password=private token:abc /Users/alice/private.sql C:\\Users\\Alice\\private.sql owner@example.com host=db.internal.example:5432 10.20.30.40:5432',
    )
    for (const value of [
      'admin:private',
      'password=private',
      'token:abc',
      '/Users/alice',
      'C:\\Users\\Alice',
      'owner@example.com',
      'db.internal.example:5432',
      '10.20.30.40:5432',
    ])
      expect(redacted).not.toContain(value)
    expect(redacted).toContain('[redacted]')
  })
})
