import { mongoFileExportSchema, mongoFileImportSchema } from '../shared/mongo-files'
import type { MongoFileService } from './persistence/mongo-files'
import type { WarehouseService } from './engines/warehouses'
import type { AthenaService } from './engines/athena'
import type { HanaService } from './engines/hana'
import type { FirebirdService } from './engines/firebird'
import { seriesCatalogSchema, seriesInspectSchema, seriesQuerySchema, seriesCancelSchema } from '../shared/time-series'
import type { TimeSeriesService } from './engines/time-series'
import { couchReadSchema, couchDocumentSchema, couchMutationSchema, couchCancelSchema } from '../shared/couchdb'
import { cqlTablesSchema,cqlTargetSchema,cqlExecuteSchema,cqlNextSchema,cqlCancelSchema } from '../shared/cql'
import type { CqlService } from './engines/cql'
import { dynamoCatalogSchema, dynamoTableSchema, dynamoReadSchema, dynamoNextSchema, dynamoMutationSchema, dynamoCancelSchema } from '../shared/dynamodb'
import type { DynamoService } from './engines/dynamodb'
import { neoQuerySchema, neoNextSchema, neoCancelSchema } from '../shared/neo4j'
import type { Neo4jService } from './engines/neo4j'
import type { CouchdbService } from './engines/couchdb'
import type { BigQueryService } from './engines/bigquery'
import { bigQueryEstimateInputSchema } from '../shared/bigquery'
import { reportDefinitionSchema } from '../shared/reports'
import type { TrinoService } from './engines/trino'
import { assertManagedIpcTargets, managedCatalogTarget } from '../shared/managed-deployment'
import type { Db2Service } from './engines/db2'
import type { CompatibleSqlService } from './engines/compatible-sql'
import { compatibleSqlEngines } from '../shared/compatible-sql'
import { previewDatabaseTransferSchema, startDatabaseTransferSchema } from '../shared/database-transfer'
import { nativeBackupToolSchema, previewNativeBackupSchema, startNativeBackupSchema } from '../shared/native-backup'
import type { DatabaseTransferService } from './persistence/database-transfer'
import type { NativeBackupService } from './persistence/native-backup'
import type { VectorService } from './engines/vector'
import { isKeyValueEngine } from '../shared/key-value'
import { AdapterRegistry } from './engines/adapter'
import { redisStreamGroupsSchema, redisSubscribeSchema } from '../shared/redis-tools'
import { diagramSchema, diagramSvg } from '../shared/schema-diagram'
import { SchemaChangesService } from './persistence/schema-changes'
import { SqlAdministrationService } from './persistence/sql-administration'
import { inspectSqlAdministrationSchema, previewSqlAdministrationSchema, executeSqlAdministrationSchema } from '../shared/sql-administration'
import { previewSchemaChangeSchema, executeSchemaChangeSchema, compareSchemasSchema } from '../shared/schema-changes'
import { queryParameterSchema } from '../shared/parameters'
import { PortableWorkspaceService } from './persistence/portable-workspace'
import {
  exportWorkspaceHandoffSchema,
  importWorkspaceHandoffSchema,
  MAX_HANDOFF_BYTES,
} from '../shared/portable-workspace'
import { importOptionsSchema, importTargetSchema, startImportSchema } from '../shared/imports'
import type { ImportService } from './persistence/transfer-imports'
import { analyticsFormatSchema, analyticsReadSchema, analyticsImportSchema } from '../shared/analytics'
import type { DuckDBFileGrant } from './engines/duckdb-worker'
import type { DuckDBService } from './engines/duckdb'
import type { MssqlService } from './engines/mssql'
import type { SearchClusterService } from './engines/search-cluster'
import { searchInputSchema, searchDocumentSchema, searchMutationSchema } from '../shared/search'
import { mongoToolTargetSchema, mongoIndexPreviewSchema, mongoIndexExecuteSchema } from '../shared/mongo-tools'
import type { ClickhouseService } from './engines/clickhouse'
import type { OracleService } from './engines/oracle'
import { fullExportSchema } from '../shared/transfers'
import type { TransferService } from './persistence/transfers'
import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  cellSchema,
  editsSchema,
  profileSchema,
  querySchema,
  redisInspectSchema,
  redisMutateSchema,
  redisScanSchema,
  mongoReadSchema,
  mongoWriteSchema,
  savedQuerySchema,
  saveProfileSchema,
  secretsSchema,
  settingsSchema,
  tableInputSchema,
  workspaceSchema,
  type ConnectionProfile,
  type SaveProfileInput,
  type Secrets,
} from '../shared/contracts'
import { MetadataStore, SCHEMA_VERSION } from './persistence/store'
import { CredentialService, redactHistory } from './persistence/credentials'
import { exportLoadedData } from './persistence/export'
import type { SqlService } from './engines/sql'
import type { RedisService } from './engines/redis'
import type { MongoService } from './engines/mongo'
import type { SqliteService } from './engines/sqlite'
import { capabilitiesFor, engineSupports } from '../shared/capabilities'
import {
  createDiagnosticBundle,
  diagnosticBundleSchema,
  serializeDiagnosticBundle,
} from '../shared/diagnostic-bundle'

import {
  assistanceCancelSchema,
  assistancePreviewInputSchema,
  assistanceStartSchema,
} from '../shared/assistance'
import { AssistanceService } from './persistence/assistance'
import { automationDefinitionSchema, type AutomationDefinition } from '../shared/automation'
import { AutomationService } from './persistence/automation'
import { vectorMutateSchema, vectorSearchSchema } from '../shared/vector'

const id = z.string().min(1).max(100)
const context = { connectionId: id, sessionId: id }
const database = z.string().min(1).max(255).optional()
const sessionSchema = z.object(context).strict()
const objectSchema = z
  .object({ connectionId: id, database, schema: z.string().max(255), table: z.string().min(1).max(255) })
  .strict()
const exportSchema = z
  .object({
    format: z.enum(['csv', 'json']),
    columns: z
      .array(
        z
          .object({
            name: z.string().max(10000),
            type: z.string().max(1000),
            key: z.boolean().optional(),
            nullable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2000),
    rows: z.array(z.array(cellSchema).max(2000)).max(10000),
    spreadsheetSafe: z.boolean(),
    scope: z.enum(['loaded results', 'selected rows', 'loaded table page']),
  })
  .strict()
const executionContext = (profile: ConnectionProfile) =>
  JSON.stringify({
    name: profile.name,
    environment: profile.environment,
    engine: profile.engine,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.database,
    schema: profile.schema,
    redisDb: profile.redisDb,
    trino: profile.trino,
    bigQuery: profile.bigQuery,
    warehouse: profile.warehouse,
    athena: profile.athena,
    firebird: profile.firebird,
    dynamo: profile.dynamo,
    cql: profile.cql,
    timeSeries: profile.timeSeries,
    managed: profile.managed,
    redshift: profile.redshift,
    mongo: profile.mongo,
    redis: profile.redis,
    search: profile.search,
    sqlite: profile.sqlite,
    duckdb: profile.duckdb,
    readOnly: profile.readOnly,
    connectTimeout: profile.connectTimeout,
    queryTimeout: profile.queryTimeout,
    tls: profile.tls,
    ssh: profile.ssh,
  })
export const ipcSchemas = {
  cqlKeyspaces: id,
  cqlTables: cqlTablesSchema,
  cqlStructure: cqlTargetSchema,
  cqlExecute: cqlExecuteSchema,
  cqlNext: cqlNextSchema,
  cqlCancel: cqlCancelSchema,
  dynamoTables: dynamoCatalogSchema,
  dynamoTable: dynamoTableSchema,
  dynamoRead: dynamoReadSchema,
  dynamoNext: dynamoNextSchema,
  dynamoMutate: dynamoMutationSchema,
  dynamoCancel: dynamoCancelSchema,
  seriesCatalog: seriesCatalogSchema,
  seriesInspect: seriesInspectSchema,
  seriesQuery: seriesQuerySchema,
  seriesCancel: seriesCancelSchema,
  vectorCollections: id,
  vectorSearch: vectorSearchSchema,
  vectorMutate: vectorMutateSchema,
  vectorCancel: z.object({ connectionId: id, requestId: z.string().uuid() }).strict(),
  listAutomations: z.undefined(),
  saveAutomation: automationDefinitionSchema,
  deleteAutomation: z.string().uuid(),
  chooseAutomationDirectory: z.undefined(),
  previewAutomationImport: z.string().uuid(),
  runAutomation: z
    .object({
      id: z.string().uuid(),
      sourceId: z.string().uuid().optional(),
      consentBatchCommits: z.literal(true).optional(),
      consentNonTransactionalAppend: z.literal(true).optional(),
    })
    .strict(),
  cancelAutomation: z.string().uuid(),
  previewAssistance: assistancePreviewInputSchema,
  startAssistance: assistanceStartSchema,
  cancelAssistance: assistanceCancelSchema,
  neoDatabases: id,
  neoQuery: neoQuerySchema,
  neoNext: neoNextSchema,
  neoCancel: neoCancelSchema,
  couchDatabases: id,
  couchRead: couchReadSchema,
  couchDocument: couchDocumentSchema,
  couchMutate: couchMutationSchema,
  couchCancel: couchCancelSchema,
  saveReport: reportDefinitionSchema,
  deleteReport: id,
  bigQueryEstimate: bigQueryEstimateInputSchema,
  warehouseProgress: z.object({ ...context, requestId: id }).strict(),
  athenaProgress: z.object({ ...context, requestId: id }).strict(),
  bigQueryProgress: z.object({ ...context, requestId: id }).strict(),
  trinoProgress: z.object({ ...context, requestId: id }).strict(),
  previewDatabaseTransfer: previewDatabaseTransferSchema,
  startDatabaseTransfer: startDatabaseTransferSchema,
  getDatabaseTransferJob: id,
  cancelDatabaseTransferJob: id,
  chooseBackupTool: nativeBackupToolSchema,
  chooseBackupArchive: z.undefined(),
  previewNativeBackup: previewNativeBackupSchema,
  startNativeBackup: startNativeBackupSchema,
  getNativeBackupJob: id,
  cancelNativeBackupJob: id,
  exportSchemaDiagram: diagramSchema,
  previewSchemaChange: previewSchemaChangeSchema,
  inspectSqlAdministration: inspectSqlAdministrationSchema,
  previewSqlAdministration: previewSqlAdministrationSchema,
  executeSqlAdministration: executeSqlAdministrationSchema,
  executeSchemaChange: executeSchemaChangeSchema,
  compareSchemas: compareSchemasSchema,
  exportWorkspaceHandoff: exportWorkspaceHandoffSchema,
  previewWorkspaceHandoff: z.undefined(),
  importWorkspaceHandoff: importWorkspaceHandoffSchema,
  chooseImportFile: z.object({ target: importTargetSchema, options: importOptionsSchema }).strict(),
  startImportJob: startImportSchema,
  importJob: id,
  cancelImportJob: id,
  chooseAnalyticsFile: z.object({ connectionId: id, format: analyticsFormatSchema }).strict(),
  previewAnalyticsFile: analyticsReadSchema,
  importAnalyticsFile: analyticsImportSchema,
  inspectObject: z
    .object({
      connectionId: id,
      database,
      schema: z.string().max(255),
      name: z.string().min(1).max(255),
      kind: z.enum(['table', 'view', 'function', 'trigger']),
      identity: z.string().max(255).optional(),
    })
    .strict(),
  explainQuery: z
    .object({
      ...context,
      requestId: id,
      database,
      sql: z.string().min(1).max(1000000),
      parameters: z.array(queryParameterSchema).max(100).optional(),
      mode: z.enum(['estimate', 'analyze']),
      consentAnalyze: z.literal(true).optional(),
    })
    .strict(),
  diagnostics: z
    .object({
      connectionId: id,
      database,
      kind: z.enum(['activity', 'locks', 'indexes', 'permissions', 'extensions', 'timescale']),
      schema: z.string().max(255).optional(),
      table: z.string().max(255).optional(),
      includeQueryText: z.boolean().optional(),
    })
    .strict(),
  copyText: z.string().max(8 * 1024 * 1024),
  startFullExport: fullExportSchema,
  exportJob: id,
  cancelExportJob: id,
  capabilities: id,
  chooseDatabaseFile: z.enum(['open', 'create']),
  mongoDatabases: id,
  mongoCollections: z.object({ connectionId: id, database: z.string().min(1).max(255) }).strict(),
  mongoRead: mongoReadSchema,
  mongoTopology: id,
  chooseMongoImport: mongoToolTargetSchema,
  startMongoImport: mongoFileImportSchema,
  startMongoExport: mongoFileExportSchema,
  mongoFileJob: id,
  cancelMongoFileJob: id,
  mongoIndexes: mongoToolTargetSchema,
  mongoIndexPreview: mongoIndexPreviewSchema,
  mongoIndexExecute: mongoIndexExecuteSchema,
  searchCatalog: z.object({ connectionId: id }).strict(),
  searchMappings: z.object({ connectionId: id, index: z.string().min(1).max(255) }).strict(),
  searchRead: searchInputSchema,
  searchDocument: searchDocumentSchema,
  searchMutate: searchMutationSchema,
  searchCloseCursor: z.object({ ...context, cursor: z.string().uuid() }).strict(),
  searchCancel: z.object({ ...context, requestId: id }).strict(),
  mongoWrite: mongoWriteSchema,
  bootstrap: z.undefined(),
  saveProfile: saveProfileSchema,
  deleteProfile: id,
  forgetPassword: id,
  testConnection: saveProfileSchema,
  connect: z.object({ id, secrets: secretsSchema.optional() }).strict(),
  disconnect: id,
  status: id,
  saveWorkspace: workspaceSchema.extend({ settings: settingsSchema.strict() }),
  listObjects: z.object({ connectionId: id, database, schema: z.string().max(255).optional() }).strict(),
  listDatabases: id,
  structure: objectSchema,
  query: querySchema.extend({ connectionId: id, sessionId: id, requestId: id }),
  cancel: z.object({ ...context, requestId: id }).strict(),
  transaction: z.object({ ...context, database, action: z.enum(['begin', 'commit', 'rollback']) }).strict(),
  closeSession: sessionSchema,
  getSessionState: sessionSchema,
  table: tableInputSchema.extend(context),
  applyEdits: editsSchema.extend(context),
  redisScan: redisScanSchema.extend({ connectionId: id }),
  redisTopology: id,
  redisStreamGroups: redisStreamGroupsSchema,
  redisSubscribe: redisSubscribeSchema,
  redisSubscription: z.string().uuid(),
  redisStopSubscription: z.string().uuid(),
  redisInspect: redisInspectSchema.extend({ connectionId: id }),
  redisMutate: redisMutateSchema.extend({ connectionId: id }),
  saveQuery: savedQuerySchema.extend({
    id,
    connectionId: id.optional(),
    tags: z.array(z.string().max(60)).max(30),
    updatedAt: z.iso.datetime(),
  }),
  deleteQuery: id,
  clearHistory: z.undefined(),
  clearDrafts: z.undefined(),
  previewDiagnosticBundle: z.undefined(),
  exportDiagnosticBundle: diagnosticBundleSchema,
  exportProfiles: z.undefined(),
  previewImport: z.undefined(),
  importProfiles: z.array(profileSchema).max(1000),
  exportResults: exportSchema,
  importSql: z.undefined(),
  exportSql: z.object({ name: z.string().min(1).max(255), sql: z.string().max(1000000) }).strict(),
  setZoom: z.number().min(0.75).max(1.5),
  readyToClose: z.undefined(),
} as const

export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: Pick<BrowserWindow, 'webContents'>,
  expectedUrl: string,
): boolean {
  if (
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false
  try {
    const received = new URL(event.senderFrame.url)
    const expected = new URL(expectedUrl)
    received.hash = ''
    expected.hash = ''
    return received.href === expected.href
  } catch {
    return false
  }
}

export function registerIpc(
  window: BrowserWindow,
  expectedUrl: string,
  store: MetadataStore,
  credentials: CredentialService,
  sql: SqlService,
  redis: RedisService,
  mongo: MongoService,
  finishShutdown: () => Promise<void>,
  sqlite?: SqliteService,
  transfers?: TransferService,
  duckdb?: DuckDBService,
  imports?: ImportService,
  mssql?: MssqlService,
  clickhouse?: ClickhouseService,
  elasticsearch?: SearchClusterService,
  opensearch?: SearchClusterService,
  oracle?: OracleService,
  compatible?: CompatibleSqlService,
  databaseTransfers?: DatabaseTransferService,
  nativeBackups?: NativeBackupService,
  trino?: TrinoService,
  bigquery?: BigQueryService,
  warehouses?: { snowflake: WarehouseService; databricks: WarehouseService },
  mongoFiles?: MongoFileService,
  athena?: AthenaService,
  couchdb?: CouchdbService,
  firebird?: FirebirdService,
  neo4j?: Neo4jService,
  hana?: HanaService,
  vectors?: VectorService,
  dynamodb?: DynamoService,
  timeSeries?: TimeSeriesService,
  db2?: Db2Service,
  cassandra?: CqlService,
): () => void {
  const assistance = new AssistanceService()
  const handoffs = new PortableWorkspaceService(store)
  const importGrants = new Map<string, { target: string; context: string; expires: number }>()
  const importTargetKey = (target: z.infer<typeof importTargetSchema>) =>
    JSON.stringify([target.connectionId, target.database ?? '', target.schema, target.table])
  const fileGrants = new Map<string, { connectionId: string; grant: DuckDBFileGrant; expires: number }>()
  const grantedFile = (connectionId: string, token: string) => {
    if (store.profile(connectionId).engine !== 'duckdb' || !duckdb)
      throw new Error('Select a connected DuckDB target for local file exploration.')
    const record = fileGrants.get(token)
    if (!record || record.connectionId !== connectionId || record.expires < Date.now())
      throw new Error('This local file permission expired. Select the file again.')
    return record.grant
  }
  const locks = new Map<string, Promise<unknown>>()
  const serial = async <T>(connectionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(connectionId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    locks.set(connectionId, current)
    try {
      return await current
    } finally {
      if (locks.get(connectionId) === current) locks.delete(connectionId)
    }
  }
  const registry = new AdapterRegistry()
  registry.register('postgres', sql, sql)
  registry.register('mariadb', sql, sql)
  registry.register('mysql', sql, sql)
  registry.register('redis', redis)
  registry.register('valkey', redis)
  registry.register('mongodb', mongo)
  if (sqlite) registry.register('sqlite', sqlite, sqlite)
  if (duckdb) registry.register('duckdb', duckdb, duckdb)
  if (mssql) registry.register('mssql', mssql, mssql)
  if (clickhouse) registry.register('clickhouse', clickhouse, clickhouse)
  if (elasticsearch) registry.register('elasticsearch', elasticsearch)
  if (opensearch) registry.register('opensearch', opensearch)
  if (oracle) registry.register('oracle', oracle, oracle)
  if (compatible) for (const engine of compatibleSqlEngines) registry.register(engine, compatible, compatible)
  if (warehouses) { registry.register('snowflake', warehouses.snowflake, warehouses.snowflake); registry.register('databricks', warehouses.databricks, warehouses.databricks) }
  if (bigquery) registry.register('bigquery', bigquery, bigquery)
  if (athena) registry.register('athena', athena, athena)
  if (firebird) registry.register('firebird', firebird, firebird)
  if (db2) registry.register('db2',db2,db2)
  if (hana) registry.register('hana', hana, hana)
  if (couchdb) registry.register('couchdb', couchdb)
  if (neo4j) registry.register('neo4j', neo4j)
  if (timeSeries) { registry.register('influxdb',timeSeries);registry.register('questdb',timeSeries) }
  const seriesService = (id:string) => { if(!timeSeries || !['influxdb','questdb'].includes(store.profile(id).engine))throw new Error('Choose a time-series connection.');return timeSeries }
  if (dynamodb) registry.register('dynamodb', dynamodb)
  if(cassandra)registry.register('cassandra',cassandra)
  const cqlService=(id:string):CqlService=>{if(store.profile(id).engine!=='cassandra'||!cassandra)throw new Error('Choose a Cassandra connection.');return cassandra}
  const dynamoService = (id: string): DynamoService => { if (store.profile(id).engine !== 'dynamodb' || !dynamodb) throw new Error('Choose a DynamoDB connection.'); return dynamodb }
  const neoService = (id: string): Neo4jService => { if (store.profile(id).engine !== 'neo4j' || !neo4j) throw new Error('Choose a Neo4j connection.'); return neo4j }
  const couchService = (id: string): CouchdbService => {
    if (store.profile(id).engine !== 'couchdb' || !couchdb) throw new Error('Choose a CouchDB connection.'); return couchdb
  }
  if (trino) registry.register('trino', trino, trino)
  const searchService = (id: string): SearchClusterService => {
    const engine = store.profile(id).engine
    const adapter = engine === 'elasticsearch' ? elasticsearch : engine === 'opensearch' ? opensearch : undefined
    if (!adapter) throw new Error('This action requires the matching Elasticsearch or OpenSearch connection.')
    return adapter
  }
  if (vectors) {
    registry.register('qdrant', vectors)
    registry.register('milvus', vectors)
    registry.register('weaviate', vectors)
    registry.register('pinecone', vectors)
  }
  const relational = (connectionId: string) => registry.relational(store.profile(connectionId).engine)
  const service = (profile: ConnectionProfile) => registry.connection(profile.engine)
  const automationImportGrants = new Map<string, { sourceId: string; context: string; expires: number }>()
  const automationImportContext = (task: AutomationDefinition) =>
    JSON.stringify({ profile: executionContext(store.profile(task.target.connectionId)), target: task.target })
  const automation = new AutomationService(store, async (task, signal, reviewedImport) => {
    if (signal.aborted) throw new Error('Reusable task cancelled before execution.')
    const profile = store.profile(task.target.connectionId)
    if (profile.environment.toLowerCase() === 'production')
      throw new Error('Production reusable tasks remain disabled. Run the underlying workflow manually after review.')
    if (service(profile).status(profile.id).state !== 'connected')
      throw new Error('The visible task target is not connected in this desktop runtime.')
    if (task.target.kind === 'report') {
      const target = task.target
      const report = store.reports().find((item) => item.id === target.reportId)
      if (!report || report.connectionId !== profile.id)
        throw new Error('The saved report target no longer matches this reusable task.')
      if (report.parameterDefinitions.length)
        throw new Error('Parameterized reports require fresh values and cannot run as unattended automation.')
      const requestId = randomUUID(), sessionId = `automation-${task.id}`
      const adapter = relational(profile.id)
      const cancel = () => void adapter.cancel({ connectionId: profile.id, sessionId, requestId })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await adapter.execute({
          connectionId: profile.id, database: report.database, sessionId, requestId,
          sql: report.sql, maxRows: Math.min(task.limits.maxRows, 10_000), privateSession: true,
        })
        const rows = result.sets.reduce((sum, set) => sum + set.rows.length, 0)
        return { rows, bytes: Buffer.byteLength(JSON.stringify(result.sets), 'utf8'), message: 'Saved report query completed; only bounded counts were logged.' }
      } finally {
        signal.removeEventListener('abort', cancel)
        await adapter.closeSession({ connectionId: profile.id, sessionId }).catch(() => undefined)
      }
    }
    if (task.target.kind === 'export') {
      if (!transfers || !engineSupports(profile.engine, 'streamExport'))
        throw new Error('Full export is unavailable for this target in this runtime.')
      const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')
      const safeName = task.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'harbor-export'
      const outputPath = join(task.target.outputDirectory, `${safeName}-${stamp}.${task.target.format}`)
      const snapshot = await transfers.startExport({
        connectionId: profile.id, database: task.target.database, sql: task.target.sql,
        format: task.target.format, spreadsheetSafe: task.target.spreadsheetSafe, consentRerun: true,
      }, outputPath, { maxRows: task.limits.maxRows, maxBytes: task.limits.maxOutputBytes, signal })
      const cancel = () => { transfers.cancelJob(snapshot.id) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        while (true) {
          const current = transfers.getJob(snapshot.id)
          if (current.state !== 'running') {
            if (current.state !== 'completed') throw new Error(current.error || `Export ${current.state}.`)
            return { rows: current.rows, bytes: current.bytes, message: 'Streaming export completed within configured limits.' }
          }
          if (current.rows > task.limits.maxRows || current.bytes > task.limits.maxOutputBytes) {
            transfers.cancelJob(snapshot.id)
            throw new Error('Export reached its configured row or byte limit. Partial output was not finalized.')
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
    if (!imports || !reviewedImport)
      throw new Error('Import requires a fresh reviewed file grant in this desktop session.')
    const grant = automationImportGrants.get(task.id)
    automationImportGrants.delete(task.id)
    if (!grant || grant.sourceId !== reviewedImport.sourceId || grant.expires < Date.now() || grant.context !== automationImportContext(task)) {
      imports.discardSource(reviewedImport.sourceId)
      throw new Error('The fresh import review expired or its visible target changed. Review the file again.')
    }
    const snapshot = await imports.startImport({
      ...task.target.target, sourceId: reviewedImport.sourceId, mapping: task.target.mapping,
      batchSize: task.target.batchSize, errorPolicy: task.target.errorPolicy,
      consentBatchCommits: reviewedImport.consentBatchCommits,
      consentNonTransactionalAppend: reviewedImport.consentNonTransactionalAppend,
    }, { maxRows: task.limits.maxRows, maxBytes: task.limits.maxOutputBytes, signal })
    const cancel = () => { imports.cancelJob(snapshot.id) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        const current = imports.getJob(snapshot.id)
        if (current.state !== 'running') {
          if (current.state !== 'completed')
            throw new Error(current.error || `Import ${current.state}; inspect committed and uncertain row counts before retrying.`)
          return { rows: current.committedRows, bytes: current.bytesRead, message: 'Freshly reviewed import completed with no automatic retry or replay.' }
        }
        if (current.committedRows > task.limits.maxRows) {
          imports.cancelJob(snapshot.id)
          throw new Error('Import reached its configured row limit. Earlier acknowledged batches may remain committed; inspect before retrying.')
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  })
  automation.start()
  const schemaChanges = new SchemaChangesService({
    profile: (id) => store.profile(id),
    adapter: (id) => {
      const adapter = relational(id)
      registry.requireCapability(store.profile(id).engine, 'transactions')
      return {
        execute: (input) => adapter.execute(input),
        structure: (input) => adapter.structure(input),
        transaction: (input) => adapter.transaction!(input),
        closeSession: (input) => adapter.closeSession(input),
        getSessionState: (input) => adapter.getSessionState(input),
      }
    },
  })
  const requireSql = (connectionId: string): void => {
    if (!engineSupports(store.profile(connectionId).engine, 'sql'))
      throw new Error('This action requires a SQL connection.')
  }
  const sqlAdministration = new SqlAdministrationService({
    profile: (id) => store.profile(id),
    adapter: (id) => {
      const adapter = relational(id)
      registry.requireCapability(store.profile(id).engine, 'transactions')
      return { execute: (input) => adapter.execute(input), transaction: (input) => adapter.transaction!(input), closeSession: (input) => adapter.closeSession(input), getSessionState: (input) => adapter.getSessionState(input) }
    },
  })
  const requireRedis = (connectionId: string): void => {
    if (!isKeyValueEngine(store.profile(connectionId).engine))
      throw new Error('This action requires a Redis connection.')
  }
  const requireMongo = (connectionId: string): void => {
    if (store.profile(connectionId).engine !== 'mongodb')
      throw new Error('This action requires a MongoDB connection.')
  }
  const requireServerSql = (connectionId: string) => {
    if (!['postgres', 'mariadb', 'mysql'].includes(store.profile(connectionId).engine))
      throw new Error(
        'This inspection is available for PostgreSQL, MariaDB and MySQL. Other engines provide their own catalog workflows.',
      )
  }
  const checkedFile = async (path: string, limit: number): Promise<string> => {
    const info = await stat(path)
    if (!info.isFile() || info.size > limit)
      throw new Error(`Choose a regular file smaller than ${Math.floor(limit / 1000000)} MB.`)
    return readFile(path, 'utf8')
  }
  const test = async (input: SaveProfileInput) => {
    if (
      (input.profile.engine === 'sqlite' && input.profile.sqlite.mode === 'create') ||
      (input.profile.engine === 'duckdb' && input.profile.duckdb.mode === 'create')
    )
      throw new Error(
        'Testing never creates a database file. Choose Create and connect to create a new local database explicitly.',
      )
    const start = performance.now()
    const temporary = { ...input.profile, id: `test-${randomUUID()}` }
    let secret: Secrets | undefined
    try {
      secret = store.hasProfile(input.profile.id)
        ? credentials.resolve(input.profile.id, input.secrets)
        : input.secrets || {}
      return await service(temporary).connect(temporary, secret)
    } catch (error) {
      return {
        state: 'failed' as const,
        durationMs: Math.round(performance.now() - start),
        error: credentials.sanitize(error, secret || input.secrets),
      }
    } finally {
      await service(temporary)
        .disconnect(temporary.id)
        .catch(() => undefined)
      secret = undefined
    }
  }
  const diagnosticBundle = () => {
    const profiles = store.profiles()
    const workspace = store.workspace()
    const connectionCounts = {
      connected: 0,
      connecting: 0,
      reconnecting: 0,
      degraded: 0,
      'authentication-failed': 0,
      disconnected: 0,
      failed: 0,
    }
    for (const profile of profiles) connectionCounts[service(profile).status(profile.id).state]++
    const secureStorage = credentials.status()
    return createDiagnosticBundle({
      applicationVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron || 'unknown',
      packaged: app.isPackaged,
      storageSchemaVersion: SCHEMA_VERSION,
      storageCounts: {
        profiles: profiles.length,
        savedQueries: store.queries().length,
        reports: store.reports().length,
        historyEntries: store.history().length,
        openTabs: workspace.tabs.length,
        archivedWorkspaces: workspace.archivedWorkspaces.length,
      },
      connectionCounts: {
        connected: connectionCounts.connected,
        connecting: connectionCounts.connecting,
        reconnecting: connectionCounts.reconnecting,
        degraded: connectionCounts.degraded,
        authenticationFailed: connectionCounts['authentication-failed'],
        disconnected: connectionCounts.disconnected,
        failed: connectionCounts.failed,
      },
      secureStorage,
    })
  }
  const handlers: {
    [K in keyof typeof ipcSchemas]: (input: z.infer<(typeof ipcSchemas)[K]>) => unknown | Promise<unknown>
  } = {
    seriesCatalog: input => seriesService(input.connectionId).catalog(input),
    seriesInspect: input => seriesService(input.connectionId).inspect(input),
    seriesQuery: input => seriesService(input.connectionId).query(input),
    seriesCancel: input => seriesService(input.connectionId).cancel(input),
    vectorCollections: (id) => {
      if (!vectors) throw new Error('Vector database support is unavailable in this runtime.')
      return vectors.collections(id)
    },
    vectorSearch: (input) => {
      if (!vectors) throw new Error('Vector database support is unavailable in this runtime.')
      return vectors.search(input)
    },
    vectorMutate: (input) => {
      if (!vectors) throw new Error('Vector database support is unavailable in this runtime.')
      return vectors.mutate(input)
    },
    vectorCancel: (input) => {
      if (!vectors) throw new Error('Vector database support is unavailable in this runtime.')
      return vectors.cancel(input.connectionId, input.requestId)
    },
    listAutomations: () => automation.list(),
    saveAutomation: (input) => {
      const profile = store.profile(input.target.connectionId)
      if (input.enabled && profile.environment.toLowerCase() === 'production')
        throw new Error('Production reusable tasks cannot be enabled. Keep this definition disabled and run the underlying workflow manually after review.')
      if (input.target.kind === 'report') {
        const target = input.target
        const report = store.reports().find((item) => item.id === target.reportId)
        if (!report || report.connectionId !== profile.id) throw new Error('Choose a saved report bound to the visible target.')
      }
      if (input.target.kind === 'export' && !engineSupports(profile.engine, 'streamExport'))
        throw new Error('Choose a target that supports reviewed streaming exports.')
      if (
        input.target.kind === 'import' &&
        !['postgres', 'mariadb', 'mysql', 'sqlite', 'duckdb', 'clickhouse', 'oracle'].includes(profile.engine)
      )
        throw new Error('Choose a target that supports reviewed file imports.')
      return automation.save(input)
    },
    deleteAutomation: (id) => automation.delete(id),
    chooseAutomationDirectory: async () => {
      const selected = await dialog.showOpenDialog(window, { title: 'Choose the explicit reusable export destination', properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return null
      const path = await realpath(selected.filePaths[0])
      if (!(await stat(path)).isDirectory()) throw new Error('Choose one existing export directory.')
      return path
    },
    previewAutomationImport: async (id) => {
      if (!imports) throw new Error('Import service is unavailable.')
      const task = store.automations().find((item) => item.id === id)
      if (!task || task.target.kind !== 'import') throw new Error('Choose a reusable import task.')
      const selected = await dialog.showOpenDialog(window, { title: 'Choose and freshly review the import source', properties: ['openFile'], filters: [{ name: task.target.options.format.toUpperCase(), extensions: [task.target.options.format === 'jsonl' ? 'jsonl' : 'csv'] }] })
      if (selected.canceled || !selected.filePaths[0]) return null
      const preview = await imports.previewImport(task.target.options, selected.filePaths[0])
      automationImportGrants.set(id, { sourceId: preview.sourceId, context: automationImportContext(task), expires: Date.now() + 30 * 60_000 })
      return preview
    },
    runAutomation: async (input) => {
      const reviewedImport = input.sourceId && input.consentBatchCommits && input.consentNonTransactionalAppend
        ? {
            sourceId: input.sourceId,
            consentBatchCommits: input.consentBatchCommits,
            consentNonTransactionalAppend: input.consentNonTransactionalAppend,
          }
        : undefined
      if (input.sourceId && !reviewedImport)
        throw new Error('Fresh import execution requires explicit batch-commit and non-transactional append consent.')
      const completion = automation.run(input.id, 'manual', reviewedImport)
      await new Promise((resolve) => setImmediate(resolve))
      const running = automation
        .list()
        .runs.find((run) => run.taskId === input.id && run.state === 'running')
      return running || completion
    },
    cancelAutomation: (id) => automation.cancel(id),
    previewAssistance: (input) => assistance.preview(input),
    startAssistance: async (input) => {
      try {
        return await assistance.run(input)
      } catch (error) {
        throw new Error(credentials.sanitize(error, { password: input.apiKey }))
      }
    },
    cancelAssistance: (input) => assistance.cancel(input.requestId),
    exportSchemaDiagram: async (input) => {
      const svg = diagramSvg(input)
      const result = await dialog.showSaveDialog(window, { title: 'Export inspected relationships', defaultPath: 'harbor-relationships.svg', filters: [{ name: 'SVG diagram', extensions: ['svg'] }] })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await writeFile(result.filePath, svg, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { cancelled: false, path: result.filePath }
    },
    previewSchemaChange: (input) => schemaChanges.preview(input),
    inspectSqlAdministration: (input) => sqlAdministration.inspect(input),
    previewSqlAdministration: (input) => sqlAdministration.preview(input),
    executeSqlAdministration: (input) => sqlAdministration.execute(input),
    executeSchemaChange: (input) => schemaChanges.execute(input),
    compareSchemas: (input) => schemaChanges.compare(input),
    exportWorkspaceHandoff: async (input) => {
      const text = handoffs.export(input)
      const result = await dialog.showSaveDialog(window, {
        title: 'Export reviewed workspace handoff',
        defaultPath: 'harbor-workspace.json',
        filters: [{ name: 'Harbor workspace JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      // Never overwrite an unrelated file, even if the platform dialog allowed it.
      await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return { cancelled: false, path: result.filePath }
    },
    previewWorkspaceHandoff: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Preview workspace handoff before importing',
        properties: ['openFile'],
        filters: [{ name: 'Harbor workspace JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return handoffs.preview(await checkedFile(result.filePaths[0], MAX_HANDOFF_BYTES))
    },
    importWorkspaceHandoff: (input) => handoffs.import(input),
    saveReport: (input) => store.saveReport(input),
    deleteReport: (id) => store.deleteReport(id),
    warehouseProgress: (input) => {
      const engine = store.profile(input.connectionId).engine
      if (!warehouses || (engine !== 'snowflake' && engine !== 'databricks')) throw new Error('Choose a connected Snowflake or Databricks profile.')
      return warehouses[engine].progress(input)
    },
    athenaProgress: (input) => {
      if (store.profile(input.connectionId).engine !== 'athena' || !athena) throw new Error('Choose a connected Athena profile.')
      return athena.progress(input)
    },
    bigQueryEstimate: (input) => {
      if (store.profile(input.connectionId).engine !== 'bigquery' || !bigquery) throw new Error('Choose a connected BigQuery profile.')
      return bigquery.estimate(input)
    },
    bigQueryProgress: (input) => {
      if (store.profile(input.connectionId).engine !== 'bigquery' || !bigquery) throw new Error('Choose a connected BigQuery profile.')
      return bigquery.progress(input)
    },
    trinoProgress: (input) => {
      if (store.profile(input.connectionId).engine !== 'trino' || !trino) throw new Error('Choose a connected Trino profile.')
      return trino.progress(input)
    },
    previewDatabaseTransfer: (input) => {
      if (!databaseTransfers) throw new Error('Database transfer service is unavailable.')
      return databaseTransfers.preview(input)
    },
    startDatabaseTransfer: (input) => {
      if (!databaseTransfers) throw new Error('Database transfer service is unavailable.')
      return databaseTransfers.start(input)
    },
    getDatabaseTransferJob: (id) => {
      if (!databaseTransfers) throw new Error('Database transfer service is unavailable.')
      return databaseTransfers.get(id)
    },
    cancelDatabaseTransferJob: (id) => {
      if (!databaseTransfers) throw new Error('Database transfer service is unavailable.')
      return databaseTransfers.cancel(id)
    },
    chooseBackupTool: async (kind) => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      const selected = await dialog.showOpenDialog(window, { title: `Select a trusted ${kind} executable`, properties: ['openFile'] })
      if (selected.canceled || !selected.filePaths[0]) return null
      return nativeBackups.chooseTool(selected.filePaths[0], kind)
    },
    chooseBackupArchive: async () => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      const selected = await dialog.showOpenDialog(window, { title: 'Select a trusted PostgreSQL custom archive', properties: ['openFile'] })
      if (selected.canceled || !selected.filePaths[0]) return null
      return nativeBackups.chooseArchive(selected.filePaths[0])
    },
    previewNativeBackup: (input) => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      return nativeBackups.preview(input)
    },
    startNativeBackup: async (input) => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      if (nativeBackups.previewMode(input.token) === 'restore') return nativeBackups.start(input)
      const selected = await dialog.showSaveDialog(window, { title: 'Save a new PostgreSQL custom archive', defaultPath: 'harbor-backup.dump', filters: [{ name: 'PostgreSQL custom archive', extensions: ['dump'] }] })
      if (selected.canceled || !selected.filePath) return null
      return nativeBackups.start(input, selected.filePath)
    },
    getNativeBackupJob: (id) => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      return nativeBackups.getJob(id)
    },
    cancelNativeBackupJob: (id) => {
      if (!nativeBackups) throw new Error('Native backup service is unavailable.')
      return nativeBackups.cancelJob(id)
    },
    chooseImportFile: async ({ target, options }) => {
      const profile = store.profile(target.connectionId)
      if (!imports || !['postgres', 'mariadb', 'mysql', 'sqlite', 'duckdb', 'clickhouse', 'oracle'].includes(profile.engine))
        throw new Error('File import is unavailable for this engine in this runtime.')
      if (profile.readOnly || service(profile).status(profile.id).state !== 'connected')
        throw new Error('Choose a connected writable target before importing.')
      const result = await dialog.showOpenDialog(window, {
        title: `Preview import into ${profile.name} · ${target.schema}.${target.table}`,
        properties: ['openFile'],
        filters: [
          {
            name: options.format.toUpperCase(),
            extensions: options.format === 'csv' ? ['csv', 'tsv', 'txt'] : ['jsonl', 'ndjson'],
          },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const path = await realpath(result.filePaths[0]),
        info = await stat(path)
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const metadata = await stat(store.path + suffix).catch(() => undefined)
        if (metadata && metadata.dev === info.dev && metadata.ino === info.ino)
          throw new Error('Harbor metadata cannot be imported as data.')
      }
      if (executionContext(store.profile(profile.id)) !== executionContext(profile))
        throw new Error('The connection target changed. Choose the file again.')
      const preview = await imports.previewImport(options, path)
      if (executionContext(store.profile(profile.id)) !== executionContext(profile)) {
        imports.discardSource(preview.sourceId)
        throw new Error('The connection target changed during preview. Choose the file again.')
      }
      for (const [id, grant] of importGrants) if (grant.expires < Date.now()) importGrants.delete(id)
      if (importGrants.size >= 20) importGrants.delete(importGrants.keys().next().value!)
      importGrants.set(preview.sourceId, {
        target: importTargetKey(target),
        context: executionContext(profile),
        expires: Date.now() + 30 * 60 * 1000,
      })
      return preview
    },
    startImportJob: (input) =>
      serial(input.connectionId, async () => {
        if (!imports) throw new Error('Import service is unavailable.')
        const grant = importGrants.get(input.sourceId)
        importGrants.delete(input.sourceId)
        if (
          !grant ||
          grant.expires < Date.now() ||
          grant.target !== importTargetKey(input) ||
          grant.context !== executionContext(store.profile(input.connectionId))
        ) {
          imports.discardSource(input.sourceId)
          throw new Error('The import target or source preview changed. Choose and review the file again.')
        }
        return imports.startImport(input)
      }),
    importJob: (id) => {
      if (!imports) throw new Error('Import service is unavailable.')
      return imports.getJob(id)
    },
    cancelImportJob: (id) => {
      if (!imports) throw new Error('Import service is unavailable.')
      return imports.cancelJob(id)
    },
    inspectObject: async (input) => {
      const profile = store.profile(input.connectionId)
      if (profile.engine === 'clickhouse' && clickhouse) return clickhouse.inspectObject(input)
      if (profile.engine === 'oracle' && oracle) return oracle.inspectObject(input)
      if (['sqlite', 'duckdb', 'mssql'].includes(profile.engine) && ['table', 'view'].includes(input.kind)) {
        const structure = await relational(profile.id).structure({
          connectionId: profile.id,
          database: input.database,
          schema: input.schema,
          table: input.name,
        })
        return {
          structure,
          properties: [
            { name: 'Kind', value: input.kind },
            { name: 'Namespace', value: input.schema },
          ],
          definition: { text: structure.ddl, source: profile.engine === 'sqlite' ? 'server' : 'summary' },
          warnings: [],
        }
      }
      requireServerSql(input.connectionId)
      return sql.inspectObject(input)
    },
    explainQuery: (input) => {
      if (store.profile(input.connectionId).engine === 'clickhouse' && clickhouse) return clickhouse.explain(input)
      requireServerSql(input.connectionId)
      return sql.explainQuery(input)
    },
    diagnostics: (input) => {
      requireServerSql(input.connectionId)
      return sql.diagnostics(input)
    },
    copyText: (text) => {
      clipboard.writeText(text)
    },
    capabilities: (id) => {
      const profile = store.profile(id)
      return capabilitiesFor(profile, service(profile).status(id))
    },
    chooseAnalyticsFile: async (input) => {
      if (store.profile(input.connectionId).engine !== 'duckdb' || !duckdb)
        throw new Error('Choose a DuckDB connection.')
      const result = await dialog.showOpenDialog(window, {
        title: 'Allow one local data file for this DuckDB connection',
        properties: ['openFile'],
        filters: [
          {
            name: input.format.toUpperCase(),
            extensions: input.format === 'json' ? ['json', 'jsonl', 'ndjson'] : [input.format],
          },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const path = await realpath(result.filePaths[0]),
        info = await stat(path)
      if (!info.isFile()) throw new Error('Choose one regular local data file.')
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const metadata = await stat(store.path + suffix).catch(() => undefined)
        if (metadata && metadata.dev === info.dev && metadata.ino === info.ino)
          throw new Error('Harbor metadata cannot be explored as data.')
      }
      for (const [token, record] of fileGrants) if (record.expires < Date.now()) fileGrants.delete(token)
      if (fileGrants.size >= 32) fileGrants.delete(fileGrants.keys().next().value!)
      const token = randomUUID()
      fileGrants.set(token, {
        connectionId: input.connectionId,
        grant: { path, device: info.dev, inode: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, format: input.format },
        expires: Date.now() + 15 * 60 * 1000,
      })
      return { token, name: basename(path), bytes: info.size, format: input.format }
    },
    previewAnalyticsFile: (input) => {
      const grant = grantedFile(input.connectionId, input.token)
      return duckdb!.previewFile({ ...input, grant, maxRows: 200 })
    },
    importAnalyticsFile: (input) => {
      const grant = grantedFile(input.connectionId, input.token)
      if (input.confirm !== `${input.schema}.${input.table}`)
        throw new Error('Review and type the exact new table target before importing.')
      return duckdb!.importFile({ ...input, grant })
    },
    startFullExport: async (input) => {
      const profile = store.profile(input.connectionId)
      if (
        !engineSupports(profile.engine, 'streamExport') ||
        !transfers
      )
        throw new Error('Full streaming export is not available for this engine in this runtime.')
      if (service(profile).status(profile.id).state !== 'connected')
        throw new Error('Connect this target before exporting.')
      const result = await dialog.showSaveDialog(window, {
        title: `Full read-only query export · ${profile.name}`,
        defaultPath: `harbor-full-result.${input.format}`,
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
      })
      if (result.canceled || !result.filePath) return null
      if (executionContext(store.profile(profile.id)) !== executionContext(profile))
        throw new Error('The connection target changed during review. Review the export again.')
      return transfers.startExport(input, result.filePath)
    },
    exportJob: (jobId) => {
      if (!transfers) throw new Error('Transfer service is unavailable.')
      const snapshot = transfers.getJob(jobId)
      return {
        ...snapshot,
        ...(snapshot.error ? { error: credentials.sanitize(new Error(snapshot.error)) } : {}),
      }
    },
    cancelExportJob: (jobId) => {
      if (!transfers) throw new Error('Transfer service is unavailable.')
      return transfers.cancelJob(jobId)
    },
    chooseDatabaseFile: async (mode) => {
      const filters = [
        { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] },
      ]
      if (mode === 'create') {
        const result = await dialog.showSaveDialog(window, { title: 'Create a new SQLite database', filters })
        return result.canceled ? null : result.filePath || null
      }
      const result = await dialog.showOpenDialog(window, {
        title: 'Open an existing SQLite database',
        properties: ['openFile'],
        filters,
      })
      return result.canceled ? null : result.filePaths[0] || null
    },
    cqlKeyspaces: id => cqlService(id).keyspaces(id),
    cqlTables: input => cqlService(input.connectionId).tables(input),
    cqlStructure: input => cqlService(input.connectionId).structure(input),
    cqlExecute: input => {if(input.mode==='mutation'&&store.profile(input.connectionId).readOnly) throw new Error('This CQL profile is read-only.');return cqlService(input.connectionId).execute(input)},
    cqlNext: input => cqlService(input.connectionId).next(input),
    cqlCancel: input => cqlService(input.connectionId).cancel(input),
    dynamoTables: input => dynamoService(input.connectionId).tables(input),
    dynamoTable: input => dynamoService(input.connectionId).table(input),
    dynamoRead: input => dynamoService(input.connectionId).read(input),
    dynamoNext: input => dynamoService(input.connectionId).next(input),
    dynamoMutate: input => { if(store.profile(input.connectionId).readOnly) throw new Error('This DynamoDB profile is read-only.'); return dynamoService(input.connectionId).mutate(input) },
    dynamoCancel: input => dynamoService(input.connectionId).cancel(input),
    neoDatabases: id => neoService(id).databases(id),
    neoQuery: input => { if (input.mode === 'mutation' && store.profile(input.connectionId).readOnly) throw new Error('This Neo4j profile is read-only.'); return neoService(input.connectionId).query(input) },
    neoNext: input => neoService(input.connectionId).next(input),
    neoCancel: input => neoService(input.connectionId).cancel(input),
    couchDatabases: id => couchService(id).databases(id),
    couchRead: input => couchService(input.connectionId).read(input),
    couchDocument: input => couchService(input.connectionId).document(input),
    couchMutate: input => { if (store.profile(input.connectionId).readOnly) throw new Error('This CouchDB profile is read-only.'); return couchService(input.connectionId).mutate(input) },
    couchCancel: input => couchService(input.connectionId).cancel(input),
    mongoDatabases: (id) => {
      // MongoDB and CouchDB use separate native document APIs.
      requireMongo(id)
      return mongo.databases(id)
    },
    searchCatalog: (input) => searchService(input.connectionId).catalog(input),
    searchMappings: (input) => searchService(input.connectionId).mappings(input),
    searchRead: (input) => searchService(input.connectionId).search(input),
    searchDocument: (input) => searchService(input.connectionId).document(input),
    searchMutate: (input) => {
      if (store.profile(input.connectionId).readOnly) throw new Error('This connection is read-only. Deliberately enable writes in the connection settings first.')
      return searchService(input.connectionId).mutate(input)
    },
    searchCloseCursor: (input) => searchService(input.connectionId).closeCursor(input),
    searchCancel: (input) => searchService(input.connectionId).cancel(input),
    mongoCollections: (input) => {
      requireMongo(input.connectionId)
      return mongo.collections(input)
    },
    mongoRead: (input) => {
      requireMongo(input.connectionId)
      return mongo.read(input)
    },
    mongoTopology: (id) => { requireMongo(id); return mongo.topology(id) },
    chooseMongoImport: async (target) => {
      requireMongo(target.connectionId)
      if (!mongoFiles) throw new Error('MongoDB file transfers are unavailable.')
      const profile = store.profile(target.connectionId)
      if (profile.readOnly || mongo.status(profile.id).state !== 'connected') throw new Error('Choose a connected writable MongoDB profile.')
      const selected = await dialog.showOpenDialog(window, {title: `Preview Extended JSON import · ${profile.name} · ${target.database}.${target.collection}`, properties: ['openFile'], filters: [{name: 'BSON Extended JSON lines', extensions: ['jsonl', 'ndjson', 'ejson']}]})
      if (selected.canceled || !selected.filePaths[0]) return null
      if (executionContext(store.profile(profile.id)) !== executionContext(profile)) throw new Error('The connection changed during file selection.')
      const path = await realpath(selected.filePaths[0]), info = await stat(path)
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const metadata = await stat(store.path + suffix).catch(() => undefined)
        if (metadata && metadata.dev === info.dev && metadata.ino === info.ino) throw new Error('Harbor metadata cannot be imported as documents.')
      }
      return mongoFiles.previewImport(target, path)
    },
    startMongoImport: input => {
      if (!mongoFiles) throw new Error('MongoDB file transfers are unavailable.')
      return mongoFiles.startImport(input)
    },
    startMongoExport: async input => {
      requireMongo(input.connectionId)
      if (!mongoFiles) throw new Error('MongoDB file transfers are unavailable.')
      const profile = store.profile(input.connectionId)
      if (mongo.status(profile.id).state !== 'connected') throw new Error('Connect before exporting MongoDB documents.')
      const selected = await dialog.showSaveDialog(window, {title: `Export Extended JSON · ${profile.name} · ${input.database}.${input.collection}`, defaultPath: 'harbor-documents.jsonl', filters: [{name: 'BSON Extended JSON lines', extensions: ['jsonl']}]})
      if (selected.canceled || !selected.filePath) return null
      if (executionContext(store.profile(profile.id)) !== executionContext(profile)) throw new Error('The connection changed during file selection.')
      return mongoFiles.startExport(input, selected.filePath)
    },
    mongoFileJob: id => {
      if (!mongoFiles) throw new Error('MongoDB file transfers are unavailable.')
      return mongoFiles.getJob(id)
    },
    cancelMongoFileJob: id => {
      if (!mongoFiles) throw new Error('MongoDB file transfers are unavailable.')
      return mongoFiles.cancelJob(id)
    },
    mongoIndexes: (input) => { requireMongo(input.connectionId); return mongo.indexes(input) },
    mongoIndexPreview: (input) => { requireMongo(input.connectionId); return mongo.previewIndex(input) },
    mongoIndexExecute: (input) => {
      requireMongo(input.connectionId)
      if (store.profile(input.connectionId).readOnly) throw new Error('This MongoDB profile is read-only. Index administration requires explicitly enabled writes.')
      return mongo.executeIndex(input)
    },
    mongoWrite: (input) => {
      requireMongo(input.connectionId)
      return mongo.write(input)
    },
    bootstrap: () => ({
      profiles: store.profiles(),
      workspace: store.workspace(),
      reports: store.reports(),
      savedQueries: store.queries(),
      history: store.history(),
      secureStorage: credentials.status(),
      version: app.getVersion(),
      platform: process.platform,
    }),
    saveProfile: (input) =>
      serial(input.profile.id, async () => {
        const existing = store.hasProfile(input.profile.id) ? store.profile(input.profile.id) : undefined
        const profile = { ...input.profile }
        if (
          profile.environment.toLowerCase() === 'production' &&
          existing?.environment.toLowerCase() !== 'production'
        )
          profile.readOnly = true
        const prepared = credentials.prepare(profile.id, input.secrets, input.rememberPassword)
        // Organization changes preserve live transactions; execution/credential changes never reuse sessions.
        const credentialsChanged =
          !!Object.keys(input.secrets || {}).length ||
          (!!existing &&
            !input.rememberPassword &&
            (existing.hasPassword || existing.hasSshPassword || existing.hasPassphrase))
        const contextChanged =
          existing && (executionContext(existing) !== executionContext(profile) || credentialsChanged)
        if (contextChanged) {
          await transfers?.cancelForConnection(existing.id)
          await imports?.cancelForConnection(existing.id)
          await databaseTransfers?.cancelForConnection(existing.id)
          await nativeBackups?.cancelForConnection(existing.id)
          await mongoFiles?.cancelForConnection(existing.id)
          await service(existing).disconnect(existing.id)
        }
        store.transaction(() => {
          store.saveProfile(profile)
          if (prepared.remove) store.deleteCredential(profile.id)
          if (prepared.credential) store.writeCredential(profile.id, prepared.credential)
        })
        if (contextChanged) credentials.clearSession(profile.id)
        credentials.rememberSession(profile.id, prepared.session)
        return store.profile(profile.id)
      }),
    deleteProfile: (connectionId) =>
      serial(connectionId, async () => {
        const profile = store.profile(connectionId)
        await transfers?.cancelForConnection(connectionId)
        await imports?.cancelForConnection(connectionId)
        await databaseTransfers?.cancelForConnection(connectionId)
        await nativeBackups?.cancelForConnection(connectionId)
          await mongoFiles?.cancelForConnection(connectionId)
        await service(profile).disconnect(connectionId)
        store.deleteProfile(connectionId)
        credentials.clearSession(connectionId)
      }),
    forgetPassword: (connectionId) => {
      store.profile(connectionId)
      credentials.forget(connectionId)
    },
    testConnection: test,
    connect: (input) =>
      serial(input.id, async () => {
        const profile = store.profile(input.id)
        let secret: Secrets | undefined
        try {
          secret = credentials.resolve(input.id, input.secrets)
          const result = await service(profile).connect(profile, secret)
          if (result.state === 'connected' && profile.engine === 'sqlite' && profile.sqlite.mode === 'create')
            store.saveProfile({ ...profile, sqlite: { ...profile.sqlite, mode: 'open' } })
          if (result.state === 'connected' && profile.engine === 'duckdb' && profile.duckdb.mode === 'create')
            store.saveProfile({ ...profile, duckdb: { ...profile.duckdb, mode: 'open' } })
          return result
        } catch (error) {
          const status = service(profile).status(input.id)
          return {
            ...status,
            state: status.state === 'authentication-failed' ? status.state : ('failed' as const),
            error: credentials.sanitize(error, secret || input.secrets),
          }
        } finally {
          secret = undefined
        }
      }),
    disconnect: (connectionId) =>
      serial(connectionId, async () => {
        await transfers?.cancelForConnection(connectionId)
        await imports?.cancelForConnection(connectionId)
        await databaseTransfers?.cancelForConnection(connectionId)
        await nativeBackups?.cancelForConnection(connectionId)
          await mongoFiles?.cancelForConnection(connectionId)
        await service(store.profile(connectionId)).disconnect(connectionId)
        credentials.clearSession(connectionId)
      }),
    status: (connectionId) => service(store.profile(connectionId)).status(connectionId),
    saveWorkspace: (input) => {
      store.saveWorkspace(input)
      store.pruneHistory()
    },
    listObjects: (input) => {
      requireSql(input.connectionId)
      return relational(input.connectionId).listObjects(managedCatalogTarget(store.profile(input.connectionId), input))
    },
    listDatabases: (connectionId) => {
      requireSql(connectionId)
      const profile = store.profile(connectionId)
      if (profile.managed.provider !== 'none') {
        if (service(profile).status(connectionId).state !== 'connected') throw new Error('Connect before browsing this managed database.')
        return Promise.resolve([profile.database])
      }
      return relational(connectionId).listDatabases(connectionId)
    },
    structure: (input) => {
      requireSql(input.connectionId)
      return relational(input.connectionId).structure(input)
    },
    query: async (input) => {
      const profile = store.profile(input.connectionId)
      if (input.parameters?.length && !engineSupports(profile.engine, 'parameters'))
        throw new Error('This engine does not support SQL value parameters. Use its native workflow.')
      if (profile.engine === 'mongodb') throw new Error('Use the MongoDB document browser for JSON queries.')
      const start = performance.now()
      try {
        const result = await (isKeyValueEngine(profile.engine) ? redis : relational(input.connectionId)).execute(
          input,
        )
        store.addHistory(
          {
            connectionId: input.connectionId,
            ...(input.database ? { database: input.database } : {}),
            sql: input.sql,
            executedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            rowCount: result.sets.reduce((sum, set) => sum + set.rows.length, 0),
            success: !result.cancelled,
            ...(result.cancelled
              ? {
                  error:
                    'Cancelled: the server confirmed cancellation. Earlier script statements may already have committed.',
                }
              : {}),
          },
          input.privateSession,
        )
        return result
      } catch (error) {
        const message =
          redactHistory(input.sql) === input.sql
            ? credentials.sanitize(error)
            : 'Credential-bearing command failed. Check authentication and connection settings.'
        store.addHistory(
          {
            connectionId: input.connectionId,
            ...(input.database ? { database: input.database } : {}),
            sql: input.sql,
            executedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - start),
            rowCount: 0,
            success: false,
            error: message,
          },
          input.privateSession,
        )
        throw new Error(message)
      }
    },
    cancel: (input) => {
      if (['elasticsearch', 'opensearch'].includes(store.profile(input.connectionId).engine)) return searchService(input.connectionId).cancel(input)
      if (store.profile(input.connectionId).engine === 'mongodb')
        return { requested: false, message: 'MongoDB queries are bounded by the connection timeout.' }
      if (isKeyValueEngine(store.profile(input.connectionId).engine))
        return {
          requested: false,
          message:
            'Redis commands cannot be cancelled safely after dispatch. Stop loading to cancel continued scanning.',
        }
      return relational(input.connectionId).cancel(input)
    },
    transaction: (input) => {
      requireSql(input.connectionId)
      registry.requireCapability(store.profile(input.connectionId).engine, 'transactions')
      return relational(input.connectionId).transaction!(input)
    },
    closeSession: (input) => {
      if(store.profile(input.connectionId).engine==='cassandra')return cqlService(input.connectionId).closeSession(input)
      if (['influxdb','questdb'].includes(store.profile(input.connectionId).engine)) return seriesService(input.connectionId).closeSession(input)
      if (store.profile(input.connectionId).engine === 'dynamodb') return dynamoService(input.connectionId).closeSession(input)
      if (store.profile(input.connectionId).engine === 'neo4j') return neoService(input.connectionId).closeSession(input)
      if (store.profile(input.connectionId).engine === 'couchdb') return couchService(input.connectionId).closeSession(input)
      if (['elasticsearch', 'opensearch'].includes(store.profile(input.connectionId).engine)) return searchService(input.connectionId).closeSession(input)
      if (engineSupports(store.profile(input.connectionId).engine, 'sql'))
        return relational(input.connectionId).closeSession(input)
    },
    getSessionState: (input) => {
      if (['elasticsearch', 'opensearch'].includes(store.profile(input.connectionId).engine)) return searchService(input.connectionId).getSessionState(input)
      if (['redis', 'mongodb', 'couchdb', 'neo4j', 'dynamodb', 'influxdb','questdb','cassandra'].includes(store.profile(input.connectionId).engine))
        return {
          state: 'idle',
          connected:
            service(store.profile(input.connectionId)).status(input.connectionId).state === 'connected',
          running: false,
        }
      return relational(input.connectionId).getSessionState(input)
    },
    table: (input) => {
      requireSql(input.connectionId)
      return relational(input.connectionId).table(input)
    },
    applyEdits: (input) => {
      requireSql(input.connectionId)
      if (store.profile(input.connectionId).readOnly)
        throw new Error(
          'This connection is in guarded browsing mode. Edit the connection to deliberately enable writes.',
        )
      registry.requireCapability(store.profile(input.connectionId).engine, 'rowEdits')
      return relational(input.connectionId).applyEdits!(input)
    },
    redisTopology: (input) => { requireRedis(input); return redis.topology(input) },
    redisStreamGroups: (input) => { requireRedis(input.connectionId); return redis.streamGroups(input) },
    redisSubscribe: (input) => { requireRedis(input.connectionId); return redis.subscribe(input) },
    redisSubscription: (input) => redis.subscription(input),
    redisStopSubscription: (input) => redis.stopSubscription(input),
    redisScan: (input) => {
      requireRedis(input.connectionId)
      return redis.scan(input)
    },
    redisInspect: (input) => {
      requireRedis(input.connectionId)
      return redis.inspect(input)
    },
    redisMutate: (input) => {
      requireRedis(input.connectionId)
      if (store.profile(input.connectionId).readOnly)
        throw new Error(
          'This connection is in guarded browsing mode. Edit the connection to deliberately enable writes.',
        )
      return redis.mutate(input)
    },
    saveQuery: (input) => store.saveQuery({ ...input, updatedAt: new Date().toISOString() }),
    deleteQuery: (queryId) => store.deleteQuery(queryId),
    clearHistory: () => store.clearHistory(),
    clearDrafts: () => store.clearDrafts(),
    previewDiagnosticBundle: () => diagnosticBundle(),
    exportDiagnosticBundle: async (input) => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export the reviewed privacy-safe diagnostic bundle',
        defaultPath: 'harbor-diagnostics.json',
        filters: [{ name: 'Harbor diagnostic bundle', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await writeFile(result.filePath, serializeDiagnosticBundle(input), {
        encoding: 'utf8',
        mode: 0o600,
      })
      return { cancelled: false, path: result.filePath }
    },
    exportProfiles: async () => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export connection metadata — passwords excluded',
        defaultPath: 'harbor-connections.json',
        filters: [{ name: 'Harbor connection metadata', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await writeFile(result.filePath, store.exportProfiles(), { encoding: 'utf8', mode: 0o600 })
      return { cancelled: false, path: result.filePath }
    },
    previewImport: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Preview connection metadata import',
        properties: ['openFile'],
        filters: [{ name: 'Harbor connection metadata', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return store.previewImport(JSON.parse(await checkedFile(result.filePaths[0], 16000000)))
    },
    importProfiles: (input) => store.importProfiles(input),
    exportResults: async (input) => {
      if (input.rows.some((row) => row.length !== input.columns.length))
        throw new Error('Result rows must match the ordered column metadata.')
      let size = 0
      for (const row of input.rows)
        for (const value of row) {
          size +=
            typeof value === 'string'
              ? value.length * 2
              : value && typeof value === 'object'
                ? value.base64.length * 2
                : 16
          if (size > 32000000)
            throw new Error(
              'Loaded export exceeds 32 MB. Export a smaller selection or lower the result limit.',
            )
        }
      const result = await dialog.showSaveDialog(window, {
        title: `Export ${input.scope} — ${input.rows.length} rows`,
        defaultPath: `harbor-results.${input.format}`,
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      await exportLoadedData(result.filePath, input)
      return { cancelled: false, path: result.filePath }
    },
    importSql: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Open SQL without executing',
        properties: ['openFile'],
        filters: [{ name: 'SQL query', extensions: ['sql'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return { name: basename(result.filePaths[0]), sql: await checkedFile(result.filePaths[0], 1000000) }
    },
    exportSql: async (input) => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export saved query',
        defaultPath: `${input.name.replace(/[\\/:*?"<>|]/g, '-').replace(/\.sql$/i, '')}.sql`,
        filters: [{ name: 'SQL query', extensions: ['sql'] }],
      })
      if (!result.canceled && result.filePath)
        await writeFile(result.filePath, input.sql, { encoding: 'utf8', mode: 0o600 })
    },
    setZoom: (value) => window.webContents.setZoomFactor(value),
    readyToClose: () => {
      setImmediate(() => {
        void finishShutdown()
      })
    },
  }
  for (const [name, schema] of Object.entries(ipcSchemas)) {
    ipcMain.handle(`harbor:${name}`, async (event, input: unknown) => {
      if (!isTrustedSender(event, window, expectedUrl))
        throw new Error('This request did not originate from the trusted Harbor DB application frame.')
      const parsed = schema.safeParse(input)
      if (!parsed.success)
        throw new Error(
          `Invalid ${name} request: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'payload'} ${issue.message}`)
            .join('; ')
            .slice(0, 1200)}`,
        )
      try {
        assertManagedIpcTargets(parsed.data, (id) => store.profile(id))
        return await (handlers[name as keyof typeof handlers] as (input: unknown) => unknown)(parsed.data)
      } catch (error) {
        throw new Error(credentials.sanitize(error))
      }
    })
  }
  return () => {
    automation.close()
    assistance.close()
    for (const name of Object.keys(ipcSchemas)) ipcMain.removeHandler(`harbor:${name}`)
  }
}
