import { createHash, randomUUID } from 'node:crypto'
import type { Cell, ConnectionProfile, QueryResult, ResultSet } from '../../shared/contracts'
import type { QueryParameter } from '../../shared/parameters'
import { qualifiedName, quoteIdentifier } from '../../shared/sql'
import {
  inspectSqlAdministrationSchema,
  previewSqlAdministrationSchema,
  executeSqlAdministrationSchema,
  type InspectSqlAdministrationInput,
  type PreviewSqlAdministrationInput,
  type ExecuteSqlAdministrationInput,
  type SqlAdminTarget,
  type SqlAdminInspection,
  type SqlAdminPreview,
  type SqlAdminResult,
} from '../../shared/sql-administration'
import type { SchemaAdapter } from './schema-changes'

type Engine = 'postgres' | 'mysql' | 'mariadb'
type Adapter = Pick<SchemaAdapter, 'execute' | 'transaction' | 'closeSession' | 'getSessionState'>
interface Context {
  profile(id: string): ConnectionProfile
  adapter(id: string): Adapter
}
interface Session {
  id: string
  target: SqlAdminTarget
  engine: Engine
  adapter: Adapter
}
interface Statement {
  sql: string
  values?: string[]
}
interface Plan {
  statements: Statement[]
  snapshot: unknown
  identity: { name: string; value: string }[]
  warnings: string[]
  requested?: boolean
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'SQL administration failed.')
const text = (value: Cell | undefined) => (value === null || value === undefined ? '' : String(value))
const rows = (sets: ResultSet[]) =>
  sets.flatMap((set) =>
    set.rows.map((row) =>
      Object.fromEntries(set.columns.map((column, index) => [column.name.toLowerCase(), text(row[index])])),
    ),
  )
const policyNames = [
  'policy_retention',
  'policy_compression',
  'policy_refresh_continuous_aggregate',
  'policy_reorder',
]

/** Explicit bounded inspection and one-use reviewed commands; no polling or scheduler in the desktop app. */
export class SqlAdministrationService {
  private previews = new Map<
    string,
    {
      input: PreviewSqlAdministrationInput
      profile: string
      plan: Plan
      fingerprint: string
      preview: SqlAdminPreview
      expires: number
    }
  >()
  private running = new Set<string>()
  constructor(
    private context: Context,
    private now: () => number = Date.now,
  ) {}
  private session(target: SqlAdminTarget): Session {
    const profile = this.context.profile(target.connectionId)
    if (!['postgres', 'mysql', 'mariadb'].includes(profile.engine))
      throw new Error('This administration workflow is supported for PostgreSQL, MySQL and MariaDB only.')
    return {
      id: `sql-admin-${randomUUID()}`,
      target,
      engine: profile.engine as Engine,
      adapter: this.context.adapter(profile.id),
    }
  }
  private async close(session: Session) {
    await session.adapter
      .closeSession({ connectionId: session.target.connectionId, sessionId: session.id })
      .catch(() => undefined)
  }
  private async query(
    session: Session,
    sql: string,
    values: string[] = [],
    limit = 201,
  ): Promise<QueryResult> {
    const parameters: QueryParameter[] = values.map((value, index) => ({
      name: `p${index + 1}`,
      type: 'text',
      value,
      secret: false,
    }))
    const result = await session.adapter.execute({
      connectionId: session.target.connectionId,
      database: session.target.database,
      sessionId: session.id,
      requestId: randomUUID(),
      sql,
      parameters,
      maxRows: limit,
      privateSession: true,
      confirm: this.context.profile(session.target.connectionId).name,
    })
    if (result.cancelled)
      throw new Error('The server operation was cancelled. No automatic retry was attempted.')
    return result
  }
  private async catalog(
    session: Session,
    sql: string,
    values: string[] = [],
  ): Promise<Record<string, string>[]> {
    const result = await this.query(session, sql, values)
    if (result.sets.some((set) => set.truncated || set.rows.length > 200))
      throw new Error('Review metadata exceeds the 200-row bound. Narrow the target before proceeding.')
    return rows(result.sets)
  }
  private scope(target: SqlAdminTarget) {
    if (!target.schema || !target.table)
      throw new Error('Choose an exact schema and table for this operation.')
    return { schema: target.schema, table: target.table }
  }
  private async extension(session: Session, name: string) {
    if (session.engine !== 'postgres') throw new Error('This capability requires PostgreSQL.')
    const extension = await this.catalog(
      session,
      'SELECT e.oid::text,e.extversion AS version,n.nspname AS schema_name FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=$1',
      [name],
    )
    if (extension.length !== 1)
      throw new Error(
        `${name} is not installed in this selected database. Harbor will not install or configure it.`,
      )
    return extension[0]
  }
  private async ownedRelations(session: Session, extension: string, allowed: string[]) {
    await this.extension(session, extension)
    const objects = await this.catalog(
      session,
      "SELECT n.nspname AS schema_name,c.relname AS name FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_class'::regclass JOIN pg_catalog.pg_class c ON c.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE e.extname=$1 AND c.relkind IN ('v','r','p') AND c.relname=ANY(string_to_array($2,',')) ORDER BY n.nspname,c.relname",
      [extension, allowed.join(',')],
    )
    if (new Set(objects.map((row) => row.name)).size !== objects.length)
      throw new Error('Extension catalog names are ambiguous.')
    return new Map(
      objects
        .filter((row) => allowed.includes(row.name))
        .map((row) => [row.name, qualifiedName(row.schema_name, row.name, 'postgres')]),
    )
  }
  private async sessionRows(session: Session, includeText: boolean, onlyId?: string) {
    if (session.engine === 'postgres')
      return this.catalog(
        session,
        `SELECT pid::text AS session_id,usename AS username,datname AS database_name,client_addr::text AS client,state,backend_start::text,query_start::text,md5(COALESCE(query,'')) AS query_fingerprint,pg_catalog.pg_blocking_pids(pid)::text AS blockers,pg_backend_pid()::text AS observer${includeText ? ',left(query,2000) AS query_preview' : ''} FROM pg_catalog.pg_stat_activity WHERE backend_type='client backend' AND datname=current_database()${onlyId ? ' AND pid=$1::integer' : ''} ORDER BY pid LIMIT 201`,
        onlyId ? [onlyId] : [],
      )
    if (session.engine === 'mariadb')
      return this.catalog(
        session,
        `SELECT ID AS session_id,USER AS username,DB AS database_name,HOST AS client,COMMAND AS state,QUERY_ID AS query_identity,MD5(COALESCE(INFO,'')) AS query_fingerprint,CONNECTION_ID() AS observer${includeText ? ',LEFT(INFO,2000) AS query_preview' : ''} FROM information_schema.PROCESSLIST WHERE DB=?${onlyId ? ' AND ID=?' : ''} ORDER BY ID LIMIT 201`,
        [
          session.target.database || this.context.profile(session.target.connectionId).database,
          ...(onlyId ? [onlyId] : []),
        ],
      )
    return this.catalog(
      session,
      `SELECT PROCESSLIST_ID AS session_id,PROCESSLIST_USER AS username,PROCESSLIST_DB AS database_name,PROCESSLIST_HOST AS client,PROCESSLIST_COMMAND AS state,THREAD_ID AS thread_identity,MD5(COALESCE(PROCESSLIST_INFO,'')) AS query_fingerprint,CONNECTION_ID() AS observer${includeText ? ',LEFT(PROCESSLIST_INFO,2000) AS query_preview' : ''} FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_DB=?${onlyId ? ' AND PROCESSLIST_ID=?' : ''} ORDER BY PROCESSLIST_ID LIMIT 201`,
      [
        session.target.database || this.context.profile(session.target.connectionId).database,
        ...(onlyId ? [onlyId] : []),
      ],
    )
  }
  async inspect(raw: InspectSqlAdministrationInput): Promise<SqlAdminInspection> {
    const input = inspectSqlAdministrationSchema.parse(raw),
      session = this.session(input),
      started = performance.now(),
      profile = this.context.profile(input.connectionId)
    const result: SqlAdminInspection = {
      engine: session.engine,
      kind: input.kind,
      available: true,
      sets: [],
      durationMs: 0,
      warnings: [
        'Manual bounded snapshot. Database permissions determine visibility; absence of rows does not establish absence of sessions, grants, objects or activity.',
        'The profile read-only option is an application safety preference; it is not database-enforced authorization.',
      ],
    }
    // A multi-query view shares one payload budget; each adapter query has its own additional bound.
    let remainingBytes = 8 * 1024 * 1024
    const append = (set: ResultSet) => {
      const metadataBytes = Buffer.byteLength(JSON.stringify({ ...set, rows: [] }), 'utf8')
      if (metadataBytes > remainingBytes) {
        remainingBytes = 0
        result.warnings.push(`${set.command}: omitted after the aggregate 8 MiB snapshot bound.`)
        return
      }
      remainingBytes -= metadataBytes
      const accepted: Cell[][] = []
      for (const row of set.rows.slice(0, 200)) {
        const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
        if (bytes > remainingBytes) {
          set.truncated = true
          remainingBytes = 0
          break
        }
        accepted.push(row)
        remainingBytes -= bytes
      }
      if (accepted.length !== set.rows.length) set.truncated = true
      set.rows = accepted
      if (set.truncated)
        result.warnings.push(
          `${set.command}: capped at 200 rows, the driver byte bound, or the aggregate 8 MiB snapshot bound. Narrow scope for a complete inspection.`,
        )
      result.sets.push(set)
    }
    const read = async (sql: string, values: string[] = [], label: string = input.kind) => {
      if (!remainingBytes) {
        result.warnings.push(`${label}: not queried after the aggregate 8 MiB snapshot bound.`)
        return
      }
      const response = await this.query(session, sql, values)
      for (const set of response.sets) {
        set.command = label
        append(set)
      }
    }
    const optional = async (action: () => Promise<void>) => {
      try {
        await action()
      } catch (error) {
        result.warnings.push(errorText(error))
      }
    }
    const postgres = session.engine === 'postgres',
      schema = input.schema || profile.schema || profile.database,
      table = input.table || ''
    try {
      if (input.kind === 'sessions') {
        const items = await this.sessionRows(session, input.includeQueryText)
        result.sessions = items
          .filter((row) => row.session_id !== row.observer)
          .map((row) => ({
            id: row.session_id,
            user: row.username,
            database: row.database_name,
            client: row.client,
            state: row.state,
            ...(row.backend_start ? { startedAt: row.backend_start, queryStartedAt: row.query_start } : {}),
          }))
        const columns = [
          'session_id',
          'username',
          'database_name',
          'client',
          'state',
          ...(postgres ? ['backend_start', 'query_start', 'blockers'] : []),
          ...(input.includeQueryText ? ['query_preview'] : []),
        ]
        append({
          columns: columns.map((name) => ({ name, type: 'text' })),
          rows: items
            .filter((row) => row.session_id !== row.observer)
            .map((row) => columns.map((name) => row[name] || null)),
          affectedRows: 0,
          command: 'Sessions',
          truncated: false,
        })
        result.warnings.push(
          input.includeQueryText
            ? 'Query text can contain sensitive values; previews stay in memory and are limited to 2,000 characters.'
            : 'Query text is omitted. Session review uses a private fingerprint without exposing query text.',
        )
      } else if (input.kind === 'health') {
        if (postgres) {
          await read(
            "SELECT current_database() AS database_name,version() AS version,pg_catalog.pg_postmaster_start_time()::text AS server_started,current_setting('transaction_read_only') AS transaction_read_only",
            [],
            'Server identity',
          )
          await read(
            'SELECT datname,numbackends::text,xact_commit::text,xact_rollback::text,blks_read::text,blks_hit::text,tup_returned::text,tup_fetched::text,deadlocks::text,temp_bytes::text,stats_reset::text FROM pg_catalog.pg_stat_database WHERE datname=current_database()',
            [],
            'Database counters',
          )
        } else {
          await read(
            'SELECT VERSION() AS version,DATABASE() AS database_name,@@read_only AS server_read_only,@@max_connections AS max_connections',
            [],
            'Server identity',
          )
          await read(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Connections','Aborted_connects','Slow_queries','Created_tmp_disk_tables','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests')",
            [],
            'Server counters',
          )
        }
        result.warnings.push(
          'Cumulative counters are not rates or a health certification. No server setting or statistics counter was changed.',
        )
      } else if (input.kind === 'partitions') {
        if (postgres)
          await read(
            "SELECT pn.nspname AS parent_schema,p.relname AS parent_table,cn.nspname AS child_schema,c.relname AS child_table,c.relispartition,pg_catalog.pg_get_expr(c.relpartbound,c.oid,true) AS partition_bound,pg_catalog.pg_get_partkeydef(p.oid) AS partition_key FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class p ON p.oid=i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace WHERE ($1='' OR pn.nspname=$1) AND ($2='' OR p.relname=$2) ORDER BY pn.nspname,p.relname,i.inhseqno,c.relname LIMIT 201",
            [schema || '', table],
          )
        else
          await read(
            "SELECT TABLE_SCHEMA,TABLE_NAME,PARTITION_NAME,SUBPARTITION_NAME,PARTITION_METHOD,PARTITION_EXPRESSION,PARTITION_DESCRIPTION,TABLE_ROWS,DATA_LENGTH,INDEX_LENGTH FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND (?='' OR TABLE_NAME=?) AND PARTITION_NAME IS NOT NULL ORDER BY TABLE_NAME,PARTITION_ORDINAL_POSITION LIMIT 201",
            [schema, table, table],
          )
        result.warnings.push(
          'Partition bounds and row/size estimates come from catalogs. No partition data was scanned or changed.',
        )
      } else if (input.kind === 'routines' || input.kind === 'events') {
        if (postgres && input.kind === 'events')
          throw new Error(
            'PostgreSQL has no built-in MySQL-style event scheduler. No extension is installed or enabled here.',
          )
        if (postgres)
          await read(
            `SELECT n.nspname AS schema_name,p.proname AS name,p.prokind AS kind,pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity,pg_catalog.pg_get_function_result(p.oid) AS result_type,p.prosecdef AS security_definer,l.lanname AS language${input.includeQueryText ? ',pg_catalog.pg_get_functiondef(p.oid) AS definition' : ''} FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.prokind IN ('f','p') ORDER BY p.proname,identity LIMIT 201`,
            [schema],
          )
        else if (input.kind === 'events') {
          await read('SELECT @@event_scheduler AS scheduler_status', [], 'Event scheduler status')
          await read(
            `SELECT EVENT_SCHEMA,EVENT_NAME,DEFINER,STATUS,EVENT_TYPE,EXECUTE_AT,INTERVAL_VALUE,INTERVAL_FIELD,STARTS,ENDS,LAST_EXECUTED,TIME_ZONE${input.includeQueryText ? ',EVENT_DEFINITION' : ''} FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME LIMIT 201`,
            [schema],
          )
          result.warnings.push(
            'Events are inspected only. No event is created, enabled or run, and the server scheduler setting is unchanged.',
          )
        } else
          await read(
            `SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE,DTD_IDENTIFIER,SECURITY_TYPE,DEFINER,SQL_DATA_ACCESS,IS_DETERMINISTIC,CREATED,LAST_ALTERED${input.includeQueryText ? ',ROUTINE_DEFINITION' : ''} FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME,ROUTINE_TYPE LIMIT 201`,
            [schema],
          )
      } else if (input.kind === 'query-statistics') {
        if (postgres) {
          const view = (await this.ownedRelations(session, 'pg_stat_statements', ['pg_stat_statements'])).get(
            'pg_stat_statements',
          )
          if (!view) throw new Error('The extension-owned pg_stat_statements view is unavailable.')
          await read(
            `SELECT queryid::text,calls::text,total_exec_time::text,mean_exec_time::text,rows::text,shared_blks_hit::text,shared_blks_read::text${input.includeQueryText ? ',left(query,2000) AS query_preview' : ''} FROM ${view} WHERE dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 201`,
          )
        } else
          await read(
            `SELECT SCHEMA_NAME,DIGEST,COUNT_STAR,SUM_TIMER_WAIT/1000000000000 AS total_seconds,SUM_ROWS_SENT,SUM_ROWS_EXAMINED,SUM_ERRORS${input.includeQueryText ? ',LEFT(DIGEST_TEXT,2000) AS query_preview' : ''} FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME=? ORDER BY SUM_TIMER_WAIT DESC LIMIT 201`,
            [schema],
          )
        result.warnings.push(
          'Optional aggregated statistics may be disabled, incomplete or reset independently. SQL text is opt-in; normalized text can still contain sensitive identifiers. Nothing was installed or reset.',
        )
      } else if (input.kind === 'permissions') {
        if (postgres) {
          await read(
            "SELECT grantee,table_schema,table_name,privilege_type,is_grantable FROM information_schema.table_privileges WHERE table_schema=$1 AND ($2='' OR table_name=$2) ORDER BY table_name,grantee,privilege_type LIMIT 201",
            [schema, table],
          )
          if (table)
            await read(
              "SELECT current_user AS principal,pg_catalog.has_table_privilege(current_user,$1::regclass,'SELECT') AS can_select,pg_catalog.has_table_privilege(current_user,$1::regclass,'INSERT') AS can_insert,pg_catalog.has_table_privilege(current_user,$1::regclass,'UPDATE') AS can_update,pg_catalog.has_table_privilege(current_user,$1::regclass,'DELETE') AS can_delete,pg_catalog.row_security_active($1::regclass) AS row_security_active",
              [qualifiedName(schema, table, 'postgres')],
              'Current role effective table privileges',
            )
          await optional(() =>
            read(
              "SELECT r.rolname AS member_of,r.rolinherit,r.rolsuper,r.rolbypassrls FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(current_user,r.oid,'USAGE') ORDER BY r.rolname LIMIT 201",
              [],
              'Applicable roles',
            ),
          )
        } else {
          await read(
            'SELECT CURRENT_USER() AS authenticated_account,USER() AS client_account',
            [],
            'Account identity',
          )
          await read(
            "SELECT 'global' AS scope,GRANTEE,'' AS schema_name,'' AS table_name,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.USER_PRIVILEGES UNION ALL SELECT 'schema',GRANTEE,TABLE_SCHEMA,'',PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=? UNION ALL SELECT 'table',GRANTEE,TABLE_SCHEMA,TABLE_NAME,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=? AND (?='' OR TABLE_NAME=?) LIMIT 201",
            [schema, schema, table, table],
          )
        }
        result.warnings.push(
          'Visible grants alone do not establish effective row access: role inheritance, ownership, RLS, column grants, DEFINER code and session roles matter. Authentication hashes are never selected.',
        )
      } else if (input.kind === 'index-usage') {
        if (postgres)
          await read(
            "SELECT n.nspname AS schema_name,t.relname AS table_name,c.relname AS index_name,pg_catalog.pg_get_indexdef(c.oid) AS definition,pg_catalog.pg_relation_size(c.oid)::text AS bytes,i.indisunique,i.indisprimary,i.indisvalid,s.idx_scan::text,s.idx_tup_read::text,s.idx_tup_fetch::text FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid=c.oid WHERE n.nspname=$1 AND ($2='' OR t.relname=$2) ORDER BY t.relname,c.relname LIMIT 201",
            [schema, table],
          )
        else {
          await read(
            "SELECT TABLE_SCHEMA,TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME,NON_UNIQUE,INDEX_TYPE,CARDINALITY FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND (?='' OR TABLE_NAME=?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 201",
            [schema, table, table],
            'Index definitions',
          )
          await optional(() =>
            read(
              "SELECT OBJECT_SCHEMA,OBJECT_NAME,INDEX_NAME,COUNT_READ,COUNT_WRITE,COUNT_FETCH FROM performance_schema.table_io_waits_summary_by_index_usage WHERE OBJECT_SCHEMA=? AND (?='' OR OBJECT_NAME=?) ORDER BY OBJECT_NAME,INDEX_NAME LIMIT 201",
              [schema, table, table],
              'Instrumented index usage',
            ),
          )
          await optional(() =>
            read(
              "SELECT database_name,table_name,index_name,stat_value*@@innodb_page_size AS estimated_bytes,last_update FROM mysql.innodb_index_stats WHERE database_name=? AND (?='' OR table_name=?) AND stat_name='size' ORDER BY table_name,index_name LIMIT 201",
              [schema, table, table],
              'InnoDB index size estimates',
            ),
          )
        }
        result.warnings.push(
          'Usage counters can reset and may exclude workloads. Zero observed scans is not evidence that an index is safe to remove; sizes/cardinalities may be estimates.',
        )
      } else {
        const extension = await this.extension(session, 'timescaledb'),
          views = await this.ownedRelations(session, 'timescaledb', [
            'hypertables',
            'chunks',
            'continuous_aggregates',
            'jobs',
            'job_stats',
          ])
        if (views.has('hypertables'))
          await read(
            `SELECT hypertable_schema,hypertable_name,num_dimensions,num_chunks,compression_enabled FROM ${views.get('hypertables')} WHERE hypertable_schema=$1 AND ($2='' OR hypertable_name=$2) ORDER BY hypertable_name LIMIT 201`,
            [schema, table],
            'Hypertables',
          )
        if (views.has('chunks'))
          await optional(() =>
            read(
              `SELECT hypertable_schema,hypertable_name,chunk_schema,chunk_name,range_start::text,range_end::text,is_compressed FROM ${views.get('chunks')} WHERE hypertable_schema=$1 AND ($2='' OR hypertable_name=$2) ORDER BY hypertable_name,chunk_name LIMIT 201`,
              [schema, table],
              'Chunks',
            ),
          )
        if (views.has('continuous_aggregates'))
          await read(
            `SELECT view_schema,view_name,hypertable_schema,hypertable_name,materialized_only FROM ${views.get('continuous_aggregates')} WHERE hypertable_schema=$1 AND ($2='' OR hypertable_name=$2) ORDER BY view_name LIMIT 201`,
            [schema, table],
            'Continuous aggregates',
          )
        if (views.has('jobs'))
          await read(
            `SELECT job_id,proc_schema,proc_name,schedule_interval::text,scheduled,hypertable_schema,hypertable_name,next_start::text FROM ${views.get('jobs')} WHERE hypertable_schema=$1 AND ($2='' OR hypertable_name=$2) ORDER BY job_id LIMIT 201`,
            [schema, table],
            'Policies and jobs',
          )
        if (views.has('job_stats'))
          await optional(() =>
            read(
              `SELECT job_id,hypertable_schema,hypertable_name,last_run_started_at::text,last_successful_finish::text,last_run_status,job_status,next_start::text,total_runs,total_successes,total_failures FROM ${views.get('job_stats')} WHERE hypertable_schema=$1 AND ($2='' OR hypertable_name=$2) ORDER BY job_id LIMIT 201`,
              [schema, table],
              'Job outcomes',
            ),
          )
        result.warnings.push(
          `TimescaleDB ${extension.version}: only extension-owned native views are read. Compression APIs and current columnstore equivalents are version-dependent. No job was scheduled, enabled, run or removed by inspection.`,
        )
      }
    } catch (error) {
      result.available = false
      result.warnings.push(errorText(error))
    } finally {
      await this.close(session)
      result.durationMs = Math.round(performance.now() - started)
    }
    return result
  }

  private future(value: string | undefined) {
    if (!value || Date.parse(value) < this.now() + 60000)
      throw new Error(
        'Choose an explicit first/next start at least one minute in the future. Harbor never starts a policy immediately.',
      )
    return value
  }
  private async routine(session: Session, name: string, argumentsRequired: string[]) {
    const matches = await this.catalog(
      session,
      "SELECT p.oid::text,n.nspname AS schema_name,p.proname,p.proargnames::text AS argument_names,pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc p ON p.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE e.extname='timescaledb' AND p.proname=$1 AND p.prokind='f' AND p.proargnames @> string_to_array($2,',')",
      [name, argumentsRequired.join(',')],
    )
    if (matches.length !== 1)
      throw new Error(
        `The installed extension does not expose an unambiguous ${name} API with the required arguments. No alternative function will be invoked.`,
      )
    return { sql: qualifiedName(matches[0].schema_name, name, 'postgres'), identity: matches[0] }
  }
  private async plan(session: Session, input: PreviewSqlAdministrationInput): Promise<Plan> {
    const { target, action } = input,
      postgres = session.engine === 'postgres'
    if (action.kind === 'session') {
      const matches = await this.sessionRows(session, false, action.sessionId),
        row = matches[0]
      if (matches.length !== 1 || row.session_id === row.observer)
        throw new Error('The exact target session is unavailable or is the inspecting session.')
      if (action.mode === 'cancel' && !['active', 'Query', 'Execute'].includes(row.state))
        throw new Error('The reviewed session is not executing a query. Refresh the session snapshot.')
      if (postgres && (!row.backend_start || !row.query_start))
        throw new Error(
          'Session identity is hidden by server privileges. No cancellation command can be reviewed.',
        )
      if (session.engine === 'mysql' && !row.thread_identity)
        throw new Error('Performance Schema did not expose the native thread identity.')
      if (
        session.engine === 'mariadb' &&
        action.mode === 'cancel' &&
        !/^[1-9]\d*$/.test(row.query_identity || '')
      )
        throw new Error('MariaDB did not expose a running query identity.')
      const snapshot = { ...row }
      delete snapshot.observer
      delete snapshot.blockers
      const statement = postgres
        ? {
            sql: `SELECT pg_catalog.pg_${action.mode === 'cancel' ? 'cancel' : 'terminate'}_backend($1::integer) AS signal_accepted`,
            values: [row.session_id],
          }
        : {
            sql:
              session.engine === 'mariadb'
                ? `KILL SOFT ${action.mode === 'cancel' ? `QUERY ID ${row.query_identity}` : `CONNECTION ${row.session_id}`}`
                : `KILL ${action.mode === 'cancel' ? 'QUERY' : 'CONNECTION'} ${row.session_id}`,
          }
      return {
        statements: [statement],
        snapshot,
        requested: true,
        identity: [
          { name: 'Session', value: row.session_id },
          { name: 'User', value: row.username },
          { name: 'Database', value: row.database_name },
          { name: 'Client', value: row.client },
          { name: 'State', value: row.state },
          ...(row.backend_start
            ? [
                { name: 'Backend started', value: row.backend_start },
                { name: 'Query started', value: row.query_start },
              ]
            : []),
          ...(row.thread_identity ? [{ name: 'Native thread', value: row.thread_identity }] : []),
          ...(row.query_identity ? [{ name: 'Native query', value: row.query_identity }] : []),
        ],
        warnings: [
          'The exact native identity is rechecked immediately before sending the command. The server can still change state between that check and the signal.',
          action.mode === 'terminate'
            ? 'Disconnects this one session. Its uncommitted transaction may need server rollback time; other clients may reconnect independently.'
            : 'Cancellation affects the current statement. A surrounding transaction may remain open or failed and require its owner to roll back.',
          'A server acknowledgement means the request was accepted, not that all work or rollback has finished.',
          ...(session.engine === 'mariadb'
            ? [
                'MariaDB uses SOFT cancellation to avoid interrupting critical MyISAM/Aria operations; completion can be delayed.',
              ]
            : []),
        ],
      }
    }
    const scope = this.scope(target),
      qualified = qualifiedName(scope.schema, scope.table, session.engine)
    if (action.kind === 'privilege') {
      if (!postgres && !action.host)
        throw new Error('Choose the exact existing account host as well as its user name.')
      if (!postgres && [action.principal, action.host!].some((value) => /[\\\r\n]/.test(value)))
        throw new Error(
          'Account names with backslashes or line breaks require a manual engine-specific review.',
        )
      const principal = postgres
        ? await this.catalog(session, 'SELECT oid::text,rolname FROM pg_catalog.pg_roles WHERE rolname=$1', [
            action.principal,
          ])
        : await this.catalog(
            session,
            'SELECT User AS principal,Host AS host FROM mysql.user WHERE User=? AND Host=?',
            [action.principal, action.host!],
          )
      if (principal.length !== 1)
        throw new Error(
          'The exact existing principal could not be verified. No account is created by this workflow.',
        )
      const table = postgres
        ? await this.catalog(
            session,
            "SELECT c.oid::text,c.relkind,c.relowner::text,c.relacl::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')",
            [scope.schema, scope.table],
          )
        : await this.catalog(
            session,
            "SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,CREATE_TIME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'",
            [scope.schema, scope.table],
          )
      if (table.length !== 1)
        throw new Error(
          'The exact base table is unavailable. This workflow cannot grant access to an ambiguous object or view.',
        )
      const grants = postgres
        ? await this.catalog(
            session,
            'SELECT grantee,privilege_type,is_grantable FROM information_schema.table_privileges WHERE table_schema=$1 AND table_name=$2 ORDER BY grantee,privilege_type',
            [scope.schema, scope.table],
          )
        : await this.catalog(
            session,
            'SELECT GRANTEE,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY GRANTEE,PRIVILEGE_TYPE',
            [scope.schema, scope.table],
          )
      const quotedAccount = postgres
        ? quoteIdentifier(action.principal, 'postgres')
        : `'${action.principal.replaceAll("'", "''")}'@'${action.host!.replaceAll("'", "''")}'`
      return {
        statements: [
          {
            sql: `${action.mode.toUpperCase()} ${action.privileges.join(', ')} ON ${postgres ? 'TABLE ' : ''}${qualified} ${action.mode === 'grant' ? 'TO' : 'FROM'} ${quotedAccount}`,
          },
        ],
        snapshot: { principal, table, grants },
        identity: [
          { name: 'Table', value: qualified },
          { name: 'Existing principal', value: quotedAccount },
          { name: 'Privileges', value: action.privileges.join(', ') },
        ],
        warnings: [
          'This changes server authorization on exactly one table. It does not create accounts or grant the ability to grant privileges.',
          'Inherited/global/schema/column grants, ownership and row security can still permit or restrict access after this change. Visible grants are not a full effective-access proof.',
          postgres
            ? 'The privilege command executes in a dedicated transaction.'
            : 'MySQL/MariaDB privilege commands can implicitly commit and cannot be rolled back by Harbor.',
        ],
      }
    }
    if (!postgres)
      throw new Error(
        'TimescaleDB policies require an existing TimescaleDB extension in the selected PostgreSQL database.',
      )
    const extension = await this.extension(session, 'timescaledb'),
      views = await this.ownedRelations(session, 'timescaledb', ['hypertables', 'dimensions', 'jobs'])
    if (!views.has('hypertables') || !views.has('dimensions') || !views.has('jobs'))
      throw new Error(
        'The installed TimescaleDB version does not expose the required native policy catalogs.',
      )
    const hypertables = await this.catalog(
      session,
      `SELECT hypertable_schema,hypertable_name,compression_enabled FROM ${views.get('hypertables')} WHERE hypertable_schema=$1 AND hypertable_name=$2`,
      [scope.schema, scope.table],
    )
    if (hypertables.length !== 1)
      throw new Error('The exact selected object is not a visible TimescaleDB hypertable.')
    const jobs = await this.catalog(
      session,
      `SELECT job_id::text,proc_schema,proc_name,schedule_interval::text,scheduled::text,config::text FROM ${views.get('jobs')} WHERE hypertable_schema=$1 AND hypertable_name=$2 AND proc_name=ANY(string_to_array($3,',')) ORDER BY job_id`,
      [scope.schema, scope.table, policyNames.join(',')],
    )
    // A name alone is not trusted: every native policy executor must itself belong to this extension.
    const executors = await this.catalog(
      session,
      "SELECT n.nspname AS schema_name,p.proname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e' AND d.classid='pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc p ON p.oid=d.objid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE e.extname='timescaledb' AND p.proname=ANY(string_to_array($1,',')) ORDER BY n.nspname,p.proname",
      [policyNames.join(',')],
    )
    if (
      jobs.some(
        (job) =>
          !executors.some(
            (routine) => routine.schema_name === job.proc_schema && routine.proname === job.proc_name,
          ),
      )
    )
      throw new Error('A policy job does not use the extension-owned executor. Manual review is required.')
    const warnings = [
      `TimescaleDB ${extension.version}: policy definitions and server jobs persist after Harbor closes. They can modify or remove data when scheduled.`,
      'The API is validated against the installed extension, and no extension, scheduler, compression setting or server privilege is enabled automatically.',
    ]
    let statement: Statement, routine: Awaited<ReturnType<SqlAdministrationService['routine']>>
    if (action.kind === 'timescale-policy') {
      const matches = jobs.filter((job) => job.proc_name === `policy_${action.policy}`)
      if ((action.mode === 'add' && matches.length) || (action.mode === 'remove' && matches.length !== 1))
        throw new Error(
          action.mode === 'add'
            ? 'This policy already exists. Inspect its existing job before changing it.'
            : 'Exactly one existing native policy is required for removal.',
        )
      if (action.mode === 'add') {
        const dimensions = await this.catalog(
          session,
          `SELECT column_name,column_type::text,dimension_type FROM ${views.get('dimensions')} WHERE hypertable_schema=$1 AND hypertable_name=$2 ORDER BY dimension_number`,
          [scope.schema, scope.table],
        )
        if (
          !dimensions.some(
            (dimension) =>
              dimension.dimension_type.toLowerCase() === 'time' &&
              /^(timestamp( with(out)? time zone)?|date)$/.test(dimension.column_type),
          )
        )
          throw new Error(
            'This policy form supports temporal hypertables only. Integer-time policies need an explicit integer-now function and engine-specific review.',
          )
        if (
          action.policy === 'compression' &&
          !['true', 't', '1'].includes(hypertables[0].compression_enabled)
        )
          throw new Error(
            'Compression/columnstore is not enabled on this hypertable. Review that schema change separately before scheduling a policy.',
          )
        if (!action.ageHours || !action.scheduleHours)
          throw new Error('Specify both the policy age and the server schedule interval.')
        const first = this.future(action.initialStart),
          ageArgument = action.policy === 'retention' ? 'drop_after' : 'compress_after'
        routine = await this.routine(session, `add_${action.policy}_policy`, [
          ageArgument,
          'schedule_interval',
          'initial_start',
        ])
        statement = {
          sql: `SELECT ${routine.sql}($1::regclass,${ageArgument} => $2::interval,schedule_interval => $3::interval,initial_start => $4::timestamptz) AS job_id`,
          values: [qualified, `${action.ageHours} hours`, `${action.scheduleHours} hours`, first],
        }
        warnings.push(
          action.policy === 'retention'
            ? 'Retention permanently drops chunks older than the reviewed age. Future scheduling does not make this reversible.'
            : 'Compression changes storage of older chunks and can affect writes and performance. This uses the installed legacy compression API when available; unsupported current replacements are not guessed.',
        )
      } else {
        routine = await this.routine(session, `remove_${action.policy}_policy`, ['if_exists'])
        statement = { sql: `SELECT ${routine.sql}($1::regclass)`, values: [qualified] }
        warnings.push(
          'Removing a policy does not restore previously dropped data or decompress existing chunks. A currently running job may finish.',
        )
      }
    } else {
      const matches = jobs.filter((job) => job.job_id === String(action.jobId))
      if (matches.length !== 1)
        throw new Error(
          'The exact native policy job is unavailable for this hypertable. Custom jobs are not administered here.',
        )
      routine = await this.routine(session, 'alter_job', [
        'job_id',
        'scheduled',
        'schedule_interval',
        'next_start',
      ])
      const next = action.scheduled ? this.future(action.nextStart) : undefined
      statement = {
        sql: `SELECT * FROM ${routine.sql}($1::integer,scheduled => $2::boolean,schedule_interval => $3::interval${next ? ',next_start => $4::timestamptz' : ''})`,
        values: [
          String(action.jobId),
          String(action.scheduled),
          `${action.scheduleHours} hours`,
          ...(next ? [next] : []),
        ],
      }
      warnings.push(
        action.scheduled
          ? 'Enabling this existing server policy permits future executions starting at the reviewed time.'
          : 'Pausing scheduling does not cancel a job that is already running.',
      )
    }
    return {
      statements: [statement],
      snapshot: { extension, hypertables, jobs, routine: routine.identity },
      identity: [
        { name: 'Hypertable', value: qualified },
        { name: 'Extension version', value: extension.version },
        ...(action.kind === 'timescale-job'
          ? [{ name: 'Job', value: String(action.jobId) }]
          : [{ name: 'Policy', value: action.policy }]),
      ],
      warnings,
    }
  }
  async preview(raw: PreviewSqlAdministrationInput): Promise<SqlAdminPreview> {
    const input = previewSqlAdministrationSchema.parse(raw),
      session = this.session(input.target),
      profile = this.context.profile(input.target.connectionId)
    const token = randomUUID(),
      expires = this.now() + (input.action.kind === 'session' ? 30000 : 300000)
    const confirmation = `${input.action.kind === 'session' ? `${input.action.mode} session ${input.action.sessionId}` : input.action.kind === 'privilege' ? `${input.action.mode} ${input.target.schema}.${input.target.table}` : input.action.kind === 'timescale-policy' ? `${input.action.mode} ${input.action.policy} ${input.target.schema}.${input.target.table}` : `${input.action.scheduled ? 'schedule' : 'pause'} job ${input.action.jobId}`} on ${profile.name}`
    const preview: SqlAdminPreview = {
      token,
      expiresAt: new Date(expires).toISOString(),
      engine: session.engine,
      target: structuredClone(input.target),
      statements: [],
      warnings: [],
      blockedReasons: [],
      confirmation,
      identity: [],
    }
    try {
      if (profile.readOnly)
        throw new Error(
          'This profile is read-only. Reviewed server administration requires an explicitly writable profile.',
        )
      const plan = await this.plan(session, input)
      preview.statements = plan.statements.map(
        (statement) =>
          statement.sql +
          (statement.values?.length ? `\n-- Bound text parameters: ${JSON.stringify(statement.values)}` : ''),
      )
      preview.warnings = plan.warnings
      preview.identity = plan.identity
      for (const [id, item] of this.previews) if (item.expires < this.now()) this.previews.delete(id)
      while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(token, {
        input: structuredClone(input),
        profile: hash(profile),
        plan,
        fingerprint: hash(plan.snapshot),
        preview: structuredClone(preview),
        expires,
      })
    } catch (error) {
      preview.blockedReasons.push(errorText(error))
    } finally {
      await this.close(session)
    }
    return preview
  }
  async execute(raw: ExecuteSqlAdministrationInput): Promise<SqlAdminResult> {
    const input = executeSqlAdministrationSchema.parse(raw),
      sealed = this.previews.get(input.token)
    if (!sealed || sealed.expires < this.now())
      throw new Error('Administration review expired. Inspect and preview again.')
    if (input.confirm !== sealed.preview.confirmation)
      throw new Error('Type the exact target confirmation shown in the review.')
    const profile = this.context.profile(sealed.input.target.connectionId)
    if (profile.readOnly || hash(profile) !== sealed.profile)
      throw new Error('The connection profile changed after review. Inspect and preview again.')
    if (this.running.has(profile.id))
      throw new Error('Another reviewed administration command is running on this connection.')
    this.previews.delete(input.token)
    this.running.add(profile.id)
    const session = this.session(sealed.input.target),
      transaction = session.engine === 'postgres' && !sealed.plan.requested
    const result: SqlAdminResult = {
      state: 'not-applied',
      message: 'No administration command was sent.',
      statements: sealed.preview.statements,
      warnings: [],
      sets: [],
    }
    let begun = false,
      sent = false,
      committing = false
    try {
      const current = await this.plan(session, sealed.input)
      if (hash(current.snapshot) !== sealed.fingerprint)
        throw new Error(
          'The exact server session or catalog state changed after review. No command was sent. Inspect and preview again.',
        )
      if (transaction) {
        await session.adapter.transaction({
          connectionId: profile.id,
          database: session.target.database,
          sessionId: session.id,
          action: 'begin',
        })
        begun = true
      }
      for (const statement of sealed.plan.statements) {
        sent = true
        const response = await this.query(session, statement.sql, statement.values)
        result.sets.push(...response.sets)
        if (begun && response.transaction !== 'open')
          throw new Error('The server did not retain the expected administration transaction.')
      }
      if (begun) {
        committing = true
        await session.adapter.transaction({
          connectionId: profile.id,
          database: session.target.database,
          sessionId: session.id,
          action: 'commit',
        })
      }
      const refused =
        sealed.plan.requested && session.engine === 'postgres' && result.sets[0]?.rows[0]?.[0] === false
      result.state = refused ? 'not-applied' : sealed.plan.requested ? 'requested' : 'committed'
      result.message = refused
        ? 'The server did not accept the signal. Refresh the actual session state.'
        : sealed.plan.requested
          ? 'The server accepted the targeted request. Refresh sessions to verify completion; rollback can take time.'
          : 'The server acknowledged the reviewed change. Inspect current privileges or policies to verify its effective behavior.'
    } catch (error) {
      result.warnings.push(errorText(error))
      if (begun && !committing) {
        try {
          await session.adapter.transaction({
            connectionId: profile.id,
            database: session.target.database,
            sessionId: session.id,
            action: 'rollback',
          })
          result.state = 'rolled-back'
          result.message = 'The administration transaction was rolled back.'
        } catch {
          result.state = 'unknown'
          result.message = 'Rollback could not be confirmed. Inspect server state before any further action.'
        }
      } else if (sent || committing) {
        result.state = 'unknown'
        result.message =
          'The outcome could not be confirmed. No automatic retry was attempted; inspect server state before acting again.'
      }
    } finally {
      await this.close(session)
      this.running.delete(profile.id)
    }
    return result
  }
}
