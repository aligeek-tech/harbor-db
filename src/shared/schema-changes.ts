import { z } from 'zod'
import type { TableStructure } from './contracts'
import { qualifiedName, quoteIdentifier } from './sql'

export const schemaEngineSchema = z.enum(['postgres', 'mysql', 'mariadb', 'sqlite', 'duckdb', 'mssql'])
export type SchemaEngine = z.infer<typeof schemaEngineSchema>
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    'Identifiers cannot contain control characters.',
  )
export const schemaTargetSchema = z
  .object({
    connectionId: z.string().min(1).max(100),
    database: identifier.optional(),
    schema: identifier,
    table: identifier,
  })
  .strict()
export type SchemaTarget = z.infer<typeof schemaTargetSchema>
export const columnTypeSchema = z
  .object({
    kind: z.enum([
      'integer',
      'bigint',
      'decimal',
      'varchar',
      'text',
      'boolean',
      'date',
      'timestamp',
      'binary',
    ]),
    length: z.number().int().min(1).max(4000).optional(),
    precision: z.number().int().min(1).max(38).optional(),
    scale: z.number().int().min(0).max(38).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'varchar' && !value.length)
      context.addIssue({ code: 'custom', message: 'VARCHAR requires an explicit length.' })
    if (value.kind !== 'varchar' && value.length !== undefined)
      context.addIssue({ code: 'custom', message: 'Only VARCHAR accepts a length.' })
    if (
      value.kind === 'decimal' &&
      (!value.precision || value.scale === undefined || value.scale > value.precision)
    )
      context.addIssue({
        code: 'custom',
        message: 'DECIMAL requires precision and scale, with scale no greater than precision.',
      })
    if (value.kind !== 'decimal' && (value.precision !== undefined || value.scale !== undefined))
      context.addIssue({ code: 'custom', message: 'Only DECIMAL accepts precision and scale.' })
  })
export type SchemaColumnType = z.infer<typeof columnTypeSchema>
export const schemaLiteralSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      value: z
        .string()
        .max(4000)
        .refine((value) => !value.includes('\0')),
    })
    .strict(),
  z
    .object({
      kind: z.literal('number'),
      value: z
        .string()
        .max(100)
        .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
    })
    .strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('null') }).strict(),
])
export const schemaColumnSchema = z
  .object({
    name: identifier,
    type: columnTypeSchema,
    nullable: z.boolean(),
    default: schemaLiteralSchema.optional(),
  })
  .strict()
export type SchemaColumn = z.infer<typeof schemaColumnSchema>
const columns = z
  .array(identifier)
  .min(1)
  .max(16)
  .refine((items) => new Set(items).size === items.length, 'Repeated columns are not allowed.')
export const schemaConstraintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary-key'), name: identifier, columns }).strict(),
  z.object({ kind: z.literal('unique'), name: identifier, columns }).strict(),
  z
    .object({
      kind: z.literal('foreign-key'),
      name: identifier,
      columns,
      referencedSchema: identifier,
      referencedTable: identifier,
      referencedColumns: columns,
    })
    .strict(),
  z
    .object({
      kind: z.literal('check'),
      name: identifier,
      column: identifier,
      operator: z.enum(['=', '<>', '>', '<', '>=', '<=']),
      value: schemaLiteralSchema,
    })
    .strict(),
])
export type SchemaConstraint = z.infer<typeof schemaConstraintSchema>
export const schemaOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create-table'),
      columns: z.array(schemaColumnSchema).min(1).max(100),
      constraints: z.array(schemaConstraintSchema).max(32),
    })
    .strict(),
  z.object({ kind: z.literal('rename-table'), name: identifier }).strict(),
  z.object({ kind: z.literal('add-column'), column: schemaColumnSchema }).strict(),
  z.object({ kind: z.literal('drop-column'), name: identifier }).strict(),
  z.object({ kind: z.literal('rename-column'), name: identifier, newName: identifier }).strict(),
  z
    .object({
      kind: z.literal('alter-column'),
      name: identifier,
      type: columnTypeSchema,
      nullable: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('create-index'), name: identifier, columns, unique: z.boolean() }).strict(),
  z.object({ kind: z.literal('drop-index'), name: identifier }).strict(),
  z.object({ kind: z.literal('add-constraint'), constraint: schemaConstraintSchema }).strict(),
  z
    .object({
      kind: z.literal('drop-constraint'),
      name: identifier,
      constraintKind: z.enum(['primary-key', 'unique', 'foreign-key', 'check']),
    })
    .strict(),
])
export type SchemaOperation = z.infer<typeof schemaOperationSchema>
export const previewSchemaChangeSchema = z
  .object({ target: schemaTargetSchema, operation: schemaOperationSchema })
  .strict()
export type PreviewSchemaChangeInput = z.infer<typeof previewSchemaChangeSchema>
export const executeSchemaChangeSchema = z
  .object({ token: z.string().uuid(), confirm: z.string().max(1200) })
  .strict()
export type ExecuteSchemaChangeInput = z.infer<typeof executeSchemaChangeSchema>
export const compareSchemasSchema = z
  .object({
    source: schemaTargetSchema,
    target: schemaTargetSchema,
    objects: z
      .array(
        z
          .object({
            kind: z.enum(['table', 'view', 'function', 'trigger']),
            sourceName: identifier,
            targetName: identifier,
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (objects) =>
          new Set(objects.map((object) => `${object.kind}/${object.sourceName}/${object.targetName}`))
            .size === objects.length,
        'Choose each object pair only once.',
      )
      .optional(),
  })
  .strict()
export type CompareSchemasInput = z.infer<typeof compareSchemasSchema>
export interface SchemaDependency {
  kind: string
  name: string
  detail: string
}
export interface SchemaChangePreview {
  token: string
  expiresAt: string
  target: SchemaTarget
  engine: SchemaEngine
  statements: string[]
  atomicity: 'transaction' | 'implicit-commit'
  warnings: string[]
  dependencies: SchemaDependency[]
  blockedReasons: string[]
  confirmation: string
}
export interface SchemaChangeResult {
  state: 'committed' | 'rolled-back' | 'failed' | 'unknown'
  steps: {
    sql: string
    status: 'committed' | 'rolled-back' | 'failed' | 'unknown' | 'not-run'
    error?: string
  }[]
  warnings: string[]
}
export interface SchemaDifference {
  object: string
  change: 'add' | 'remove' | 'change'
  detail: string
  supported: boolean
}
export interface SchemaComparison {
  engine: SchemaEngine
  source: SchemaTarget
  target: SchemaTarget
  differences: SchemaDifference[]
  statements: string[]
  warnings: string[]
}
export function schemaAtomicity(engine: SchemaEngine): 'transaction' | 'implicit-commit' {
  return engine === 'mysql' || engine === 'mariadb' ? 'implicit-commit' : 'transaction'
}
export function schemaTypeSql(engine: SchemaEngine, input: SchemaColumnType): string {
  const type = columnTypeSchema.parse(input)
  if (type.kind === 'varchar') return `${engine === 'mssql' ? 'NVARCHAR' : 'VARCHAR'}(${type.length})`
  if (type.kind === 'decimal') return `DECIMAL(${type.precision},${type.scale})`
  const types: Record<SchemaColumnType['kind'], string> = {
    integer: 'INTEGER',
    bigint: 'BIGINT',
    decimal: '',
    varchar: '',
    text: engine === 'mssql' ? 'NVARCHAR(MAX)' : 'TEXT',
    boolean: engine === 'mssql' ? 'BIT' : engine === 'sqlite' ? 'INTEGER' : 'BOOLEAN',
    date: 'DATE',
    timestamp:
      engine === 'mssql'
        ? 'DATETIME2'
        : engine === 'mysql' || engine === 'mariadb'
          ? 'DATETIME'
          : 'TIMESTAMP',
    binary: engine === 'postgres' ? 'BYTEA' : engine === 'mssql' ? 'VARBINARY(MAX)' : 'BLOB',
  }
  return types[type.kind]
}
function literal(engine: SchemaEngine, value: z.infer<typeof schemaLiteralSchema>): string {
  if (value.kind === 'null') return 'NULL'
  if (value.kind === 'number') return value.value
  if (value.kind === 'boolean')
    return ['mssql', 'sqlite'].includes(engine) ? (value.value ? '1' : '0') : value.value ? 'TRUE' : 'FALSE'
  // Backslashes have mode-dependent meaning in MySQL/MariaDB. Reject rather than guess sql_mode.
  if ((engine === 'mysql' || engine === 'mariadb') && value.value.includes('\\'))
    throw new Error('Backslashes in text defaults/checks require a manually reviewed SQL-mode-aware script.')
  return `${engine === 'mssql' ? 'N' : ''}'${value.value.replaceAll("'", "''")}'`
}
function columnSql(engine: SchemaEngine, column: SchemaColumn): string {
  if (!column.nullable && column.default?.kind === 'null')
    throw new Error('A NOT NULL column cannot default to NULL.')
  return `${quoteIdentifier(column.name, engine)} ${schemaTypeSql(engine, column.type)}${column.nullable ? '' : ' NOT NULL'}${column.default ? ` DEFAULT ${literal(engine, column.default)}` : ''}`
}
function constraintSql(
  engine: SchemaEngine,
  constraint: SchemaConstraint,
  target: SchemaTarget,
  available: Set<string>,
): string {
  const q = (name: string) => quoteIdentifier(name, engine)
  const selected = constraint.kind === 'check' ? [constraint.column] : constraint.columns
  if (selected.some((column) => !available.has(column)))
    throw new Error('Constraint references a column absent from the table.')
  const prefix = `CONSTRAINT ${q(constraint.name)} `
  if (constraint.kind === 'check') {
    if (constraint.value.kind === 'null')
      throw new Error('Comparisons to NULL do not enforce a check; use column nullability instead.')
    return `${prefix}CHECK (${q(constraint.column)} ${constraint.operator} ${literal(engine, constraint.value)})`
  }
  const names = selected.map(q).join(', ')
  if (constraint.kind === 'primary-key') return `${prefix}PRIMARY KEY (${names})`
  if (constraint.kind === 'unique') return `${prefix}UNIQUE (${names})`
  if (selected.length !== constraint.referencedColumns.length)
    throw new Error('Foreign-key column counts must match exactly.')
  if (engine === 'sqlite' && constraint.referencedSchema !== target.schema)
    throw new Error('SQLite foreign keys cannot cross attached databases.')
  if (
    engine === 'duckdb' &&
    constraint.referencedSchema === target.schema &&
    constraint.referencedTable === target.table
  )
    throw new Error('DuckDB self-referential foreign keys are not supported by this editor.')
  const referenced =
    engine === 'sqlite'
      ? q(constraint.referencedTable)
      : qualifiedName(constraint.referencedSchema, constraint.referencedTable, engine)
  return `${prefix}FOREIGN KEY (${names}) REFERENCES ${referenced} (${constraint.referencedColumns.map(q).join(', ')})`
}
/** Typed inputs only. No arbitrary SQL, expression defaults, implicit cascades or table rebuilds. */
export function compileSchemaChange(
  engine: SchemaEngine,
  input: PreviewSchemaChangeInput,
  structure?: TableStructure,
  options: { safeModifyColumns?: string[] } = {},
): { statements: string[]; warnings: string[]; blockedReasons: string[] } {
  const { target, operation } = previewSchemaChangeSchema.parse(input)
  const warnings = [
      'DDL can block concurrent readers/writers, validate existing data, and rewrite a table. No row scan or lock-duration estimate is performed by preview.',
      'Dependency visibility follows database permissions. Application code and dynamic SQL references cannot be proven by catalog inspection.',
    ],
    blockedReasons: string[] = [],
    statements: string[] = []
  const block = (message: string) => {
    blockedReasons.push(message)
  }
  const q = (name: string) => {
    const max = engine === 'postgres' ? 63 : ['mysql', 'mariadb'].includes(engine) ? 64 : 128
    if (new TextEncoder().encode(name).length > max)
      throw new Error(`Identifier exceeds the conservative ${max}-byte limit for this engine.`)
    return quoteIdentifier(name, engine)
  }
  const table = `${q(target.schema)}.${q(target.table)}`
  const known = new Set(structure?.columns.map((column) => column.name))
  try {
    const constraints =
      operation.kind === 'create-table'
        ? operation.constraints
        : operation.kind === 'add-constraint'
          ? [operation.constraint]
          : []
    for (const constraint of constraints) {
      q(constraint.name)
      if (constraint.kind === 'check') q(constraint.column)
      else constraint.columns.forEach(q)
      if (constraint.kind === 'foreign-key') {
        q(constraint.referencedSchema)
        q(constraint.referencedTable)
        constraint.referencedColumns.forEach(q)
      }
    }
    if (operation.kind === 'create-table') {
      if (structure) throw new Error('A table already exists at this target. Choose another name.')
      const names = new Set(operation.columns.map((column) => column.name))
      if (names.size !== operation.columns.length) throw new Error('Column names must be unique.')
      if (new Set(operation.constraints.map((item) => item.name)).size !== operation.constraints.length)
        throw new Error('Constraint names must be unique.')
      if (operation.constraints.filter((item) => item.kind === 'primary-key').length > 1)
        throw new Error('A table can have only one primary key.')
      const primary = operation.constraints.find((item) => item.kind === 'primary-key')
      if (
        primary &&
        'columns' in primary &&
        primary.columns.some((name) => operation.columns.find((column) => column.name === name)?.nullable)
      )
        throw new Error(
          'Declare every primary-key column NOT NULL explicitly; SQLite otherwise permits unexpected nullable primary keys.',
        )
      for (const column of operation.columns) q(column.name)
      for (const constraint of operation.constraints) q(constraint.name)
      statements.push(
        `CREATE TABLE ${table} (\n  ${[...operation.columns.map((column) => columnSql(engine, column)), ...operation.constraints.map((constraint) => constraintSql(engine, constraint, target, names))].join(',\n  ')}\n);`,
      )
    } else {
      if (!structure) throw new Error('The selected table no longer exists or is not visible.')
      if (structure.isHypertable)
        throw new Error(
          'Timescale hypertable schema changes require a separately reviewed engine-specific script.',
        )
      if (
        ['drop-column', 'rename-column', 'alter-column'].includes(operation.kind) &&
        'name' in operation &&
        !known.has(operation.name)
      )
        throw new Error('The selected column is absent from current metadata.')
      if (operation.kind === 'rename-table') {
        q(operation.name)
        if (engine === 'mssql')
          statements.push(
            `EXEC sys.sp_rename ${literal(engine, { kind: 'text', value: table })}, ${literal(engine, { kind: 'text', value: operation.name })}, N'OBJECT';`,
          )
        else statements.push(`ALTER TABLE ${table} RENAME TO ${q(operation.name)};`)
        warnings.push(
          'Renames do not rewrite every dependent definition or application query. Review dependencies and refresh clients explicitly.',
        )
      } else if (operation.kind === 'add-column') {
        if (known.has(operation.column.name)) throw new Error('A column already has this name.')
        q(operation.column.name)
        if (!operation.column.nullable && !operation.column.default)
          warnings.push(
            'Adding a NOT NULL column without a default fails when existing rows cannot satisfy it. No default will be invented.',
          )
        statements.push(
          `ALTER TABLE ${table} ADD ${engine === 'mssql' ? '' : 'COLUMN '}${columnSql(engine, engine === 'duckdb' ? { ...operation.column, nullable: true } : operation.column)};`,
        )
        if (engine === 'duckdb' && !operation.column.nullable)
          statements.push(`ALTER TABLE ${table} ALTER COLUMN ${q(operation.column.name)} SET NOT NULL;`)
      } else if (operation.kind === 'drop-column') {
        warnings.push(
          'Destructive: all values in this column are permanently removed after commit. Table-local indexes or constraints may also be removed by the engine; review every listed dependency.',
        )
        statements.push(`ALTER TABLE ${table} DROP COLUMN ${q(operation.name)};`)
      } else if (operation.kind === 'rename-column') {
        if (known.has(operation.newName)) throw new Error('The replacement column name already exists.')
        q(operation.newName)
        if (engine === 'mssql')
          statements.push(
            `EXEC sys.sp_rename ${literal(engine, { kind: 'text', value: `${table}.${q(operation.name)}` })}, ${literal(engine, { kind: 'text', value: operation.newName })}, N'COLUMN';`,
          )
        else
          statements.push(
            `ALTER TABLE ${table} RENAME COLUMN ${q(operation.name)} TO ${q(operation.newName)};`,
          )
        warnings.push(
          'Renames do not rewrite every dependent definition or application query. Review dependencies and refresh clients explicitly.',
        )
      } else if (operation.kind === 'alter-column') {
        if (['mysql', 'mariadb'].includes(engine) && !options.safeModifyColumns?.includes(operation.name))
          block(
            'MODIFY must restate generated/identity, collation, defaults and other attributes. This catalog model is incomplete for that operation; use a manually reviewed full column definition.',
          )
        else if (engine === 'sqlite')
          block(
            'SQLite type/nullability changes need a separately reviewed table rebuild or version-specific operation. This editor never rebuilds tables implicitly.',
          )
        else {
          warnings.push(
            'Potentially destructive conversion: the server may reject values, round or truncate them. Preview does not inspect row values and does not generate a conversion expression or rollback script.',
          )
          const clause = `ALTER TABLE ${table} ALTER COLUMN ${q(operation.name)}`
          if (engine === 'mysql' || engine === 'mariadb')
            statements.push(
              `ALTER TABLE ${table} MODIFY COLUMN ${q(operation.name)} ${schemaTypeSql(engine, operation.type)} ${operation.nullable ? 'NULL' : 'NOT NULL'};`,
            )
          else if (engine === 'mssql')
            statements.push(
              `${clause} ${schemaTypeSql(engine, operation.type)} ${operation.nullable ? 'NULL' : 'NOT NULL'};`,
            )
          else
            statements.push(
              `${clause} TYPE ${schemaTypeSql(engine, operation.type)};`,
              `${clause} ${operation.nullable ? 'DROP' : 'SET'} NOT NULL;`,
            )
        }
      } else if (operation.kind === 'create-index') {
        if (operation.columns.some((column) => !known.has(column)))
          throw new Error('Index columns must exist in current metadata.')
        if (structure.indexes.some((item) => item.name === operation.name))
          throw new Error('An index already has this name.')
        const name = engine === 'sqlite' ? `${q(target.schema)}.${q(operation.name)}` : q(operation.name)
        const owner = engine === 'sqlite' ? q(target.table) : table
        statements.push(
          `CREATE ${operation.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${owner} (${operation.columns.map(q).join(', ')});`,
        )
        warnings.push(
          'Index creation scans the table and uses disk/memory. This editor does not request concurrent/online index creation. A unique index rejects duplicate values according to engine NULL/collation rules.',
        )
      } else if (operation.kind === 'drop-index') {
        if (!structure.indexes.some((item) => item.name === operation.name))
          throw new Error('Index is absent from current metadata.')
        warnings.push(
          'Dropping an index may remove uniqueness enforcement or degrade query performance. Constraint-owned indexes may be rejected by the server.',
        )
        statements.push(
          ['mysql', 'mariadb', 'mssql'].includes(engine)
            ? `DROP INDEX ${q(operation.name)} ON ${table};`
            : `DROP INDEX ${q(target.schema)}.${q(operation.name)};`,
        )
      } else if (operation.kind === 'add-constraint') {
        if (['sqlite', 'duckdb'].includes(engine))
          block(
            `${engine} does not support this generic ADD CONSTRAINT operation. Constraints can be specified when creating a table; no implicit rebuild is generated.`,
          )
        else {
          q(operation.constraint.name)
          if (structure.constraints.some((item) => item.name === operation.constraint.name))
            throw new Error('A constraint already has this name.')
          statements.push(
            `ALTER TABLE ${table} ADD ${constraintSql(engine, operation.constraint, target, known)};`,
          )
          warnings.push(
            'Constraint validation may scan and lock existing rows. Invalid data causes server rejection; validation is not disabled.',
          )
        }
      } else if (operation.kind === 'drop-constraint') {
        if (['sqlite', 'duckdb'].includes(engine))
          block(`${engine} generic DROP CONSTRAINT is unsupported. No implicit rebuild is generated.`)
        else if (!structure.constraints.some((item) => item.name === operation.name))
          throw new Error('Constraint is absent from current metadata.')
        else {
          if (['mysql', 'mariadb'].includes(engine)) {
            const actual = structure.constraints.find((item) => item.name === operation.name)!
            const labels = {
              'primary-key': 'PRIMARY KEY',
              unique: 'UNIQUE',
              'foreign-key': 'FOREIGN KEY',
              check: 'CHECK',
            }
            if (!actual.definition.toUpperCase().startsWith(labels[operation.constraintKind] + ':'))
              throw new Error('The selected constraint kind does not match authoritative catalog metadata.')
          }
          const action = ['mysql', 'mariadb'].includes(engine)
            ? operation.constraintKind === 'primary-key'
              ? 'DROP PRIMARY KEY'
              : operation.constraintKind === 'foreign-key'
                ? `DROP FOREIGN KEY ${q(operation.name)}`
                : operation.constraintKind === 'unique'
                  ? `DROP INDEX ${q(operation.name)}`
                  : `${engine === 'mysql' ? 'DROP CHECK' : 'DROP CONSTRAINT'} ${q(operation.name)}`
            : `DROP CONSTRAINT ${q(operation.name)}`
          statements.push(`ALTER TABLE ${table} ${action};`)
          warnings.push(
            'Destructive integrity change: future data may no longer satisfy this constraint. No dependent objects are cascaded explicitly.',
          )
        }
      }
    }
  } catch (error) {
    block(error instanceof Error ? error.message : 'Schema operation is invalid.')
  }
  if (engine === 'sqlite')
    warnings.push(
      'SQLite uses affinity typing; DECIMAL and VARCHAR declarations do not guarantee precision or length enforcement.',
    )
  if (schemaAtomicity(engine) === 'implicit-commit')
    warnings.push(
      'MySQL/MariaDB DDL implicitly commits. Earlier successful statements cannot be rolled back when a later statement fails. A connection loss can leave the final outcome unknown.',
    )
  else
    warnings.push(
      'Generated operations run in their own transaction, separate from editor transactions. Connection loss during COMMIT can still leave the outcome unknown.',
    )
  return { statements: blockedReasons.length ? [] : statements, warnings, blockedReasons }
}

/** Only lossless, recognized metadata types produce drafts; expressions/attributes are never guessed. */
export function schemaTypeFromCatalog(type: string): SchemaColumnType | undefined {
  const normalized = type.trim().toUpperCase()
  if (/^(INTEGER|INT|INT4)$/.test(normalized)) return { kind: 'integer' }
  if (/^(BIGINT|INT8)$/.test(normalized)) return { kind: 'bigint' }
  if (/^(BOOLEAN|BOOL|BIT)$/.test(normalized)) return { kind: 'boolean' }
  if (/^(TEXT|NVARCHAR\(MAX\))$/.test(normalized)) return { kind: 'text' }
  if (/^(BLOB|BYTEA|VARBINARY\(MAX\))$/.test(normalized)) return { kind: 'binary' }
  if (normalized === 'DATE') return { kind: 'date' }
  if (/^(TIMESTAMP|TIMESTAMP WITHOUT TIME ZONE|DATETIME|DATETIME2)$/.test(normalized))
    return { kind: 'timestamp' }
  const length = /^(?:N?VARCHAR|CHARACTER VARYING)\((\d+)\)$/.exec(normalized)
  if (length && Number(length[1]) <= 4000) return { kind: 'varchar', length: Number(length[1]) }
  const decimal = /^(?:DECIMAL|NUMERIC)\((\d+),\s*(\d+)\)$/.exec(normalized)
  if (decimal && Number(decimal[1]) <= 38 && Number(decimal[2]) <= Number(decimal[1]))
    return { kind: 'decimal', precision: Number(decimal[1]), scale: Number(decimal[2]) }
  return undefined
}
