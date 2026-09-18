import { z } from 'zod'
import { queryParameterSchema } from './parameters'
import type { Engine } from './contracts'
import { engineSupports } from './capabilities'

/** A user-visible consistency contract shared by the review and the resulting job. */
export function exportConsistency(engine: Engine): string {
  if (!engineSupports(engine, 'streamExport')) throw new Error('This engine does not support full query exports.')
  if (engine === 'db2') return 'One fresh dedicated guarded Db2 query, streamed with one acknowledged row at a time. Only bounded exact driver output types are supported. No multi-table snapshot is promised. Cancellation closes the client process; server completion is unconfirmed.'
  if (engine === 'redshift') return 'A fresh dedicated guarded Redshift query, streamed through a cursor transaction. Redshift may materialize cursor results on the leader node; warehouse/serverless resource costs still apply. Uncommitted tab changes are excluded.'
  if (engine === 'vitess') return 'One fresh guarded VTGate read query in the configured keyspace. No cross-shard transactional snapshot is promised. Client cancellation closes the connection without confirming server cancellation.'
  if (engine === 'tidb') return 'A fresh dedicated TiDB transaction with a guarded read statement and native snapshot. TiDB READ ONLY mode is unavailable; restricted server permissions remain authoritative. Uncommitted tab changes are excluded; no statement is replayed.'
  if (['cockroachdb', 'yugabytedb'].includes(engine)) return 'A fresh dedicated read-only transaction using this product’s native isolation. Uncommitted tab changes are excluded. Transaction failures are reported without replay; client cancellation does not confirm server rollback.'
  if (engine === 'snowflake') return 'A separate Snowflake statement in the selected warehouse, database/schema and role. It may incur compute charges. Native result partitions are fetched directly; no interactive transaction or cross-connector snapshot is promised.'
  if (engine === 'trino') return 'A fresh Trino query in a native read-only transaction; snapshot consistency and cross-source guarantees depend on the selected connectors. Cancellation does not reverse connector effects.'
  if (engine === 'bigquery') return 'A separate BigQuery query job using the profile billing project, location and server-enforced byte cap. Results are paged from that job. Display or export row caps do not bound scan charges; cancellation is best effort.'
  if (engine === 'oracle') return 'A fresh dedicated Oracle read-only transaction with a consistent snapshot. Uncommitted tab changes are excluded; no transaction is replayed after disconnect.'
  if (engine === 'clickhouse') return 'One fresh read-only ClickHouse query with native per-table snapshots. There is no multi-table transactional snapshot; merges and remote table engines may affect consistency.'
  if (engine === 'mssql') return 'A fresh dedicated SQL Server SNAPSHOT transaction. The database must already enable ALLOW_SNAPSHOT_ISOLATION; Harbor never changes that setting. Uncommitted tab changes are excluded.'
  if (engine === 'postgres') return 'A fresh dedicated PostgreSQL read-only repeatable-read transaction. Uncommitted tab changes are excluded; server permissions and SQL execution limits still apply.'
  if (engine === 'mariadb' || engine === 'mysql') return 'A fresh dedicated read-only repeatable-read transaction. InnoDB tables provide a snapshot; nontransactional tables and concurrent schema changes do not. Uncommitted tab changes are excluded.'
  return `A fresh dedicated ${engine === 'sqlite' ? 'SQLite' : 'DuckDB'} read transaction using its native snapshot. Uncommitted tab changes are excluded.`
}

export const fullExportSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: z.string().min(1).max(255).optional(),
    sql: z.string().min(1).max(1000000),
    parameters: z.array(queryParameterSchema).max(100).optional(),
    format: z.enum(['csv', 'jsonl']),
    spreadsheetSafe: z.boolean(),
    consentRerun: z.literal(true),
  })
  .strict()
export type FullExportInput = z.infer<typeof fullExportSchema>
export interface ExportJobSnapshot {
  id: string
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  rows: number
  bytes: number
  durationMs: number
  consistency: string
  error?: string
  partialPath?: string
  outputPath?: string
}
