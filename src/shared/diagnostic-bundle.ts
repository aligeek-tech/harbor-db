import { z } from 'zod'
import { engineDefinitions, type Capability } from './capabilities'
import { engineSchema } from './contracts'

const countSchema = z.number().int().min(0).max(1_000_000)
const capabilitySchema = z.enum([
  'catalog',
  'sql',
  'parameters',
  'transactions',
  'rowEdits',
  'documents',
  'keys',
  'streamExport',
  'cancel',
  'search',
  'vectors',
])
export const diagnosticEventCodeSchema = z.enum([
  'metadata_integrity_ok',
  'protected_storage_available',
  'protected_storage_unavailable',
  'manual_updates_only',
  'packaged_runtime',
  'development_runtime',
  'connection_failures_present',
])
export const diagnosticBundleSchema = z
  .object({
    format: z.literal('harbor-db-diagnostics'),
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    application: z
      .object({ name: z.literal('Harbor DB'), version: z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/) })
      .strict(),
    runtime: z
      .object({
        platform: z.enum(['darwin', 'linux', 'win32', 'other']),
        architecture: z.enum(['arm64', 'x64', 'ia32', 'arm', 'other']),
        node: z.string().regex(/^v?[0-9A-Za-z.+_-]{1,64}$/),
        electron: z.string().regex(/^v?[0-9A-Za-z.+_-]{1,64}$/),
      })
      .strict(),
    distribution: z
      .object({
        packaged: z.boolean(),
        signatureVerification: z.literal('unknown'),
        notarizationVerification: z.literal('unknown'),
        automaticUpdates: z.literal(false),
        updatePolicy: z.literal('manual-download'),
      })
      .strict(),
    storage: z
      .object({
        schemaVersion: z.number().int().min(1).max(10_000),
        integrity: z.literal('ok'),
        migrationBackupPolicy: z.literal('before-version-change'),
        recovery: z.literal('not-needed'),
        counts: z
          .object({
            profiles: countSchema,
            savedQueries: countSchema,
            reports: countSchema,
            historyEntries: countSchema,
            openTabs: countSchema,
            archivedWorkspaces: countSchema,
          })
          .strict(),
      })
      .strict(),
    connections: z
      .object({
        connected: countSchema,
        connecting: countSchema,
        reconnecting: countSchema,
        degraded: countSchema,
        authenticationFailed: countSchema,
        disconnected: countSchema,
        failed: countSchema,
      })
      .strict(),
    secureStorage: z
      .object({
        available: z.boolean(),
        backend: z.enum(['keychain', 'dpapi', 'libsecret', 'kwallet', 'unavailable', 'unknown']),
      })
      .strict(),
    shippedEngines: z
      .array(
        z
          .object({
            id: engineSchema,
            model: z.enum(['relational', 'document', 'key-value', 'search', 'graph', 'vector', 'time-series', 'wide-column']),
            capabilities: z.array(capabilitySchema).max(10),
          })
          .strict(),
      )
      .max(engineSchema.options.length),
    events: z
      .array(
        z
          .object({ code: diagnosticEventCodeSchema, at: z.iso.datetime() })
          .strict(),
      )
      .max(20),
    privacy: z
      .object({
        included: z.tuple([
          z.literal('runtime-versions'),
          z.literal('aggregate-counts'),
          z.literal('structured-event-codes'),
          z.literal('shipped-capability-identifiers'),
        ]),
        excluded: z.tuple([
          z.literal('credentials-and-ciphertext'),
          z.literal('connection-identities-and-endpoints'),
          z.literal('sql-drafts-history-and-results'),
          z.literal('file-paths-environment-and-arguments'),
          z.literal('host-and-user-identifiers'),
        ]),
      })
      .strict(),
  })
  .strict()

export type DiagnosticBundle = z.infer<typeof diagnosticBundleSchema>
export type DiagnosticEventCode = z.infer<typeof diagnosticEventCodeSchema>

export interface DiagnosticBundleInput {
  generatedAt?: string
  applicationVersion: string
  platform: string
  architecture: string
  nodeVersion: string
  electronVersion: string
  packaged: boolean
  storageSchemaVersion: number
  storageCounts: DiagnosticBundle['storage']['counts']
  connectionCounts: DiagnosticBundle['connections']
  secureStorage: { available: boolean; backend: string }
  events?: DiagnosticEventCode[]
}

export const MAX_DIAGNOSTIC_BUNDLE_BYTES = 64 * 1024

export function createDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundle {
  const at = input.generatedAt ?? new Date().toISOString()
  const eventCodes = [
    'metadata_integrity_ok',
    input.secureStorage.available ? 'protected_storage_available' : 'protected_storage_unavailable',
    'manual_updates_only',
    input.packaged ? 'packaged_runtime' : 'development_runtime',
    ...(input.connectionCounts.failed ||
    input.connectionCounts.degraded ||
    input.connectionCounts.authenticationFailed
      ? (['connection_failures_present'] as const)
      : []),
    ...(input.events ?? []),
  ] satisfies DiagnosticEventCode[]
  const bundle = diagnosticBundleSchema.parse({
    format: 'harbor-db-diagnostics',
    version: 1,
    generatedAt: at,
    application: { name: 'Harbor DB', version: input.applicationVersion },
    runtime: {
      platform: diagnosticPlatform(input.platform),
      architecture: diagnosticArchitecture(input.architecture),
      node: input.nodeVersion,
      electron: input.electronVersion,
    },
    distribution: {
      packaged: input.packaged,
      // Runtime packaging flags do not prove either property.
      signatureVerification: 'unknown',
      notarizationVerification: 'unknown',
      automaticUpdates: false,
      updatePolicy: 'manual-download',
    },
    storage: {
      schemaVersion: input.storageSchemaVersion,
      integrity: 'ok',
      migrationBackupPolicy: 'before-version-change',
      recovery: 'not-needed',
      counts: input.storageCounts,
    },
    connections: input.connectionCounts,
    secureStorage: {
      available: input.secureStorage.available,
      backend: diagnosticSecureBackend(input.secureStorage.backend, input.secureStorage.available),
    },
    shippedEngines: Object.entries(engineDefinitions).map(([id, definition]) => ({
      id,
      model: definition.model,
      capabilities: [...definition.capabilities] as Capability[],
    })),
    events: [...new Set(eventCodes)].map((code) => ({ code, at })),
    privacy: {
      included: [
        'runtime-versions',
        'aggregate-counts',
        'structured-event-codes',
        'shipped-capability-identifiers',
      ],
      excluded: [
        'credentials-and-ciphertext',
        'connection-identities-and-endpoints',
        'sql-drafts-history-and-results',
        'file-paths-environment-and-arguments',
        'host-and-user-identifiers',
      ],
    },
  })
  // Defense in depth if a future schema adds a bounded string without a dedicated enum.
  return diagnosticBundleSchema.parse(redactDiagnosticValue(bundle))
}

export function serializeDiagnosticBundle(value: unknown): string {
  const bundle = diagnosticBundleSchema.parse(redactDiagnosticValue(diagnosticBundleSchema.parse(value)))
  const text = `${JSON.stringify(bundle, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_DIAGNOSTIC_BUNDLE_BYTES)
    throw new Error('The diagnostic bundle exceeded its 64 KiB safety limit.')
  return text
}

export function redactDiagnosticText(value: string): string {
  return value
    .slice(0, 3000)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|passphrase|auth|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\(?:Users|Temp)\\[^\s"']+/gi, '[redacted-path]')
    .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders)\/[^\s"']+/g, '[redacted-path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(?:host|server|endpoint)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted-host]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[redacted-host]')
}

function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (Array.isArray(value)) return value.map(redactDiagnosticValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDiagnosticValue(entry)]),
    )
  return value
}

function diagnosticPlatform(value: string): DiagnosticBundle['runtime']['platform'] {
  return ['darwin', 'linux', 'win32'].includes(value)
    ? (value as DiagnosticBundle['runtime']['platform'])
    : 'other'
}

function diagnosticArchitecture(value: string): DiagnosticBundle['runtime']['architecture'] {
  return ['arm64', 'x64', 'ia32', 'arm'].includes(value)
    ? (value as DiagnosticBundle['runtime']['architecture'])
    : 'other'
}

function diagnosticSecureBackend(
  value: string,
  available: boolean,
): DiagnosticBundle['secureStorage']['backend'] {
  if (!available) return 'unavailable'
  if (value === 'keychain' || value === 'dpapi') return value
  if (value === 'gnome_libsecret') return 'libsecret'
  if (['kwallet', 'kwallet5', 'kwallet6'].includes(value)) return 'kwallet'
  return 'unknown'
}
