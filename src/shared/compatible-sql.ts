import { z } from 'zod'
import type { ConnectionProfile } from './contracts'
import { sqlSafety, type SqlDialect } from './sql'

export const compatibleSqlEngines = ['cockroachdb', 'yugabytedb', 'tidb', 'vitess', 'redshift'] as const
export type CompatibleSqlEngine = (typeof compatibleSqlEngines)[number]
export const redshiftProfileSchema = z
  .object({
    deployment: z.enum(['provisioned', 'serverless']).default('provisioned'),
    authentication: z.enum(['password', 'temporary-password']).default('password'),
    expiresAt: z.string().max(40).default(''),
  })
  .strict()
export type RedshiftProfile = z.infer<typeof redshiftProfileSchema>
export const defaultRedshiftProfile = redshiftProfileSchema.parse({})

export const compatibleSqlPolicies: Record<
  CompatibleSqlEngine,
  {
    name: string
    dialect: SqlDialect
    port: number
    transactions: boolean
    readOnly: boolean
    limitation: string
  }
> = {
  cockroachdb: {
    name: 'CockroachDB',
    dialect: 'postgres',
    port: 26257,
    transactions: true,
    readOnly: false,
    limitation:
      'Serializable transaction failures are returned to you. Harbor never restarts or replays a transaction. Reviewed grid edits, import, native backup and PostgreSQL administration are unavailable.',
  },
  yugabytedb: {
    name: 'YugabyteDB YSQL',
    dialect: 'postgres',
    port: 5433,
    transactions: true,
    readOnly: false,
    limitation:
      'Connect to an explicit YSQL endpoint and database. Smart-driver topology routing and transaction replay are unavailable. Reviewed grid edits, import and PostgreSQL administration are unavailable.',
  },
  tidb: {
    name: 'TiDB',
    dialect: 'mysql',
    port: 4000,
    transactions: true,
    readOnly: false,
    limitation:
      'Connect to an explicit TiDB endpoint. TiDB READ ONLY enforcement is unavailable; guarded statements and database grants apply. DDL may commit independently; transaction errors are never retried. Reviewed grid edits, import and MySQL administration are unavailable.',
  },
  vitess: {
    name: 'Vitess',
    dialect: 'mysql',
    port: 15306,
    transactions: false,
    readOnly: true,
    limitation:
      'Initial scope is guarded queries against one explicit VTGate keyspace. Shard/tablet routing directives, writes, transactions, schema changes and import are unavailable.',
  },
  redshift: {
    name: 'Amazon Redshift',
    dialect: 'postgres',
    port: 5439,
    transactions: false,
    readOnly: true,
    limitation:
      'Initial scope is guarded warehouse/serverless queries, Redshift catalogs and explicit exports. IAM token acquisition, compute changes, writes and PostgreSQL administration are unavailable. Cursor export can consume leader-node resources.',
  },
}

export function isCompatibleSqlEngine(engine: string): engine is CompatibleSqlEngine {
  return (compatibleSqlEngines as readonly string[]).includes(engine)
}

export function verifyCompatibleProduct(engine: CompatibleSqlEngine, version: string, comment = ''): void {
  const marker = {
    cockroachdb: /\bCockroachDB\b/i,
    yugabytedb: /\bYugabyte(?:DB)?\b|PostgreSQL[^\n]*\bYB-/i,
    tidb: /\bTiDB\b/i,
    vitess: /\bVitess\b|\bVTGate\b/i,
    redshift: /\bRedshift\b/i,
  }[engine]
  if (!marker.test(`${version}\n${comment}`))
    throw new Error(
      `The server does not identify itself as ${compatibleSqlPolicies[engine].name}. Select the matching product; wire-protocol compatibility is insufficient.`,
    )
}

export function assertCompatibleProfile(
  profile: ConnectionProfile & { redshift?: RedshiftProfile },
  now = Date.now(),
): asserts profile is ConnectionProfile & { engine: CompatibleSqlEngine; redshift?: RedshiftProfile } {
  if (!isCompatibleSqlEngine(profile.engine)) throw new Error('Select a supported compatible SQL product.')
  if (profile.managed.provider !== 'none')
    throw new Error('Managed deployment presets apply to the matching base engine, not compatible products.')
  if (!profile.database.trim() || !profile.username.trim())
    throw new Error(
      'An explicit database or keyspace and username are required; automatic target discovery is unavailable.',
    )
  if (profile.autoReconnect)
    throw new Error(
      'Automatic reconnect is unavailable for compatible products. Reconnect explicitly after inspecting any uncertain write.',
    )
  if (profile.engine === 'vitess' && /[/@:]/.test(profile.database))
    throw new Error('Use one keyspace without shard or tablet-type routing directives.')
  if (compatibleSqlPolicies[profile.engine].readOnly && !profile.readOnly)
    throw new Error(
      `${compatibleSqlPolicies[profile.engine].name} currently requires guarded browsing. Writes are unavailable.`,
    )
  if (profile.engine === 'redshift') {
    if (!profile.tls.enabled || !profile.tls.rejectUnauthorized)
      throw new Error('Redshift requires TLS with certificate and hostname verification.')
    const options = redshiftProfileSchema.parse(profile.redshift ?? {})
    if (options.authentication === 'temporary-password') {
      const expires = Date.parse(options.expiresAt)
      if (
        !z.iso.datetime().safeParse(options.expiresAt).success ||
        !Number.isFinite(expires) ||
        expires <= now + 30000
      )
        throw new Error(
          'The temporary Redshift database password needs a valid UTC ISO timestamp ending in Z and more than 30 seconds remaining. Refresh it outside Harbor and reconnect; no request was replayed.',
        )
    }
  }
}

export function compatibleQuerySafety(
  engine: CompatibleSqlEngine,
  sql: string,
): ReturnType<typeof sqlSafety> {
  const policy = compatibleSqlPolicies[engine]
  const safety = sqlSafety(sql, policy.dialect)
  if (safety.statementCount !== 1)
    throw new Error('Run exactly one statement at a time for this compatible product.')
  // Reject routing or executable comments before the generic MySQL lexer removes them.
  if (policy.dialect === 'mysql' && /\/\*(?:!|M!|\s*vt[+@])/i.test(sql))
    throw new Error('Executable comments and Vitess routing directives are unavailable.')
  if (safety.controlsTransaction)
    throw new Error(
      'Use the explicit transaction controls. SQL session settings, USE and raw transaction commands are unavailable because they can change target or safety context.',
    )
  if (policy.readOnly && !safety.readOnly)
    throw new Error(`${policy.name} currently accepts guarded read-only statements only.`)
  return safety
}
