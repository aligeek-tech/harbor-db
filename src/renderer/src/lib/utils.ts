import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Cell, ConnectionProfile, Engine } from '@shared/contracts'
import { profileSchema } from '@shared/contracts'
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
export const engineNames: Record<Engine, string> = {
  db2:'IBM Db2 LUW',
  qdrant: 'Qdrant',
  milvus: 'Milvus',
  weaviate: 'Weaviate',
  pinecone: 'Pinecone',

  cockroachdb: 'CockroachDB', yugabytedb: 'YugabyteDB YSQL', tidb: 'TiDB', vitess: 'Vitess', redshift: 'Amazon Redshift',
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  mysql: 'MySQL',
  redis: 'Redis',
  valkey: 'Valkey',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  mssql: 'SQL Server',
  clickhouse: 'ClickHouse',
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
  oracle: 'Oracle Database',
  trino: 'Trino',
  bigquery: 'BigQuery',
  snowflake: 'Snowflake',
  databricks: 'Databricks SQL',
  athena: 'Amazon Athena',
  firebird: 'Firebird',
  hana: 'SAP HANA',
  couchdb: 'CouchDB',
  dynamodb: 'DynamoDB',
  cassandra: 'Cassandra',
  influxdb: 'InfluxDB 2 Flux',
  questdb: 'QuestDB',
  neo4j: 'Neo4j',
}
export const enginePorts: Record<Engine, number> = {
  db2:50000,
  qdrant: 6333,
  milvus: 19530,
  weaviate: 8080,
  pinecone: 443,

  cockroachdb: 26257, yugabytedb: 5433, tidb: 4000, vitess: 15306, redshift: 5439,
  postgres: 5432,
  mariadb: 3306,
  mysql: 3306,
  redis: 6379,
  valkey: 6379,
  mongodb: 27017,
  sqlite: 5432,
  duckdb: 5432,
  mssql: 1433,
  clickhouse: 8123,
  elasticsearch: 9200,
  opensearch: 9200,
  oracle: 1521,
  trino: 8080,
  bigquery: 443,
  snowflake: 443,
  databricks: 443,
  athena: 443,
  firebird: 3050,
  hana: 30015,
  couchdb: 5984,
  dynamodb: 18000,
  cassandra: 9042,
  influxdb: 8086,
  questdb: 9000,
  neo4j: 7687,
}
export const uid = () => crypto.randomUUID()
export function displayCell(value: Cell | undefined): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object')
    return `0x${Array.from(atob(value.base64), (x) => x.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
  return String(value)
}
export function errorText(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(e)
}
export function newProfile(engine: Engine = 'postgres'): ConnectionProfile {
  return profileSchema.parse({
    id: uid(),
    engine,
    host: 'localhost',
    port: enginePorts[engine],
    username: engine === 'postgres' ? 'postgres' : ['mariadb', 'mysql'].includes(engine) ? 'root' : '',
    database: '',
    ...(['sqlite', 'duckdb'].includes(engine) ? { schema: 'main' } : {}),
    ...(engine === 'mssql' ? { schema: 'dbo', tls: { enabled: true, rejectUnauthorized: true } } : {}),
    ...(engine === 'clickhouse' ? { database: 'default', schema: 'default', username: 'default' } : {}),
    ...(engine === 'db2' ? { schema: '', tls: { enabled: true, rejectUnauthorized: true } } : {}),
    ...(engine === 'redshift' ? { tls: { enabled: true, rejectUnauthorized: true } } : {}),
    ...(engine === 'cockroachdb' ? { username: 'root', database: 'defaultdb' } : {}),
    ...(engine === 'yugabytedb' ? { username: 'yugabyte', database: 'yugabyte' } : {}),
    ...(['tidb', 'vitess'].includes(engine) ? { username: 'root', schema: '' } : {}),
    ...(engine === 'trino' ? { database: '', schema: '', username: '' } : {}),
    ...(engine === 'oracle' ? { database: 'FREEPDB1', schema: '' } : {}),
    ...(engine === 'pinecone' ? { host: 'api.pinecone.io', tls: { enabled: true, rejectUnauthorized: true } } : {}),
    readOnly: true,
    ...{ name: `New ${engineNames[engine]}` },
  })
}
export { parseConnectionUrl } from '@shared/connection-uri'
