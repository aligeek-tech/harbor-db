import type { ConnectionProfile, ConnectionStatus, Engine } from './contracts'

export type DataModel = 'relational' | 'document' | 'key-value' | 'search' | 'graph' | 'vector' | 'time-series' | 'wide-column'
export type Capability =
  | 'catalog'
  | 'sql'
  | 'parameters'
  | 'transactions'
  | 'rowEdits'
  | 'documents'
  | 'keys'
  | 'streamExport'
  | 'cancel'
  | 'search'
  | 'vectors'
  | 'timeSeries'
export type CapabilityState =
  'supported' | 'unsupported' | 'permission-denied' | 'topology-unavailable' | 'disconnected' | 'guarded'
export interface CapabilityResult {
  state: CapabilityState
  reason?: string
}
export interface EngineDefinition {
  name: string
  model: DataModel
  capabilities: readonly Capability[]
}

// Only implemented operations belong here. A compatible wire protocol is not a
// registration for another product, and unsupported controls stay explicit.
export const engineDefinitions: Record<Engine, EngineDefinition> = {
  db2: {name:'IBM Db2 LUW',model:'relational',capabilities:['catalog','sql','parameters','streamExport','cancel']},
  influxdb: { name: 'InfluxDB 2 Flux', model: 'time-series', capabilities: ['catalog','timeSeries','cancel'] },
  questdb: { name: 'QuestDB', model: 'time-series', capabilities: ['catalog','timeSeries','cancel'] },
  cassandra: {name:'Cassandra',model:'wide-column',capabilities:['catalog','parameters','cancel']},
  dynamodb: { name: 'DynamoDB', model: 'document', capabilities: ['catalog', 'documents', 'cancel'] },
  qdrant: { name: 'Qdrant', model: 'vector', capabilities: ['catalog', 'vectors', 'search', 'rowEdits', 'cancel'] },
  milvus: { name: 'Milvus', model: 'vector', capabilities: ['catalog', 'vectors', 'search', 'rowEdits', 'cancel'] },
  weaviate: { name: 'Weaviate', model: 'vector', capabilities: ['catalog', 'vectors', 'search', 'rowEdits', 'cancel'] },
  pinecone: { name: 'Pinecone', model: 'vector', capabilities: ['catalog', 'vectors', 'search', 'rowEdits', 'cancel'] },
  cockroachdb: { name: 'CockroachDB', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'streamExport', 'cancel'] },
  yugabytedb: { name: 'YugabyteDB YSQL', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'streamExport', 'cancel'] },
  tidb: { name: 'TiDB', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'streamExport', 'cancel'] },
  vitess: { name: 'Vitess', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'streamExport', 'cancel'] },
  redshift: { name: 'Amazon Redshift', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'streamExport', 'cancel'] },
  hana: { name: 'SAP HANA', model: 'relational', capabilities: ['catalog', 'sql', 'streamExport', 'cancel'] },
  neo4j: { name: 'Neo4j', model: 'graph', capabilities: ['catalog', 'parameters', 'cancel'] },
  firebird: { name: 'Firebird', model: 'relational', capabilities: ['catalog', 'sql', 'transactions', 'streamExport', 'cancel'] },
  couchdb: { name: 'CouchDB', model: 'document', capabilities: ['catalog', 'documents', 'cancel'] },
  snowflake: { name: 'Snowflake', model: 'relational', capabilities: ['catalog', 'sql', 'streamExport', 'cancel'] },
  databricks: { name: 'Databricks SQL', model: 'relational', capabilities: ['catalog', 'sql', 'cancel'] },
  athena: { name: 'Amazon Athena', model: 'relational', capabilities: ['catalog', 'sql', 'streamExport', 'cancel'] },
  bigquery: { name: 'BigQuery', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'streamExport', 'cancel'] },
  trino: { name: 'Trino', model: 'relational', capabilities: ['catalog', 'sql', 'streamExport', 'cancel'] },
  oracle: { name: 'Oracle Database', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'streamExport', 'cancel'] },
  elasticsearch: { name: 'Elasticsearch', model: 'search', capabilities: ['catalog', 'search', 'documents', 'cancel'] },
  opensearch: { name: 'OpenSearch', model: 'search', capabilities: ['catalog', 'search', 'documents', 'cancel'] },
  clickhouse: { name: 'ClickHouse', model: 'relational', capabilities: ['catalog', 'sql', 'parameters', 'streamExport', 'cancel'] },
  postgres: {
    name: 'PostgreSQL',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  mariadb: {
    name: 'MariaDB',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  mysql: {
    name: 'MySQL',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  sqlite: {
    name: 'SQLite',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  duckdb: {
    name: 'DuckDB',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  mssql: {
    name: 'SQL Server',
    model: 'relational',
    capabilities: ['catalog', 'sql', 'parameters', 'transactions', 'rowEdits', 'streamExport', 'cancel'],
  },
  mongodb: { name: 'MongoDB', model: 'document', capabilities: ['catalog', 'documents'] },
  redis: { name: 'Redis', model: 'key-value', capabilities: ['keys'] },
  valkey: { name: 'Valkey', model: 'key-value', capabilities: ['keys'] },
}

export function engineSupports(engine: Engine, capability: Capability): boolean {
  return engineDefinitions[engine].capabilities.includes(capability)
}

export function capabilitiesFor(
  profile: ConnectionProfile,
  status: ConnectionStatus,
  denied: Partial<Record<Capability, string>> = {},
  unavailableTopology: Partial<Record<Capability, string>> = {},
): Record<Capability, CapabilityResult> {
  const result = {} as Record<Capability, CapabilityResult>
  for (const capability of [
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
    'timeSeries',
  ] as const) {
    result[capability] = !engineSupports(profile.engine, capability)
      ? {
          state: 'unsupported',
          reason: `${engineDefinitions[profile.engine].name} does not provide this Harbor workflow.`,
        }
      : unavailableTopology[capability]
        ? { state: 'topology-unavailable', reason: unavailableTopology[capability] }
        : denied[capability]
          ? { state: 'permission-denied', reason: denied[capability] }
          : status.state !== 'connected'
            ? {
                state: 'disconnected',
                reason: `Connection is ${status.state}. Connect explicitly to continue.`,
              }
            : capability === 'rowEdits' && profile.readOnly
              ? { state: 'guarded', reason: 'This profile has guarded browsing enabled.' }
              : { state: 'supported', ...((profile.engine === 'elasticsearch' || profile.engine === 'opensearch') && capability === 'cancel' ? { reason: 'Stops waiting for the HTTP response. Server-side cancellation is not confirmed.' } : {}) }
  }
  return result
}

/** These engines bind every tab/query to an independent database or catalog. */
export function hasDatabaseContext(engine: Engine): boolean {
  return ['postgres', 'mssql', 'clickhouse', 'trino', 'bigquery', 'snowflake', 'databricks', 'athena', 'hana', 'cockroachdb', 'yugabytedb', 'tidb', 'vitess', 'redshift'].includes(engine)
}
