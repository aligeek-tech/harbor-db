import { timeSeriesProfileSchema, type TimeSeriesAPI } from './time-series'
import type { MongoFileAPI } from './mongo-files'
import { cqlProfileSchema, type CqlAPI } from './cql'
import { dynamoProfileSchema, type DynamoAPI } from './dynamodb'
import type { NeoAPI } from './neo4j'
import type { CouchAPI } from './couchdb'
import { athenaProfileSchema } from './athena'
import { firebirdProfileSchema } from './firebird'
import { warehouseProfileSchema } from './warehouses'
import { bigQueryProfileSchema, type BigQueryEstimate } from './bigquery'
import { trinoProfileSchema, type TrinoProgress } from './trino'
import { managedDeploymentSchema, defaultManagedDeployment } from './managed-deployment'
import { redshiftProfileSchema, defaultRedshiftProfile } from './compatible-sql'
import type {
  ExportWorkspaceHandoff,
  ImportWorkspaceHandoff,
  WorkspaceHandoffPreview,
  WorkspaceHandoffResult,
} from './portable-workspace'
import type { Workspace } from './workspaces'
import type {
  ObjectInspectionInput,
  ObjectInspection,
  ExplainInput,
  ExplainResult,
  DiagnosticInput,
  DiagnosticResult,
} from './inspection'
import { analyticsReadSchema, analyticsImportSchema, type AnalyticsFileGrant } from './analytics'
import type { ForeignKeyInfo } from './related-records'
import type { ExportJobSnapshot, FullExportInput } from './transfers'
export type { ForeignKeyInfo } from './related-records'
import { z } from 'zod'
import { searchProfileSchema } from './search'
import { redisTopologySchema, type RedisTopologySnapshot } from './redis-topology'
import type {
  ImportOptions,
  ImportTarget,
  ImportPreview,
  StartImportInput,
  ImportJobSnapshot,
} from './imports'
import { parameterDefinitionSchema, queryParameterSchema } from './parameters'
import type { Capability, CapabilityResult } from './capabilities'

export const engineSchema = z.enum([
  'db2',
  'cockroachdb',
  'yugabytedb',
  'tidb',
  'vitess',
  'redshift',
  'postgres',
  'mariadb',
  'mysql',
  'sqlite',
  'duckdb',
  'mssql',
  'clickhouse',
  'elasticsearch',
  'opensearch',
  'oracle',
  'trino',
  'bigquery',
  'snowflake',
  'databricks',
  'athena',
  'firebird',
  'hana',
  'couchdb',
  'neo4j',
  'dynamodb',
  'cassandra',
  'influxdb',
  'questdb',
  'qdrant',
  'milvus',
  'weaviate',
  'pinecone',
  'redis',
  'valkey',
  'mongodb',
])
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
    redis: redisTopologySchema.default({ mode: 'standalone', seeds: [], serviceName: '', sentinelUsername: '', addressMap: [] }),
    warehouse: warehouseProfileSchema.default({ warehouse: '', role: '', snowflakeTokenType: 'OAUTH' }),
    firebird: firebirdProfileSchema.default({ mode: 'server', role: '' }),
    athena: athenaProfileSchema.default({ region: 'us-east-1', catalog: 'AwsDataCatalog', workgroup: 'primary', outputLocation: '', expectedBucketOwner: '', maximumScannedBytes: '100000000' }),
    bigQuery: bigQueryProfileSchema.default({ location: 'US', maximumBytesBilled: '100000000' }),
    trino: trinoProfileSchema.default({ auth: 'none', timeZone: 'UTC' }),
    timeSeries: timeSeriesProfileSchema.default({generation:'2-flux',orgId:''}),
    cql: cqlProfileSchema.default({dataCenter:'datacenter1'}),
    dynamo: dynamoProfileSchema.default({region:'us-east-1',accountId:'',local:true}),
    search: searchProfileSchema.default({ auth: 'basic', pathPrefix: '' }),
    sqlite: z
      .object({
        path: z.string().max(4096).default(''),
        mode: z.enum(['open', 'create']).default('open'),
        busyTimeoutMs: z.number().int().min(0).max(30000).default(5000),
      })
      .strict()
      .default({ path: '', mode: 'open', busyTimeoutMs: 5000 }),
    duckdb: z
      .object({
        path: z.string().max(4096).default(''),
        mode: z.enum(['open', 'create', 'memory']).default('open'),
      })
      .strict()
      .default({ path: '', mode: 'open' }),
    mongo: z
      .object({
        srv: z.boolean().default(false),
        authSource: z.string().min(1).max(255).default('admin'),
        replicaSet: z.string().max(255).default(''),
        directConnection: z.boolean().default(false),
        seeds: z.array(z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535) }).strict()).max(10).default([]),
        authMechanism: z.enum(['DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1']).default('DEFAULT'),
        readPreference: z.enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']).default('primary'),
      })
      .strict()
      .default({ srv: false, authSource: 'admin', replicaSet: '', directConnection: false, seeds: [], authMechanism: 'DEFAULT', readPreference: 'primary' }),
    managed: managedDeploymentSchema.default(defaultManagedDeployment),
    redshift: redshiftProfileSchema.default(defaultRedshiftProfile),
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
    hasSentinelPassword: z.boolean().default(false),
  })
  .strict()
export type ConnectionProfile = z.infer<typeof profileSchema>
export const secretsSchema = z
  .object({
    password: z.string().max(10000).optional(),
    sshPassword: z.string().max(10000).optional(),
    passphrase: z.string().max(10000).optional(),
    sentinelPassword: z.string().max(10000).optional(),
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
    parameters: z.array(queryParameterSchema).max(100).optional(),
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
  generated?: boolean
  identity?: 'always' | 'by-default'
}
export interface TableStructure {
  foreignKeys?: ForeignKeyInfo[]
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
    sorts: z
      .array(z.object({ column: z.string().min(1).max(255), direction: z.enum(['asc', 'desc']) }).strict())
      .max(8)
      .optional(),
    filters: z
      .object({
        match: z.enum(['all', 'any']),
        conditions: z
          .array(
            z
              .object({
                column: z.string().min(1).max(255),
                operator: z.enum([
                  'contains',
                  'equals',
                  'not equals',
                  'greater than',
                  'less than',
                  'is null',
                  'is not null',
                ]),
                value: z.string().max(10000),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional(),
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
  state:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'degraded'
    | 'authentication-failed'
    | 'failed'
  checkedAt?: string
  changedAt?: string
  lastConnectedAt?: string
  version?: string
  durationMs?: number
  error?: string
  transport?: string
}
export const redisScanSchema = z
  .object({
    connectionId: z.string(),
    cursor: z.string().max(100).regex(/^(?:\d+|scan:[a-f0-9-]+)$/).default('0'),
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
  progress?: { node: string; completedNodes: number; totalNodes: number }
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
export { tabSchema, settingsSchema, workspaceSchema } from './workspaces'
export type { WorkspaceTab, Settings, Workspace } from './workspaces'
export const savedQuerySchema = z
  .object({
    id: z.string(),
    name: z.string().min(1).max(255),
    collection: z.string().min(1).max(255).optional(),
    searchIndex: z.string().max(255).optional(),
    searchPageSize: z.number().int().min(0).max(1000).optional(),
    mongoMode: z.enum(['find', 'aggregate']).optional(),
    sql: z.string().max(1000000),
    engine: engineSchema,
    connectionId: z.string().optional(),
    database: z.string().min(1).max(255).optional(),
    schema: z.string().max(255).optional(),
    parameterDefinitions: z.array(parameterDefinitionSchema).max(100).optional(),
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
  reports: import('./reports').ReportDefinition[]
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
export interface HarborAPI extends MongoFileAPI, CouchAPI, NeoAPI, DynamoAPI, TimeSeriesAPI, CqlAPI {
  vectorCollections(connectionId: string): Promise<import('./vector').VectorCollection[]>
  vectorSearch(input: import('./vector').VectorSearchInput): Promise<import('./vector').VectorSearchResult>
  vectorMutate(input: import('./vector').VectorMutationInput): Promise<import('./vector').VectorMutationResult>
  vectorCancel(input: { connectionId: string; requestId: string }): Promise<{ requested: boolean }>
  listAutomations(): Promise<{
    definitions: import('./automation').AutomationDefinition[]
    runs: import('./automation').AutomationRun[]
    runningTaskId?: string
  }>
  saveAutomation(input: import('./automation').AutomationDefinition): Promise<import('./automation').AutomationDefinition>
  deleteAutomation(id: string): Promise<void>
  chooseAutomationDirectory(): Promise<string | null>
  previewAutomationImport(id: string): Promise<ImportPreview | null>
  runAutomation(input: {
    id: string
    sourceId?: string
    consentBatchCommits?: true
    consentNonTransactionalAppend?: true
  }): Promise<import('./automation').AutomationRun>
  cancelAutomation(id: string): Promise<{ requested: boolean }>
  previewAssistance(
    input: import('./assistance').AssistancePreviewInput,
  ): Promise<import('./assistance').AssistancePreview>
  startAssistance(
    input: import('./assistance').AssistanceStartInput,
  ): Promise<import('./assistance').AssistanceResult>
  cancelAssistance(input: import('./assistance').AssistanceCancelInput): Promise<{ requested: boolean }>
  saveReport(input: import('./reports').ReportDefinition): Promise<import('./reports').ReportDefinition>
  deleteReport(id: string): Promise<void>
  bigQueryEstimate(input: { connectionId: string; database: string; sql: string }): Promise<BigQueryEstimate>
  warehouseProgress(input: { connectionId: string; sessionId: string; requestId: string }): Promise<TrinoProgress | null>
  athenaProgress(input: { connectionId: string; sessionId: string; requestId: string }): Promise<TrinoProgress | null>
  bigQueryProgress(input: { connectionId: string; sessionId: string; requestId: string }): Promise<TrinoProgress | null>
  trinoProgress(input: { connectionId: string; sessionId: string; requestId: string }): Promise<TrinoProgress | null>
  previewDatabaseTransfer(input: import('./database-transfer').PreviewDatabaseTransferInput): Promise<import('./database-transfer').DatabaseTransferPreview>
  startDatabaseTransfer(input: import('./database-transfer').StartDatabaseTransferInput): Promise<import('./database-transfer').DatabaseTransferJob>
  getDatabaseTransferJob(id: string): Promise<import('./database-transfer').DatabaseTransferJob>
  cancelDatabaseTransferJob(id: string): Promise<import('./database-transfer').DatabaseTransferJob>
  chooseBackupTool(kind: import('./native-backup').NativeBackupToolKind): Promise<import('./native-backup').NativeBackupTool | null>
  chooseBackupArchive(): Promise<import('./native-backup').NativeBackupArchive | null>
  previewNativeBackup(input: import('./native-backup').PreviewNativeBackupInput): Promise<import('./native-backup').NativeBackupPreview>
  startNativeBackup(input: import('./native-backup').StartNativeBackupInput): Promise<import('./native-backup').NativeBackupJob | null>
  getNativeBackupJob(id: string): Promise<import('./native-backup').NativeBackupJob>
  cancelNativeBackupJob(id: string): Promise<import('./native-backup').NativeBackupJob>
  searchCatalog(input: { connectionId: string }): Promise<import('./search').SearchCatalog>
  searchMappings(input: { connectionId: string; index: string }): Promise<import('./search').SearchMapping>
  searchRead(input: import('./search').SearchInput): Promise<import('./search').SearchResult>
  searchDocument(input: import('./search').SearchDocumentInput): Promise<import('./search').SearchHit>
  searchMutate(input: import('./search').SearchMutationInput): Promise<import('./search').SearchMutationResult>
  searchCloseCursor(input: { connectionId: string; sessionId: string; cursor: string }): Promise<void>
  searchCancel(input: { connectionId: string; sessionId: string; requestId: string }): Promise<import('./search').SearchCancelResult>
  exportSchemaDiagram(input: import('./schema-diagram').SchemaDiagramData): Promise<{ cancelled: boolean; path?: string }>
  previewSchemaChange(input: import('./schema-changes').PreviewSchemaChangeInput): Promise<import('./schema-changes').SchemaChangePreview>
  inspectSqlAdministration(input: import('./sql-administration').InspectSqlAdministrationInput): Promise<import('./sql-administration').SqlAdminInspection>
  previewSqlAdministration(input: import('./sql-administration').PreviewSqlAdministrationInput): Promise<import('./sql-administration').SqlAdminPreview>
  executeSqlAdministration(input: import('./sql-administration').ExecuteSqlAdministrationInput): Promise<import('./sql-administration').SqlAdminResult>
  executeSchemaChange(input: import('./schema-changes').ExecuteSchemaChangeInput): Promise<import('./schema-changes').SchemaChangeResult>
  compareSchemas(input: import('./schema-changes').CompareSchemasInput): Promise<import('./schema-changes').SchemaComparison>
  exportWorkspaceHandoff(input: ExportWorkspaceHandoff): Promise<{ cancelled: boolean; path?: string }>
  previewWorkspaceHandoff(): Promise<WorkspaceHandoffPreview | null>
  importWorkspaceHandoff(input: ImportWorkspaceHandoff): Promise<WorkspaceHandoffResult>
  chooseImportFile(input: { target: ImportTarget; options: ImportOptions }): Promise<ImportPreview | null>
  startImportJob(input: StartImportInput): Promise<ImportJobSnapshot>
  importJob(id: string): Promise<ImportJobSnapshot>
  cancelImportJob(id: string): Promise<ImportJobSnapshot>
  inspectObject(input: ObjectInspectionInput): Promise<ObjectInspection>
  explainQuery(input: ExplainInput): Promise<ExplainResult>
  diagnostics(input: DiagnosticInput): Promise<DiagnosticResult>
  copyText(text: string): Promise<void>
  chooseAnalyticsFile(input: {
    connectionId: string
    format: 'csv' | 'json' | 'parquet'
  }): Promise<AnalyticsFileGrant | null>
  previewAnalyticsFile(input: z.infer<typeof analyticsReadSchema>): Promise<QueryResult>
  importAnalyticsFile(input: z.infer<typeof analyticsImportSchema>): Promise<{ affectedRows: number }>

  startFullExport(input: FullExportInput): Promise<ExportJobSnapshot | null>
  exportJob(id: string): Promise<ExportJobSnapshot>
  cancelExportJob(id: string): Promise<ExportJobSnapshot>
  capabilities(id: string): Promise<Record<Capability, CapabilityResult>>
  chooseDatabaseFile(mode: 'open' | 'create'): Promise<string | null>
  mongoDatabases(id: string): Promise<string[]>
  mongoCollections(input: { connectionId: string; database: string }): Promise<string[]>
  mongoRead(input: MongoReadInput): Promise<MongoReadResult>
  mongoWrite(input: MongoWriteInput): Promise<void>
  mongoTopology(connectionId: string): Promise<import('./mongo-tools').MongoTopology>
  mongoIndexes(input: import('./mongo-tools').MongoToolTarget): Promise<import('./mongo-tools').MongoIndexCatalog>
  mongoIndexPreview(input: import('./mongo-tools').MongoIndexPreviewInput): Promise<import('./mongo-tools').MongoIndexPreview>
  mongoIndexExecute(input: import('./mongo-tools').MongoIndexExecuteInput): Promise<import('./mongo-tools').MongoIndexResult>
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
  }): Promise<{
    state: 'idle' | 'open' | 'failed'
    connected: boolean
    running: boolean
    errorLocation?: { position: number }
  }>
  table(input: TableInput): Promise<QueryResult>
  applyEdits(input: EditsInput): Promise<{ affectedRows: number }>
  redisScan(input: RedisScanInput): Promise<RedisScanResult>
  redisTopology(connectionId: string): Promise<RedisTopologySnapshot>
  redisStreamGroups(input: import('./redis-tools').RedisStreamGroupsInput): Promise<import('./redis-tools').RedisStreamGroups>
  redisSubscribe(input: import('./redis-tools').RedisSubscribeInput): Promise<import('./redis-tools').RedisSubscription>
  redisSubscription(id: string): Promise<import('./redis-tools').RedisSubscription>
  redisStopSubscription(id: string): Promise<import('./redis-tools').RedisSubscription>
  redisInspect(input: RedisInspectInput): Promise<RedisValue>
  redisMutate(input: RedisMutateInput): Promise<void>
  saveQuery(input: SavedQuery): Promise<void>
  deleteQuery(id: string): Promise<void>
  clearHistory(): Promise<void>
  clearDrafts(): Promise<void>
  previewDiagnosticBundle(): Promise<import('./diagnostic-bundle').DiagnosticBundle>
  exportDiagnosticBundle(
    input: import('./diagnostic-bundle').DiagnosticBundle,
  ): Promise<{ cancelled: boolean; path?: string }>
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
