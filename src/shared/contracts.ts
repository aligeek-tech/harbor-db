import { z } from 'zod'

export const engineSchema = z.enum(['postgres', 'mariadb', 'redis', 'mongodb'])
export type Engine = z.infer<typeof engineSchema>
export const profileSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    engine: engineSchema,
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255).default(''),
    database: z.string().max(255).default(''),
    schema: z.string().max(255).default('public'),
    redisDb: z.number().int().min(0).max(1024).default(0),
    mongo: z
      .object({
        srv: z.boolean().default(false),
        authSource: z.string().min(1).max(255).default('admin'),
        replicaSet: z.string().max(255).default(''),
        directConnection: z.boolean().default(false),
      })
      .strict()
      .default({ srv: false, authSource: 'admin', replicaSet: '', directConnection: false }),
    environment: z.string().min(1).max(40).default('local'),
    color: z.string().max(32).default(''),
    folder: z.string().max(100).default(''),
    tags: z.array(z.string().max(60)).max(30).default([]),
    notes: z.string().max(5000).default(''),
    favorite: z.boolean().default(false),
    readOnly: z.boolean().default(true),
    autoReconnect: z.boolean().default(false),
    historyEnabled: z.boolean().default(true),
    connectTimeout: z.number().int().min(1000).max(120000).default(10000),
    queryTimeout: z.number().int().min(1000).max(600000).default(30000),
    tls: z
      .object({
        enabled: z.boolean().default(false),
        rejectUnauthorized: z.boolean().default(true),
        ca: z.string().max(100000).default(''),
        cert: z.string().max(100000).default(''),
        keyPath: z.string().max(4096).default(''),
      })
      .default({ enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' }),
    ssh: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().max(255).default(''),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().max(255).default(''),
        privateKeyPath: z.string().max(4096).default(''),
        hostKey: z.string().max(512).default(''),
      })
      .default({ enabled: false, host: '', port: 22, username: '', privateKeyPath: '', hostKey: '' }),
    hasPassword: z.boolean().default(false),
    hasSshPassword: z.boolean().default(false),
    hasPassphrase: z.boolean().default(false),
  })
  .strict()
export type ConnectionProfile = z.infer<typeof profileSchema>
export const secretsSchema = z
  .object({
    password: z.string().max(10000).optional(),
    sshPassword: z.string().max(10000).optional(),
    passphrase: z.string().max(10000).optional(),
  })
  .strict()
export type Secrets = z.infer<typeof secretsSchema>
export const saveProfileSchema = z
  .object({
    profile: profileSchema,
    secrets: secretsSchema.optional(),
    rememberPassword: z.boolean().default(false),
  })
  .strict()
export type SaveProfileInput = z.infer<typeof saveProfileSchema>
export type Cell = null | string | number | boolean | { type: 'binary'; base64: string }
export interface ResultColumn {
  name: string
  type: string
  key?: boolean
  nullable?: boolean
}
export interface ResultSet {
  columns: ResultColumn[]
  rows: Cell[][]
  affectedRows: number
  command: string
  truncated: boolean
}
export interface QueryResult {
  requestId: string
  sets: ResultSet[]
  durationMs: number
  messages: string[]
  transaction: 'idle' | 'open' | 'failed'
  cancelled?: boolean
  tableQuery?: { sql: string; parameters: Cell[]; editorSql: string }
}
export const querySchema = z
  .object({
    connectionId: z.string().min(1),
    database: z.string().min(1).max(255).optional(),
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    sql: z.string().min(1).max(1000000),
    maxRows: z.number().int().min(1).max(10000).default(1000),
    privateSession: z.boolean().default(false),
    confirm: z.string().max(255).optional(),
  })
  .strict()
export type QueryInput = z.infer<typeof querySchema>
export interface ObjectInfo {
  name: string
  schema: string
  database?: string
  kind: 'table' | 'view' | 'materialized view' | 'function' | 'sequence' | 'trigger'
  estimatedRows?: string
}
export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  primaryKey: boolean
  primaryKeyPosition?: number
}
export interface TableStructure {
  isHypertable?: boolean
  columns: ColumnInfo[]
  indexes: { name: string; definition: string }[]
  constraints: { name: string; definition: string }[]
  ddl: string
}
export const tableInputSchema = z
  .object({
    connectionId: z.string().min(1),
    database: z.string().min(1).max(255).optional(),
    sessionId: z.string().min(1),
    schema: z.string().max(255),
    table: z.string().min(1).max(255),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(1000).default(200),
    sort: z.string().max(255).optional(),
    direction: z.enum(['asc', 'desc']).default('asc'),
    filter: z
      .object({
        column: z.string().max(255),
        operator: z.enum(['contains', 'equals', 'is null']),
        value: z.string().max(10000),
      })
      .optional(),
  })
  .strict()
export type TableInput = z.infer<typeof tableInputSchema>
export const cellSchema = z.union([
  z.null(),
  z.string().max(1000000),
  z.number().finite(),
  z.boolean(),
  z.object({ type: z.literal('binary'), base64: z.string().max(2000000) }),
])
export const editsSchema = z
  .object({
    connectionId: z.string(),
    database: z.string().min(1).max(255).optional(),
    sessionId: z.string(),
    schema: z.string().max(255),
    table: z.string().min(1).max(255),
    changes: z
      .array(
        z.object({
          kind: z.enum(['insert', 'update', 'delete']),
          original: z.record(z.string(), cellSchema).optional(),
          values: z.record(z.string(), cellSchema),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict()
export type EditsInput = z.infer<typeof editsSchema>
export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  version?: string
  durationMs?: number
  error?: string
  transport?: string
}
export const redisScanSchema = z
  .object({
    connectionId: z.string(),
    cursor: z.string().regex(/^\d+$/).default('0'),
    pattern: z.string().max(1000).default('*'),
    count: z.number().int().min(10).max(1000).default(200),
  })
  .strict()
export type RedisScanInput = z.infer<typeof redisScanSchema>
export interface RedisKey {
  key: string
  keyBase64: string
  type: string
  ttl: number
}
export interface RedisScanResult {
  cursor: string
  keys: RedisKey[]
}
export const redisInspectSchema = z
  .object({
    connectionId: z.string(),
    keyBase64: z.string().max(100000),
    cursor: z.string().max(100).default('0'),
    offset: z.number().int().min(0).default(0),
    count: z.number().int().min(1).max(500).default(100),
  })
  .strict()
export type RedisInspectInput = z.infer<typeof redisInspectSchema>
export interface RedisValue {
  key: RedisKey
  value: Cell
  entries: Cell[][]
  cursor: string
  size: number
  truncated: boolean
  rawBase64?: string
}
export const redisMutateSchema = z
  .object({
    connectionId: z.string(),
    keyBase64: z.string().max(100000),
    action: z.enum([
      'set',
      'delete',
      'rename',
      'expire',
      'persist',
      'hset',
      'hdel',
      'lpush',
      'rpush',
      'lset',
      'sadd',
      'srem',
      'zadd',
      'zrem',
      'xadd',
      'xdel',
    ]),
    value: z.string().max(1000000).optional(),
    valueBase64: z.string().max(2000000).optional(),
    expectedBase64: z.string().max(2000000).optional(),
    field: z.string().max(100000).optional(),
    fieldBase64: z.string().max(2000000).optional(),
    createOnly: z.boolean().optional(),
    score: z.number().finite().optional(),
    index: z.number().int().optional(),
    ttl: z.number().int().min(0).max(2147483647).optional(),
  })
  .strict()
export type RedisMutateInput = z.infer<typeof redisMutateSchema>
export const tabSchema = z
  .object({
    id: z.string(),
    connectionId: z.string(),
    database: z.string().min(1).max(255).optional(),
    kind: z.enum(['query', 'table', 'redis', 'mongo']),
    mongoMode: z.enum(['find', 'aggregate']).optional(),
    title: z.string().max(255),
    sql: z.string().max(1000000).default(''),
    schema: z.string().max(255).optional(),
    table: z.string().max(255).optional(),
    cursor: z.number().int().min(0).optional(),
    scrollTop: z.number().min(0).optional(),
    columnWidths: z.record(z.string(), z.number()).optional(),
    hiddenColumns: z.array(z.string()).optional(),
  })
  .strict()
export type WorkspaceTab = z.infer<typeof tabSchema>
export const settingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  editorFontSize: z.number().min(11).max(24).default(14),
  zoom: z.number().min(0.75).max(1.5).default(1),
  historyEnabled: z.boolean().default(true),
  historyRetentionDays: z.number().int().min(1).max(365).default(30),
  privateSession: z.boolean().default(false),
  sidebarWidth: z.number().min(190).max(400).default(248),
  editorHeight: z.number().min(140).max(700).default(290),
  inspectorOpen: z.boolean().default(true),
  pageSize: z.number().int().min(25).max(1000).default(200),
})
export type Settings = z.infer<typeof settingsSchema>
export const workspaceSchema = z
  .object({
    tabs: z.array(tabSchema).max(100),
    activeTabId: z.string().nullable(),
    expanded: z.array(z.string()).max(1000),
    settings: settingsSchema,
  })
  .strict()
export type Workspace = z.infer<typeof workspaceSchema>
export const savedQuerySchema = z
  .object({
    id: z.string(),
    name: z.string().min(1).max(255),
    collection: z.string().min(1).max(255).optional(),
    mongoMode: z.enum(['find', 'aggregate']).optional(),
    sql: z.string().max(1000000),
    engine: engineSchema,
    connectionId: z.string().optional(),
    database: z.string().min(1).max(255).optional(),
    folder: z.string().max(100).default(''),
    tags: z.array(z.string()).default([]),
    updatedAt: z.string(),
  })
  .strict()
export type SavedQuery = z.infer<typeof savedQuerySchema>
export interface HistoryEntry {
  id: string
  connectionId: string
  database?: string
  sql: string
  executedAt: string
  durationMs: number
  rowCount: number
  success: boolean
  error?: string
}
export interface Bootstrap {
  profiles: ConnectionProfile[]
  workspace: Workspace
  savedQueries: SavedQuery[]
  history: HistoryEntry[]
  secureStorage: { available: boolean; backend: string; reason?: string }
  version: string
  platform: string
}
export const importSchema = z
  .object({
    format: z.literal('harbor-db-connections'),
    version: z.literal(1),
    profiles: z.array(profileSchema).max(1000),
  })
  .strict()
export interface HarborAPI {
  mongoDatabases(id: string): Promise<string[]>
  mongoCollections(input: { connectionId: string; database: string }): Promise<string[]>
  mongoRead(input: MongoReadInput): Promise<MongoReadResult>
  mongoWrite(input: MongoWriteInput): Promise<void>
  bootstrap(): Promise<Bootstrap>
  saveProfile(input: SaveProfileInput): Promise<ConnectionProfile>
  deleteProfile(id: string): Promise<void>
  forgetPassword(id: string): Promise<void>
  testConnection(input: SaveProfileInput): Promise<ConnectionStatus>
  connect(input: { id: string; secrets?: Secrets }): Promise<ConnectionStatus>
  disconnect(id: string): Promise<void>
  status(id: string): Promise<ConnectionStatus>
  saveWorkspace(workspace: Workspace): Promise<void>
  listObjects(input: { connectionId: string; database?: string; schema?: string }): Promise<ObjectInfo[]>
  listDatabases(id: string): Promise<string[]>
  structure(input: {
    connectionId: string
    database?: string
    schema: string
    table: string
  }): Promise<TableStructure>
  query(input: QueryInput): Promise<QueryResult>
  cancel(input: {
    connectionId: string
    sessionId: string
    requestId: string
  }): Promise<{ requested: boolean; message: string }>
  transaction(input: {
    connectionId: string
    sessionId: string
    database?: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: 'idle' | 'open' | 'failed' }>
  closeSession(input: { connectionId: string; sessionId: string }): Promise<void>
  getSessionState(input: {
    connectionId: string
    sessionId: string
  }): Promise<{ state: 'idle' | 'open' | 'failed'; connected: boolean; running: boolean }>
  table(input: TableInput): Promise<QueryResult>
  applyEdits(input: EditsInput): Promise<{ affectedRows: number }>
  redisScan(input: RedisScanInput): Promise<RedisScanResult>
  redisInspect(input: RedisInspectInput): Promise<RedisValue>
  redisMutate(input: RedisMutateInput): Promise<void>
  saveQuery(input: SavedQuery): Promise<void>
  deleteQuery(id: string): Promise<void>
  clearHistory(): Promise<void>
  clearDrafts(): Promise<void>
  exportProfiles(): Promise<{ cancelled: boolean; path?: string }>
  previewImport(): Promise<ConnectionProfile[] | null>
  importProfiles(profiles: ConnectionProfile[]): Promise<ConnectionProfile[]>
  exportResults(input: {
    format: 'csv' | 'json'
    columns: ResultColumn[]
    rows: Cell[][]
    spreadsheetSafe: boolean
    scope: string
  }): Promise<{ cancelled: boolean; path?: string }>
  importSql(): Promise<{ name: string; sql: string } | null>
  exportSql(input: { name: string; sql: string }): Promise<void>
  setZoom(value: number): Promise<void>
  readyToClose(): Promise<void>
  onMenu(callback: (action: string) => void): () => void
}

const mongoTarget = {
  connectionId: z.string().min(1).max(100),
  database: z.string().min(1).max(255),
  collection: z.string().min(1).max(255),
}
export const mongoReadSchema = z
  .object({
    ...mongoTarget,
    mode: z.enum(['find', 'aggregate']).default('find'),
    query: z.string().min(1).max(1000000).default('{}'),
    sort: z.string().max(255).optional(),
    direction: z.enum(['asc', 'desc']).default('asc'),
    offset: z.number().int().min(0).max(1000000).default(0),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict()
export type MongoReadInput = z.infer<typeof mongoReadSchema>
export interface MongoReadResult {
  documents: string[]
  set: ResultSet
  durationMs: number
  hasMore: boolean
  truncated: boolean
}
export const mongoWriteSchema = z
  .object({
    ...mongoTarget,
    action: z.enum(['insert', 'replace', 'delete']),
    original: z.string().max(1000000).optional(),
    document: z.string().max(1000000).optional(),
  })
  .strict()
export type MongoWriteInput = z.infer<typeof mongoWriteSchema>
declare global {
  interface Window {
    harbor: HarborAPI
  }
}
