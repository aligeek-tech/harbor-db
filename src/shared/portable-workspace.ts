import { z } from 'zod'
import { profileSchema, savedQuerySchema, type ConnectionProfile } from './contracts'
import { settingsSchema, workspaceSnapshotSchema } from './workspaces'

export const MAX_HANDOFF_BYTES = 32 * 1024 * 1024

/** Deliberate allowlist: OS credential records, freeform notes, and local paths never enter the archive. */
export const portableProfileSchema = profileSchema
  .pick({
    id: true,
    name: true,
    engine: true,
    host: true,
    port: true,
    username: true,
    database: true,
    schema: true,
    redisDb: true,
    redis: true,
    mongo: true,
    search: true,
    warehouse: true,
    athena: true,
    bigQuery: true,
    trino: true,
    dynamo: true,
    cql: true,
    timeSeries: true,
    managed: true,
    redshift: true,
    firebird: true,
    environment: true,
    color: true,
    folder: true,
    tags: true,
    favorite: true,
    historyEnabled: true,
    connectTimeout: true,
    queryTimeout: true,
  })
  .extend({
    tls: z.object({ enabled: z.boolean(), rejectUnauthorized: z.literal(true) }).strict(),
    ssh: z
      .object({
        enabled: z.boolean(),
        host: z.string().max(255),
        port: z.number().int().min(1).max(65535),
        username: z.string().max(255),
        hostKey: z.string().max(512),
      })
      .strict(),
  })
  .strict()
export type PortableProfile = z.infer<typeof portableProfileSchema>
export const portableWorkspaceSchema = z
  .object({
    format: z.literal('harbor-db-workspace'),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    profiles: z.array(portableProfileSchema).max(1000),
    queries: z.array(savedQuerySchema).max(1000),
    workspaces: z.array(workspaceSnapshotSchema).max(20),
    settings: settingsSchema.strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['profiles', 'queries', 'workspaces'] as const) {
      if (new Set(value[key].map((item) => item.id)).size !== value[key].length)
        context.addIssue({ code: 'custom', path: [key], message: `Duplicate ${key} IDs are not allowed.` })
    }
    if (value.settings.privateSession)
      context.addIssue({
        code: 'custom',
        path: ['settings', 'privateSession'],
        message: 'Portable archives cannot enable private-session state.',
      })
  })
export type PortableWorkspaceArchive = z.infer<typeof portableWorkspaceSchema>
export const exportWorkspaceHandoffSchema = z
  .object({ includeQueries: z.boolean(), includeDrafts: z.boolean() })
  .strict()
export type ExportWorkspaceHandoff = z.infer<typeof exportWorkspaceHandoffSchema>
export const importWorkspaceHandoffSchema = z
  .object({
    token: z.string().min(1).max(100),
    profiles: z
      .array(
        z.discriminatedUnion('action', [
          z.object({ sourceId: z.string().max(100), action: z.literal('copy') }).strict(),
          z.object({ sourceId: z.string().max(100), action: z.literal('skip') }).strict(),
          z
            .object({
              sourceId: z.string().max(100),
              action: z.literal('bind'),
              existingId: z.string().min(1).max(100),
            })
            .strict(),
        ]),
      )
      .max(1000),
    queryMode: z.enum(['copy', 'skip-conflicts', 'skip']),
    workspaceIds: z.array(z.string().min(1).max(100)).max(19),
    settings: z.enum(['keep', 'import']),
  })
  .strict()
export type ImportWorkspaceHandoff = z.infer<typeof importWorkspaceHandoffSchema>
export interface WorkspaceHandoffPreview {
  token: string
  archive: PortableWorkspaceArchive
  conflicts: { profileIds: string[]; queryIds: string[]; workspaceIds: string[] }
  warnings: string[]
}
export interface WorkspaceHandoffResult {
  profiles: number
  queries: number
  workspaces: number
  skippedTabs: number
  warnings: string[]
}

export function portableProfile(profile: ConnectionProfile): PortableProfile {
  // Pick rather than spread prevents a future added credential/path field being exported accidentally.
  return portableProfileSchema.parse({
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.engine === 'firebird' && /^(?:\/|[A-Za-z]:[\\/])/.test(profile.database) ? '' : profile.database,
    schema: profile.schema,
    redisDb: profile.redisDb,
    redis: profile.redis,
    mongo: profile.mongo,
    search: profile.search,
    warehouse: profile.warehouse,
    athena: profile.athena,
    bigQuery: profile.bigQuery,
    trino: profile.trino,
    dynamo: profile.dynamo,
    cql: profile.cql,
    timeSeries: profile.timeSeries,
    managed: profile.managed,
    redshift: profile.redshift,
    firebird: profile.firebird,
    environment: profile.environment,
    color: profile.color,
    folder: profile.folder,
    tags: profile.tags,
    favorite: profile.favorite,
    historyEnabled: profile.historyEnabled,
    connectTimeout: profile.connectTimeout,
    queryTimeout: profile.queryTimeout,
    tls: { enabled: profile.tls.enabled, rejectUnauthorized: true },
    ssh: {
      enabled: profile.ssh.enabled,
      host: profile.ssh.host,
      port: profile.ssh.port,
      username: profile.ssh.username,
      hostKey: profile.ssh.hostKey,
    },
  })
}

export function importedProfile(profile: PortableProfile, id: string, name: string): ConnectionProfile {
  return profileSchema.parse({
    ...portableProfileSchema.parse(profile),
    id,
    name,
    autoReconnect: false,
    readOnly: true,
    hasPassword: false,
    hasSshPassword: false,
    hasPassphrase: false,
    hasSentinelPassword: false,
    sqlite: { path: '', mode: 'open' },
    duckdb: { path: '', mode: 'open' },
    tls: { ...profile.tls, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    ssh: { ...profile.ssh, privateKeyPath: '' },
    notes: '',
  })
}

export function parsePortableWorkspace(text: string): PortableWorkspaceArchive {
  if (new TextEncoder().encode(text).byteLength > MAX_HANDOFF_BYTES)
    throw new Error('Workspace handoff exceeds the 32 MiB limit.')
  return portableWorkspaceSchema.parse(JSON.parse(text))
}
