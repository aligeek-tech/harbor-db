import { createHash, randomUUID } from 'node:crypto'
import type { ConnectionProfile, QueryInput, QueryResult, TableStructure } from '../../shared/contracts'
import { quoteIdentifier, requiredSqlConfirmation } from '../../shared/sql'
import {
  compareSchemasSchema,
  compileSchemaChange,
  executeSchemaChangeSchema,
  previewSchemaChangeSchema,
  schemaAtomicity,
  schemaEngineSchema,
  schemaTypeFromCatalog,
  type CompareSchemasInput,
  type ExecuteSchemaChangeInput,
  type PreviewSchemaChangeInput,
  type SchemaChangePreview,
  type SchemaChangeResult,
  type SchemaComparison,
  type SchemaConstraint,
  type SchemaDependency,
  type SchemaEngine,
  type SchemaOperation,
  type SchemaTarget,
} from '../../shared/schema-changes'

export interface SchemaAdapter {
  execute(input: QueryInput): Promise<QueryResult>
  structure(input: SchemaTarget): Promise<TableStructure>
  transaction(input: {
    connectionId: string
    database?: string
    sessionId: string
    action: 'begin' | 'commit' | 'rollback'
  }): Promise<{ state: 'idle' | 'open' | 'failed' }>
  closeSession(input: { connectionId: string; sessionId: string }): Promise<void>
  getSessionState?(input: {
    connectionId: string
    sessionId: string
  }):
    | { state: 'idle' | 'open' | 'failed'; connected: boolean; running: boolean }
    | Promise<{ state: 'idle' | 'open' | 'failed'; connected: boolean; running: boolean }>
}
interface Context {
  profile(id: string): ConnectionProfile
  adapter(id: string): SchemaAdapter
}
interface Snapshot {
  structure?: TableStructure
  primaryKey?: string[]
  specialColumns?: string[]
  dependencies: SchemaDependency[]
  warnings: string[]
  complete: boolean
}
interface Sealed {
  input: PreviewSchemaChangeInput
  preview: SchemaChangePreview
  fingerprint: string
  profile: string
  expires: number
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : 'Schema operation failed.'
const sortedStructure = (structure?: TableStructure) =>
  structure && {
    ...structure,
    indexes: [...structure.indexes].sort((a, b) => a.name.localeCompare(b.name)),
    constraints: [...structure.constraints].sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: [...(structure.foreignKeys || [])].sort((a, b) => a.name.localeCompare(b.name)),
  }
const fingerprint = (snapshots: Snapshot[]) =>
  hash(
    snapshots.map((snapshot) => ({
      ...snapshot,
      structure: sortedStructure(snapshot.structure),
      dependencies: [...snapshot.dependencies].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    })),
  )

/** Main-owned typed DDL plans. Renderer supplies only a token and an exact reviewed target confirmation. */
export class SchemaChangesService {
  private previews = new Map<string, Sealed>()
  private busy = new Set<string>()
  constructor(
    private context: Context,
    private now: () => number = Date.now,
  ) {}

  private async records(
    adapter: SchemaAdapter,
    engine: SchemaEngine,
    target: SchemaTarget,
    sessionId: string,
    sql: string,
    values: string[] = [],
  ): Promise<Record<string, string>[]> {
    const result = await adapter.execute({
      ...target,
      sessionId,
      requestId: randomUUID(),
      sql,
      maxRows: 1001,
      privateSession: true,
      parameters: values.map((value, index) => ({
        name: `p${index + 1}`,
        type: 'text',
        value,
        secret: false,
      })),
    })
    if (result.cancelled) throw new Error('Catalog inspection was cancelled.')
    if (result.sets.some((set) => set.truncated || set.rows.length > 1000))
      throw new Error(
        'Dependency inspection exceeds the 1,000-object bound. Use a narrower independently reviewed migration.',
      )
    const set = result.sets[0]
    if (!set) return []
    return set.rows.map((row) =>
      Object.fromEntries(
        set.columns.map((column, index) => [column.name.toLowerCase(), String(row[index] ?? '')]),
      ),
    )
  }

  private async snapshot(target: SchemaTarget, sessionId: string): Promise<Snapshot> {
    const profile = this.context.profile(target.connectionId),
      engine = schemaEngineSchema.parse(profile.engine),
      adapter = this.context.adapter(profile.id)
    const p = (index: number) =>
      engine === 'postgres' ? `$${index}` : engine === 'mssql' ? `@p${index}` : '?'
    let existence: string
    if (engine === 'postgres')
      existence = `SELECT c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${p(1)} AND c.relname=${p(2)}`
    else if (engine === 'mssql')
      existence = `SELECT o.type AS kind FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=${p(1)} AND o.name=${p(2)}`
    else if (engine === 'sqlite')
      existence = `SELECT type AS kind FROM ${quoteIdentifier(target.schema, engine)}.sqlite_schema WHERE name=${p(1)} AND type IN ('table','view')`
    else
      existence = `SELECT table_type AS kind FROM information_schema.tables WHERE table_schema=${p(1)} AND table_name=${p(2)}`
    const rows = await this.records(
      adapter,
      engine,
      target,
      sessionId,
      existence,
      engine === 'sqlite' ? [target.table] : [target.schema, target.table],
    )
    if (!rows.length) return { dependencies: [], warnings: [], complete: true }
    if (rows.length !== 1 || !['r', 'p', 'U', 'BASE TABLE', 'table'].includes(rows[0].kind.trim()))
      throw new Error('Schema changes require one ordinary base table, not a view or another object kind.')
    const structure = await adapter.structure(target),
      dependencies: SchemaDependency[] = [],
      warnings: string[] = []
    let complete = true
    let primaryKey = structure.columns
      .filter((column) => column.primaryKey)
      .sort((a, b) => (a.primaryKeyPosition || 0) - (b.primaryKeyPosition || 0))
      .map((column) => column.name)
    const specialColumns: string[] = []
    try {
      if (engine === 'mysql' || engine === 'mariadb') {
        primaryKey = (
          await this.records(
            adapter,
            engine,
            target,
            sessionId,
            "SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema=? AND table_name=? AND constraint_name='PRIMARY' ORDER BY ordinal_position",
            [target.schema, target.table],
          )
        ).map((row) => row.name)
        specialColumns.push(
          ...(
            await this.records(
              adapter,
              engine,
              target,
              sessionId,
              "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND (extra<>'' OR character_set_name IS NOT NULL OR column_comment<>'')",
              [target.schema, target.table],
            )
          ).map((row) => row.name),
        )
      } else if (engine === 'postgres') {
        specialColumns.push(
          ...(
            await this.records(
              adapter,
              engine,
              target,
              sessionId,
              "SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped AND (a.attgenerated<>'' OR a.attidentity<>'' OR a.attcollation<>0)",
              [target.schema, target.table],
            )
          ).map((row) => row.name),
        )
      } else if (engine === 'mssql') {
        specialColumns.push(
          ...(
            await this.records(
              adapter,
              engine,
              target,
              sessionId,
              "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(QUOTENAME(@p1)+'.'+QUOTENAME(@p2)) AND (is_identity=1 OR is_computed=1 OR generated_always_type<>0 OR collation_name IS NOT NULL)",
              [target.schema, target.table],
            )
          ).map((row) => row.name),
        )
      } else if (engine === 'sqlite') {
        specialColumns.push(
          ...(
            await this.records(
              adapter,
              engine,
              target,
              sessionId,
              'SELECT name FROM pragma_table_xinfo(?, ?) WHERE hidden<>0',
              [target.table, target.schema],
            )
          ).map((row) => row.name),
        )
      } else if (/GENERATED|COLLATE/i.test(structure.ddl))
        specialColumns.push(...structure.columns.map((column) => column.name))
    } catch (error) {
      complete = false
      specialColumns.push(...structure.columns.map((column) => column.name))
      warnings.push(`Column-attribute inspection is incomplete: ${describeError(error)}`)
    }
    // Every local index/constraint is shown. The server can remove some of these implicitly on DROP COLUMN.
    for (const index of structure.indexes)
      dependencies.push({ kind: 'table index', name: index.name, detail: index.definition })
    for (const constraint of structure.constraints)
      dependencies.push({ kind: 'table constraint', name: constraint.name, detail: constraint.definition })
    try {
      let sql: string, values: string[]
      if (engine === 'postgres') {
        sql = `SELECT 'foreign key' AS kind, ns.nspname || '.' || t.relname || '.' || c.conname AS name, pg_get_constraintdef(c.oid) AS detail FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_class referenced ON referenced.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=referenced.relnamespace WHERE c.contype='f' AND rn.nspname=$1 AND referenced.relname=$2 UNION ALL SELECT DISTINCT 'dependent object' AS kind, pg_describe_object(d.classid,d.objid,d.objsubid) AS name, 'Catalog dependency; inspect before changing this table.' AS detail FROM pg_depend d JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace ns ON ns.oid=t.relnamespace WHERE d.refclassid='pg_class'::regclass AND ns.nspname=$1 AND t.relname=$2`
        values = [target.schema, target.table]
      } else if (engine === 'mysql' || engine === 'mariadb') {
        sql = `SELECT 'foreign key' AS kind, CONCAT(TABLE_SCHEMA,'.',TABLE_NAME,'.',CONSTRAINT_NAME) AS name, CONCAT(COLUMN_NAME,' -> ',REFERENCED_COLUMN_NAME) AS detail FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? ORDER BY CONSTRAINT_SCHEMA,CONSTRAINT_NAME,ORDINAL_POSITION`
        values = [target.schema, target.table]
        warnings.push(
          'MySQL/MariaDB incoming foreign keys are inspected. View/routine/trigger and application dependencies are not exhaustive under current catalog privileges.',
        )
      } else if (engine === 'mssql') {
        sql = `SELECT 'foreign key' AS kind, OBJECT_SCHEMA_NAME(fk.parent_object_id)+'.'+OBJECT_NAME(fk.parent_object_id)+'.'+fk.name AS name, 'Incoming foreign key' AS detail FROM sys.foreign_keys fk WHERE fk.referenced_object_id=OBJECT_ID(QUOTENAME(@p1)+'.'+QUOTENAME(@p2)) UNION ALL SELECT 'dependent object',COALESCE(OBJECT_SCHEMA_NAME(d.referencing_id)+'.'+OBJECT_NAME(d.referencing_id),'unresolved'), 'SQL expression dependency' FROM sys.sql_expression_dependencies d WHERE d.referenced_id=OBJECT_ID(QUOTENAME(@p1)+'.'+QUOTENAME(@p2))`
        values = [target.schema, target.table]
      } else if (engine === 'duckdb') {
        sql = `SELECT 'foreign key' AS kind, schema_name || '.' || table_name || '.' || constraint_name AS name, constraint_text AS detail FROM duckdb_constraints() WHERE constraint_type='FOREIGN KEY' AND referenced_table=?`
        values = [target.table]
        warnings.push(
          'DuckDB incoming foreign-key names are inspected across visible schemas; identically named referenced tables are conservatively included. View dependencies can be incomplete.',
        )
      } else {
        sql = `SELECT type AS kind, name, COALESCE(sql,'') AS detail FROM ${quoteIdentifier(target.schema, engine)}.sqlite_schema WHERE type IN ('view','trigger') OR (type='table' AND name<>? AND name NOT LIKE 'sqlite_%')`
        values = [target.table]
      }
      const dependenciesFound = await this.records(adapter, engine, target, sessionId, sql, values)
      if (engine === 'sqlite') {
        for (const item of dependenciesFound) {
          if (item.kind === 'table') {
            const keys = await this.records(
              adapter,
              engine,
              target,
              sessionId,
              `SELECT * FROM pragma_foreign_key_list(?, ?)`,
              [item.name, target.schema],
            )
            for (const key of keys.filter((key) => key.table === target.table))
              dependencies.push({
                kind: 'incoming foreign key',
                name: item.name,
                detail: `${key.from} → ${key.to || 'parent primary key'}`,
              })
          } else
            dependencies.push({
              kind: `${item.kind} (possible dependency)`,
              name: item.name,
              detail: item.detail,
            })
        }
        warnings.push(
          'SQLite views and triggers in this schema are listed conservatively without parsing their SQL; some may not reference this table.',
        )
      } else
        dependencies.push(
          ...dependenciesFound.map((row) => ({ kind: row.kind, name: row.name, detail: row.detail })),
        )
    } catch (error) {
      complete = false
      warnings.push(`Dependency inspection is incomplete: ${describeError(error)}`)
    }
    return { structure, primaryKey, specialColumns, dependencies, warnings, complete }
  }

  private foreignKeys(operation: SchemaOperation): Extract<SchemaConstraint, { kind: 'foreign-key' }>[] {
    const constraints =
      operation.kind === 'create-table'
        ? operation.constraints
        : operation.kind === 'add-constraint'
          ? [operation.constraint]
          : []
    return constraints.filter(
      (value): value is Extract<SchemaConstraint, { kind: 'foreign-key' }> => value.kind === 'foreign-key',
    )
  }
  private async snapshots(input: PreviewSchemaChangeInput, sessionId: string): Promise<Snapshot[]> {
    const snapshots = [await this.snapshot(input.target, sessionId)]
    for (const key of this.foreignKeys(input.operation)) {
      if (
        key.referencedSchema === input.target.schema &&
        key.referencedTable === input.target.table &&
        input.operation.kind === 'create-table'
      )
        continue
      const referenced = await this.snapshot(
        { ...input.target, schema: key.referencedSchema, table: key.referencedTable },
        sessionId,
      )
      snapshots.push(referenced)
    }
    return snapshots
  }

  async preview(raw: PreviewSchemaChangeInput): Promise<SchemaChangePreview> {
    const input = previewSchemaChangeSchema.parse(raw),
      profile = this.context.profile(input.target.connectionId),
      engine = schemaEngineSchema.parse(profile.engine),
      adapter = this.context.adapter(profile.id),
      sessionId = `schema-preview-${randomUUID()}`
    try {
      const snapshots = await this.snapshots(input, sessionId),
        snapshot = snapshots[0],
        compiled = compileSchemaChange(engine, input, snapshot.structure, {
          safeModifyColumns: snapshot.complete
            ? snapshot.structure?.columns
                .filter(
                  (column) =>
                    !snapshot.specialColumns?.includes(column.name) &&
                    (column.defaultValue === null || column.defaultValue.toUpperCase() === 'NULL'),
                )
                .map((column) => column.name)
            : [],
        })
      const blockedReasons = [...compiled.blockedReasons]
      if (profile.readOnly) blockedReasons.push('This profile is read-only. Schema execution is disabled.')
      if (
        !snapshot.complete &&
        !['add-column', 'create-table', 'create-index', 'add-constraint'].includes(input.operation.kind)
      )
        blockedReasons.push(
          'Dependency inspection is incomplete; destructive/rename/type changes cannot proceed through this editor.',
        )
      let referencedIndex = 1
      for (const key of this.foreignKeys(input.operation)) {
        const selfCreate =
          key.referencedSchema === input.target.schema &&
          key.referencedTable === input.target.table &&
          input.operation.kind === 'create-table'
        const keys =
          selfCreate && input.operation.kind === 'create-table'
            ? input.operation.constraints.find((item) => item.kind === 'primary-key')?.columns
            : snapshots[referencedIndex++]?.primaryKey
        if (!keys || JSON.stringify(keys) !== JSON.stringify(key.referencedColumns))
          blockedReasons.push(
            `Foreign key ${key.name}: the referenced columns must match the inspected primary key in order. Other unique-key references require a manually reviewed script.`,
          )
      }
      const token = randomUUID(),
        expires = this.now() + 5 * 60000
      const preview: SchemaChangePreview = {
        token,
        expiresAt: new Date(expires).toISOString(),
        target: input.target,
        engine,
        statements: compiled.statements,
        atomicity: schemaAtomicity(engine),
        blockedReasons,
        warnings: [
          ...compiled.warnings,
          ...snapshots.flatMap((item) => item.warnings),
          'The catalog is checked again before execution. Another client can still change it between that check and DDL; server dependency/permission checks remain authoritative.',
        ],
        dependencies: snapshot.dependencies,
        confirmation: `ALTER ${profile.name}/${input.target.database || '(default)'}/${input.target.schema}/${input.target.table}`,
      }
      for (const [key, item] of this.previews) if (item.expires < this.now()) this.previews.delete(key)
      while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(token, {
        input,
        preview,
        fingerprint: fingerprint(snapshots),
        profile: hash(profile),
        expires,
      })
      return structuredClone(preview)
    } finally {
      await adapter.closeSession({ connectionId: profile.id, sessionId }).catch(() => undefined)
    }
  }

  async execute(raw: ExecuteSchemaChangeInput): Promise<SchemaChangeResult> {
    const input = executeSchemaChangeSchema.parse(raw),
      sealed = this.previews.get(input.token)
    if (!sealed || sealed.expires < this.now())
      throw new Error('Schema preview expired. Inspect and preview again.')
    if (sealed.preview.blockedReasons.length)
      throw new Error('This preview contains unsupported or blocked operations.')
    if (input.confirm !== sealed.preview.confirmation)
      throw new Error('Type the exact target confirmation shown in the preview.')
    const target = sealed.input.target,
      profile = this.context.profile(target.connectionId)
    if (profile.readOnly || hash(profile) !== sealed.profile)
      throw new Error(
        'Connection profile changed after preview. Review the current target and preview again.',
      )
    if (this.busy.has(profile.id))
      throw new Error('Another reviewed schema operation is running on this connection.')
    const adapter = this.context.adapter(profile.id),
      sessionId = `schema-execute-${randomUUID()}`
    this.busy.add(profile.id)
    // Consume before I/O: a failed/uncertain write must never be replayed by retrying a token.
    this.previews.delete(input.token)
    const result: SchemaChangeResult = {
      state: 'failed',
      steps: sealed.preview.statements.map((sql) => ({ sql, status: 'not-run' })),
      warnings: [],
    }
    let started = false,
      committing = false,
      position = 0
    try {
      if (fingerprint(await this.snapshots(sealed.input, sessionId)) !== sealed.fingerprint)
        throw new Error(
          'The table or dependency catalog changed after preview. No DDL was sent. Inspect and preview again.',
        )
      if (sealed.preview.atomicity === 'transaction') {
        await adapter.transaction({ ...target, sessionId, action: 'begin' })
        started = true
      }
      for (const step of result.steps) {
        step.status = 'unknown'
        const response = await adapter.execute({
          connectionId: target.connectionId,
          database: target.database,
          sessionId,
          requestId: randomUUID(),
          sql: step.sql,
          maxRows: 1,
          privateSession: true,
          confirm: requiredSqlConfirmation(step.sql, sealed.preview.engine, profile),
        })
        if (response.cancelled)
          throw new Error('Execution was cancelled. Inspect the actual schema before retrying.')
        if (started && response.transaction !== 'open')
          throw new Error(
            'The server did not retain the expected DDL transaction. Inspect the actual schema; no automatic retry was attempted.',
          )
        step.status = sealed.preview.atomicity === 'implicit-commit' ? 'committed' : 'unknown'
        position++
      }
      if (started) {
        committing = true
        await adapter.transaction({ ...target, sessionId, action: 'commit' })
      }
      result.state = 'committed'
      result.steps.forEach((step) => {
        step.status = 'committed'
      })
    } catch (error) {
      const message = describeError(error)
      if (result.steps[position]) result.steps[position].error = message
      result.warnings.push(message)
      if (started && !committing) {
        try {
          const state =
            sealed.preview.engine === 'mssql'
              ? await adapter.getSessionState?.({ connectionId: target.connectionId, sessionId })
              : undefined
          // The MSSQL adapter refreshes XACT_STATE/@@TRANCOUNT after a server error
          // on the existing socket. XACT_ABORT may already have rolled this transaction back.
          if (state?.connected && !state.running && state.state === 'idle')
            result.warnings.push(
              'SQL Server confirmed automatic rollback on the same physical session after the failed DDL.',
            )
          else await adapter.transaction({ ...target, sessionId, action: 'rollback' })
          result.state = 'rolled-back'
          result.steps.forEach((step) => {
            if (step.status !== 'not-run') step.status = 'rolled-back'
          })
        } catch {
          result.state = 'unknown'
          result.warnings.push(
            'Rollback could not be confirmed. The connection will be closed; inspect the schema before retrying.',
          )
        }
      } else if (
        committing ||
        result.steps.some((step) => step.status === 'unknown' || step.status === 'committed')
      ) {
        result.state = 'unknown'
        result.warnings.push(
          'The final statement/commit outcome is uncertain. Earlier committed DDL remains applied; do not retry without inspecting the schema.',
        )
      }
    } finally {
      await adapter.closeSession({ connectionId: target.connectionId, sessionId }).catch(() => {
        result.warnings.push('Session close could not be confirmed.')
      })
      this.busy.delete(profile.id)
    }
    return result
  }

  async compare(raw: CompareSchemasInput): Promise<SchemaComparison> {
    const input = compareSchemasSchema.parse(raw)
    if (!input.objects) return this.compareTable(input)
    const engine = schemaEngineSchema.parse(this.context.profile(input.source.connectionId).engine)
    if (this.context.profile(input.target.connectionId).engine !== engine)
      throw new Error('Schema comparison currently requires the same engine on both sides.')
    const combined: SchemaComparison = {
      engine,
      source: input.source,
      target: input.target,
      differences: [],
      statements: [],
      warnings: [
        'Bounded selected-object schema comparison. Only the explicitly selected objects are read; table rows are never scanned.',
        'Definitions are compared as returned by native catalogs. Formatting, qualified names, and overloads can cause differences. Missing metadata privileges, encrypted routines and dynamic dependencies remain limitations.',
        'Draft statements are inert. Unsupported conversions and non-table reconstruction require manual review; no rollback plan or automatic apply is provided.',
      ],
    }
    for (const object of input.objects) {
      const source = { ...input.source, table: object.sourceName },
        target = { ...input.target, table: object.targetName },
        title = `${object.kind} ${object.sourceName} → ${object.targetName}`
      try {
        if (object.kind === 'table') {
          const result = await this.compareTable({ source, target })
          combined.differences.push(
            ...result.differences.map((difference) => ({
              ...difference,
              object: `${title} / ${difference.object}`,
            })),
          )
          combined.statements.push(...result.statements)
          combined.warnings.push(...result.warnings)
        } else {
          const desired = await this.definition(source, engine, object.kind),
            actual = await this.definition(target, engine, object.kind)
          if (!desired.supported || !actual.supported)
            combined.differences.push({
              object: title,
              change: 'change',
              supported: false,
              detail:
                'Native definition is unavailable or unsupported for this engine/object/privilege combination. Equality and reconstruction cannot be established.',
            })
          else if (JSON.stringify(desired.rows) !== JSON.stringify(actual.rows))
            combined.differences.push({
              object: title,
              change: !actual.rows.length ? 'add' : !desired.rows.length ? 'remove' : 'change',
              supported: false,
              detail: `Manual definition/dependency review required. Source:\n${JSON.stringify(desired.rows, null, 2)}\nTarget:\n${JSON.stringify(actual.rows, null, 2)}`,
            })
          else if (!desired.rows.length)
            combined.warnings.push(
              `${title}: neither object was visible; absence is not proof of sufficient catalog privileges.`,
            )
        }
      } catch (error) {
        combined.differences.push({
          object: title,
          change: 'change',
          supported: false,
          detail: `Inspection incomplete: ${describeError(error)}`,
        })
      }
      if (Buffer.byteLength(JSON.stringify(combined)) > 4 * 1024 * 1024)
        throw new Error('Comparison exceeds the 4 MiB result bound. Select fewer objects.')
    }
    combined.warnings = [...new Set(combined.warnings)]
    return combined
  }

  private async definition(
    target: SchemaTarget,
    engine: SchemaEngine,
    kind: 'view' | 'function' | 'trigger',
  ): Promise<{ rows: Record<string, string>[]; supported: boolean }> {
    const adapter = this.context.adapter(target.connectionId),
      sessionId = `schema-definition-${randomUUID()}`
    let sql: string,
      values = [target.schema, target.table]
    if (engine === 'postgres') {
      sql =
        kind === 'view'
          ? "SELECT c.relkind AS kind,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('v','m')"
          : kind === 'function'
            ? "SELECT p.prokind AS kind,pg_get_function_identity_arguments(p.oid) AS identity,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2 AND p.prokind IN ('f','p') ORDER BY identity"
            : 'SELECT c.relname AS owner,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname=$2 AND NOT t.tgisinternal ORDER BY owner'
    } else if (engine === 'mysql' || engine === 'mariadb') {
      sql =
        kind === 'view'
          ? 'SELECT view_definition AS definition,check_option,security_type FROM information_schema.views WHERE table_schema=? AND table_name=?'
          : kind === 'function'
            ? 'SELECT routine_type, dtd_identifier,sql_data_access,security_type,routine_definition AS definition FROM information_schema.routines WHERE routine_schema=? AND routine_name=? ORDER BY routine_type'
            : 'SELECT event_object_table,event_manipulation,action_timing,action_statement AS definition FROM information_schema.triggers WHERE trigger_schema=? AND trigger_name=?'
    } else if (engine === 'sqlite') {
      if (kind === 'function') return { rows: [], supported: false }
      sql = `SELECT sql AS definition FROM ${quoteIdentifier(target.schema, engine)}.sqlite_schema WHERE name=? AND type=?`
      values = [target.table, kind]
    } else if (engine === 'duckdb') {
      if (kind !== 'view') return { rows: [], supported: false }
      sql =
        'SELECT sql AS definition FROM duckdb_views() WHERE database_name=current_database() AND schema_name=? AND view_name=? AND NOT internal'
    } else {
      const types = kind === 'view' ? "'V'" : kind === 'trigger' ? "'TR'" : "'FN','IF','TF','P'"
      sql = `SELECT o.type AS kind,m.definition,m.uses_ansi_nulls,m.uses_quoted_identifier FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE s.name=@p1 AND o.name=@p2 AND o.type IN (${types}) ORDER BY o.type`
    }
    try {
      const rows = await this.records(adapter, engine, target, sessionId, sql, values)
      if (Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024)
        throw new Error('Selected object definitions exceed the 256 KiB bound.')
      return { rows, supported: rows.every((row) => !!row.definition) }
    } finally {
      await adapter.closeSession({ connectionId: target.connectionId, sessionId }).catch(() => undefined)
    }
  }

  private async compareTable(raw: CompareSchemasInput): Promise<SchemaComparison> {
    const input = compareSchemasSchema.parse(raw),
      sourceProfile = this.context.profile(input.source.connectionId),
      targetProfile = this.context.profile(input.target.connectionId),
      engine = schemaEngineSchema.parse(sourceProfile.engine)
    if (targetProfile.engine !== engine)
      throw new Error('Schema comparison currently requires the same engine on both sides.')
    const sessionId = `schema-compare-${randomUUID()}`
    try {
      const source = await this.snapshot(input.source, sessionId),
        target = await this.snapshot(input.target, sessionId)
      const result: SchemaComparison = {
        engine,
        ...input,
        differences: [],
        statements: [],
        warnings: [
          'This is an inert, single-table migration draft from target toward source. It does not execute, copy rows, infer safe casts, or provide a rollback plan.',
          'Same-name objects are compared. Added/removed columns may represent renames; confirm intent before dropping data.',
          'Indexes/constraints/defaults/generated columns/collations can require unsupported reconstruction. Their differences are reported without inventing SQL.',
          ...source.warnings,
          ...target.warnings,
        ],
      }
      if (!source.structure) {
        result.differences.push({
          object: `table ${input.target.schema}.${input.target.table}`,
          change: 'remove',
          supported: false,
          detail: target.structure
            ? 'Target-only table. Dropping the table and its data requires explicit independent dependency and backup review; no DROP TABLE is generated.'
            : 'Neither selected table is visible. Confirm existence and catalog permissions.',
        })
        return result
      }
      const append = (
        object: string,
        change: 'add' | 'remove' | 'change',
        detail: string,
        operation?: SchemaOperation,
      ) => {
        const compiled = operation
          ? compileSchemaChange(engine, { target: input.target, operation }, target.structure)
          : undefined
        result.differences.push({
          object,
          change,
          detail: compiled?.blockedReasons.length ? `${detail} ${compiled.blockedReasons.join(' ')}` : detail,
          supported: !!compiled && !compiled.blockedReasons.length,
        })
        if (compiled && !compiled.blockedReasons.length) result.statements.push(...compiled.statements)
      }
      if (!target.structure) {
        append(
          `table ${input.target.schema}.${input.target.table}`,
          'add',
          'Target table is absent. Complete DDL reconstruction is unsupported because generated/identity/collation/default/partition attributes may not be represented by the inspected structure.',
        )
        return result
      }
      for (const column of source.structure.columns) {
        const current = target.structure.columns.find((item) => item.name === column.name),
          type = schemaTypeFromCatalog(column.type)
        if (!current) {
          const safe =
            type &&
            column.defaultValue === null &&
            !column.primaryKey &&
            !source.specialColumns?.includes(column.name) &&
            !/GENERATED|IDENTITY|AUTO_INCREMENT|COLLATE/i.test(source.structure.ddl)
          append(
            `column ${column.name}`,
            'add',
            `${column.type}, ${column.nullable ? 'nullable' : 'NOT NULL'}. Review any possible rename before applying.`,
            safe
              ? { kind: 'add-column', column: { name: column.name, type, nullable: column.nullable } }
              : undefined,
          )
        } else if (JSON.stringify(column) !== JSON.stringify(current)) {
          const typeChange = column.type !== current.type || column.nullable !== current.nullable
          // A conversion is always manual in comparison even where visual ALTER can explicitly review it.
          append(
            `column ${column.name}`,
            'change',
            `${current.type}/${current.nullable ? 'NULL' : 'NOT NULL'}/${current.defaultValue ?? 'no default'} → ${column.type}/${column.nullable ? 'NULL' : 'NOT NULL'}/${column.defaultValue ?? 'no default'}. ${typeChange ? 'Unsupported automatic conversion: data loss, identity, collation and conversion rules need manual review.' : 'Default/key metadata changes require manual review.'}`,
          )
        }
      }
      for (const column of target.structure.columns.filter(
        (column) => !source.structure!.columns.some((item) => item.name === column.name),
      ))
        append(
          `column ${column.name}`,
          'remove',
          'Destructive: target-only column. Could be a rename; dropping loses all values.',
          { kind: 'drop-column', name: column.name },
        )
      for (const category of ['indexes', 'constraints'] as const) {
        const desired = source.structure[category],
          actual = target.structure[category]
        for (const item of desired) {
          const existing = actual.find((value) => value.name === item.name)
          if (!existing || existing.definition !== item.definition)
            append(
              `${category} ${item.name}`,
              existing ? 'change' : 'add',
              `Requires manual review. Desired definition: ${item.definition}`,
            )
        }
        for (const item of actual.filter((item) => !desired.some((value) => value.name === item.name)))
          append(
            `${category} ${item.name}`,
            'remove',
            `Target-only object requires dependency review: ${item.definition}`,
          )
      }
      if (!target.complete) {
        result.statements = []
        result.differences.forEach((item) => {
          item.supported = false
        })
        result.warnings.push('Draft SQL withheld because target dependency inspection was incomplete.')
      }
      if (target.dependencies.length)
        result.warnings.push(
          `Review ${target.dependencies.length} inspected target dependencies before using any draft statement.`,
        )
      return result
    } finally {
      for (const target of [input.source, input.target])
        await this.context
          .adapter(target.connectionId)
          .closeSession({ connectionId: target.connectionId, sessionId })
          .catch(() => undefined)
    }
  }
}
