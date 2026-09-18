import { z } from 'zod'
import type { ConnectionProfile } from './contracts'

export const managedDeploymentSchema = z
  .object({
    provider: z
      .enum([
        'none',
        'rds-postgres',
        'rds-mysql',
        'rds-mssql',
        'aurora-postgres',
        'aurora-mysql',
        'azure-sql',
        'cloudsql-postgres',
        'cloudsql-mysql',
        'cloudsql-mssql',
        'supabase',
        'neon',
      ])
      .default('none'),
    endpoint: z.enum(['direct', 'session', 'transaction']).default('direct'),
    authentication: z.enum(['password', 'temporary-password']).default('password'),
    expiresAt: z.string().max(40).default(''),
  })
  .strict()

export type ManagedDeployment = z.infer<typeof managedDeploymentSchema>
export type ManagedProvider = ManagedDeployment['provider']
export const defaultManagedDeployment = managedDeploymentSchema.parse({})

export const managedPresets: Record<
  Exclude<ManagedProvider, 'none'>,
  { name: string; engine: 'postgres' | 'mysql' | 'mssql'; note: string }
> = {
  'rds-postgres': {
    name: 'Amazon RDS PostgreSQL',
    engine: 'postgres',
    note: 'Use a direct database endpoint and the provider CA when required.',
  },
  'rds-mysql': {
    name: 'Amazon RDS MySQL',
    engine: 'mysql',
    note: 'The current MySQL adapter requires version 8.4. Supply the provider CA when required.',
  },
  'rds-mssql': {
    name: 'Amazon RDS SQL Server',
    engine: 'mssql',
    note: 'SQL username/password authentication only. Select one explicit database.',
  },
  'aurora-postgres': {
    name: 'Amazon Aurora PostgreSQL',
    engine: 'postgres',
    note: 'Select the intended cluster writer or reader endpoint. Failover requires an explicit reconnect.',
  },
  'aurora-mysql': {
    name: 'Amazon Aurora MySQL',
    engine: 'mysql',
    note: 'Only a server version accepted by the MySQL adapter can connect. Aurora versions require separate runtime verification.',
  },
  'azure-sql': {
    name: 'Azure SQL Database',
    engine: 'mssql',
    note: 'SQL username/password authentication only; Entra identity is unavailable. Select the target database explicitly.',
  },
  'cloudsql-postgres': {
    name: 'Google Cloud SQL PostgreSQL',
    engine: 'postgres',
    note: 'Direct verified TLS only. Cloud SQL Auth Proxy and IAM token generation are unavailable.',
  },
  'cloudsql-mysql': {
    name: 'Google Cloud SQL MySQL',
    engine: 'mysql',
    note: 'Direct verified TLS and MySQL 8.4 only. Cloud SQL Auth Proxy and IAM token generation are unavailable.',
  },
  'cloudsql-mssql': {
    name: 'Google Cloud SQL SQL Server',
    engine: 'mssql',
    note: 'Direct verified TLS and SQL username/password authentication only.',
  },
  supabase: {
    name: 'Supabase',
    engine: 'postgres',
    note: 'Use the direct endpoint or Supavisor session mode. Transaction pooling cannot preserve Harbor tab sessions.',
  },
  neon: {
    name: 'Neon',
    engine: 'postgres',
    note: 'Use the direct endpoint without -pooler. Transaction pooling cannot preserve Harbor tab sessions.',
  },
}

// Optional structurally so this isolated policy also accepts old saved profiles.
export type ManagedProfile = Pick<
  ConnectionProfile,
  'engine' | 'host' | 'port' | 'username' | 'database' | 'tls' | 'autoReconnect'
> & { managed?: ManagedDeployment }

/** Checks before opening transport or a fresh native session. Never refreshes credentials. */
export function assertManagedSession(
  profile: ManagedProfile,
  requestedDatabase = profile.database,
  now = Date.now(),
): void {
  const managed = managedDeploymentSchema.parse(profile.managed ?? {})
  if (managed.provider === 'none') return
  const preset = managedPresets[managed.provider]
  if (profile.engine !== preset.engine)
    throw new Error(`The ${preset.name} preset requires the ${preset.engine} engine.`)
  if (!profile.tls.enabled || !profile.tls.rejectUnauthorized)
    throw new Error(
      'Managed deployments require TLS with certificate and hostname verification. Supply the provider CA when required.',
    )
  if (!profile.username.trim() || !profile.database.trim())
    throw new Error(
      'Managed deployments require an explicit username and database; maintenance-database fallback is disabled.',
    )
  if (requestedDatabase !== profile.database)
    throw new Error(
      'This managed profile is bound to its configured database. Use a separate profile for another database.',
    )
  if (profile.autoReconnect)
    throw new Error('Managed deployment profiles require explicit reconnects. Disable automatic reconnect.')
  if (managed.endpoint === 'transaction')
    throw new Error(
      'Transaction pooling cannot preserve Harbor tab sessions. Choose a direct endpoint or supported session pooler.',
    )
  if (managed.endpoint === 'session' && managed.provider !== 'supabase')
    throw new Error(
      'Only the Supabase session pooler is an available session-mode preset. Select a direct endpoint.',
    )
  if (managed.provider === 'neon' && /-pooler(?:\.|$)/i.test(profile.host))
    throw new Error('This is a Neon transaction-pooler hostname. Use the direct endpoint without -pooler.')
  if (managed.provider === 'supabase' && /\.pooler\.supabase\.com$/i.test(profile.host)) {
    if (profile.port === 6543 || managed.endpoint !== 'session')
      throw new Error(
        'Select Supabase session mode and its session endpoint; the transaction pooler is unavailable.',
      )
  }
  if (managed.authentication === 'temporary-password') {
    if (profile.engine === 'mssql')
      throw new Error(
        'SQL Server presets support SQL passwords only. Identity access tokens are unavailable.',
      )
    const expires = Date.parse(managed.expiresAt)
    if (!z.iso.datetime().safeParse(managed.expiresAt).success || !Number.isFinite(expires))
      throw new Error('Enter the temporary database password expiry as an ISO timestamp in UTC ending in Z.')
    if (expires <= now + 30000)
      throw new Error(
        'The temporary database password is expired or expires within 30 seconds. Supply fresh credentials and reconnect explicitly; no request was replayed.',
      )
  }
}

/** Selecting a preset changes only reviewed connection defaults, never the endpoint or credentials. */
export function managedPresetDefaults(
  provider: ManagedProvider,
  profile: ManagedProfile,
): {
  managed: ManagedDeployment
  tls: ConnectionProfile['tls']
  autoReconnect: boolean
} {
  return {
    managed: { ...defaultManagedDeployment, provider },
    tls: provider === 'none' ? profile.tls : { ...profile.tls, enabled: true, rejectUnauthorized: true },
    autoReconnect: provider === 'none' ? profile.autoReconnect : false,
  }
}

/** Restricts requested UI/IPC context, not SQL authorization; database grants remain authoritative. */
export function assertManagedTarget(
  profile: ConnectionProfile,
  target: { database?: string; schema?: string },
): void {
  if (!profile.managed || profile.managed.provider === 'none') return
  if (target.database && target.database !== profile.database)
    throw new Error(
      'This managed profile is bound to its configured database. Open a separate profile for another target.',
    )
  const schema = profile.engine === 'mysql' ? profile.database : profile.schema
  if (target.schema && schema && target.schema !== schema)
    throw new Error(
      'This managed profile is bound to its configured schema. Review another schema in a separate profile.',
    )
}

export function managedCatalogTarget<T extends { connectionId?: string; database?: string; schema?: string }>(
  profile: ConnectionProfile,
  target: T,
): T {
  assertManagedTarget(profile, target)
  if (profile.managed.provider === 'none') return target
  return {
    ...target,
    database: profile.database,
    schema: profile.engine === 'mysql' ? profile.database : profile.schema || target.schema,
  }
}

/** Covers direct catalog/query inputs and the two explicit ends of a transfer preview. */
export function assertManagedIpcTargets(input: unknown, resolve: (id: string) => ConnectionProfile): void {
  if (!input || typeof input !== 'object') return
  const record = input as Record<string, unknown>
  const check = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const target = value as Record<string, unknown>
    if (typeof target.connectionId !== 'string') return
    assertManagedTarget(resolve(target.connectionId), {
      database: typeof target.database === 'string' ? target.database : undefined,
      schema: typeof target.schema === 'string' ? target.schema : undefined,
    })
  }
  check(record)
  check(record.source)
  check(record.target)
}
