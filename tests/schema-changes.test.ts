import { describe, expect, it } from 'vitest'
import {
  compileSchemaChange,
  previewSchemaChangeSchema,
  schemaTypeFromCatalog,
  type SchemaEngine,
} from '../src/shared/schema-changes'
import type { TableStructure } from '../src/shared/contracts'

const target = { connectionId: 'local', schema: 'main', table: 'sample' }
const structure: TableStructure = {
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, defaultValue: null, primaryKey: true },
    { name: 'value', type: 'TEXT', nullable: true, defaultValue: null, primaryKey: false },
  ],
  indexes: [{ name: 'value_idx', definition: 'value' }],
  constraints: [{ name: 'sample_pk', definition: 'PRIMARY KEY (id)' }],
  ddl: '',
}
const engines: SchemaEngine[] = ['postgres', 'mysql', 'mariadb', 'sqlite', 'duckdb', 'mssql']
describe('typed schema compiler', () => {
  it.each(engines)(
    'quotes hostile identifiers and literal defaults for %s without executable injection',
    (engine) => {
      const result = compileSchemaChange(engine, {
        target: { ...target, table: 'odd"`];name' },
        operation: {
          kind: 'create-table',
          columns: [
            {
              name: 'a"`];column',
              type: { kind: 'varchar', length: 100 },
              nullable: false,
              default: { kind: 'text', value: "x'); DROP TABLE sample;--" },
            },
          ],
          constraints: [],
        },
      })
      expect(result.blockedReasons).toEqual([])
      expect(result.statements).toHaveLength(1)
      expect(result.statements[0]).toContain("x''); DROP TABLE sample;--")
      expect(result.statements[0]).toContain(engine === 'mssql' ? 'NVARCHAR(100)' : 'VARCHAR(100)')
    },
  )
  it('rejects arbitrary type SQL, expression defaults, duplicate columns and inappropriate type parameters', () => {
    const input = {
      target,
      operation: {
        kind: 'add-column',
        column: { name: 'data', type: { kind: 'text; DROP TABLE sample' }, nullable: true },
      },
    }
    expect(() => previewSchemaChangeSchema.parse(input)).toThrow()
    expect(() =>
      previewSchemaChangeSchema.parse({
        ...input,
        operation: {
          kind: 'add-column',
          column: {
            name: 'data',
            type: { kind: 'text' },
            nullable: true,
            default: { kind: 'expression', value: 'now()' },
          },
        },
      }),
    ).toThrow()
    expect(() =>
      previewSchemaChangeSchema.parse({
        ...input,
        operation: { kind: 'alter-column', name: 'id', type: { kind: 'text', length: 1 }, nullable: true },
      }),
    ).toThrow()
    expect(
      compileSchemaChange('postgres', {
        target,
        operation: {
          kind: 'create-table',
          columns: [
            { name: 'id', type: { kind: 'integer' }, nullable: false },
            { name: 'id', type: { kind: 'integer' }, nullable: false },
          ],
          constraints: [],
        },
      }).blockedReasons.join(),
    ).toMatch(/unique/)
  })
  it('never invents SQLite rebuilds, lossy MODIFY or unsupported DuckDB constraints', () => {
    for (const engine of ['mysql', 'mariadb', 'sqlite'] as const) {
      const result = compileSchemaChange(
        engine,
        {
          target,
          operation: { kind: 'alter-column', name: 'value', type: { kind: 'integer' }, nullable: false },
        },
        structure,
      )
      expect(result.statements).toEqual([])
      expect(result.blockedReasons).not.toEqual([])
    }
    for (const engine of ['sqlite', 'duckdb'] as const)
      expect(
        compileSchemaChange(
          engine,
          {
            target,
            operation: {
              kind: 'add-constraint',
              constraint: { kind: 'unique', name: 'value_unique', columns: ['value'] },
            },
          },
          structure,
        ).statements,
      ).toEqual([])
  })
  it('preserves exact large numeric literals, rejects mode-dependent backslashes and reports destructive warnings', () => {
    const input = {
      target,
      operation: {
        kind: 'add-column' as const,
        column: {
          name: 'number',
          type: { kind: 'decimal' as const, precision: 38, scale: 9 },
          nullable: false,
          default: { kind: 'number' as const, value: '12345678901234567890.123456789' },
        },
      },
    }
    expect(compileSchemaChange('postgres', input, structure).statements[0]).toContain(
      '12345678901234567890.123456789',
    )
    expect(
      compileSchemaChange(
        'mysql',
        {
          target,
          operation: {
            kind: 'add-column',
            column: {
              name: 'path',
              type: { kind: 'text' },
              nullable: true,
              default: { kind: 'text', value: 'a\\b' },
            },
          },
        },
        structure,
      ).blockedReasons.join(),
    ).toMatch(/SQL-mode/)
    expect(
      compileSchemaChange(
        'postgres',
        { target, operation: { kind: 'drop-column', name: 'value' } },
        structure,
      ).warnings.join(),
    ).toMatch(/permanently removed/)
  })
  it('uses the SQLite schema-qualified index syntax and exact ordered composite constraints', () => {
    expect(
      compileSchemaChange(
        'sqlite',
        {
          target,
          operation: { kind: 'create-index', name: 'new_idx', columns: ['value', 'id'], unique: false },
        },
        structure,
      ).statements,
    ).toEqual(['CREATE INDEX "main"."new_idx" ON "sample" ("value", "id");'])
    expect(
      compileSchemaChange(
        'postgres',
        {
          target,
          operation: {
            kind: 'add-constraint',
            constraint: {
              kind: 'foreign-key',
              name: 'fk',
              columns: ['value', 'id'],
              referencedSchema: 'other',
              referencedTable: 'parent',
              referencedColumns: ['name', 'id'],
            },
          },
        },
        structure,
      ).statements[0],
    ).toContain('FOREIGN KEY ("value", "id") REFERENCES "other"."parent" ("name", "id")')
  })
  it('does not pretend unfamiliar catalog types can be converted into portable DDL', () => {
    expect(schemaTypeFromCatalog('numeric(38,9)')).toEqual({ kind: 'decimal', precision: 38, scale: 9 })
    for (const type of [
      'integer[]',
      'timestamp with time zone',
      'varchar(9000)',
      'my_domain',
      'int unsigned',
      'geometry',
    ])
      expect(schemaTypeFromCatalog(type)).toBeUndefined()
  })
})
