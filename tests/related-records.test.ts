import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../src/shared/contracts'
import { relatedRecordTarget, type ForeignKeyInfo } from '../src/shared/related-records'

const key: ForeignKeyInfo = {
  name: 'line_customer_fk',
  columns: ['tenant_id', 'customer_id'],
  referencedDatabase: 'database',
  referencedSchema: 'crm',
  referencedTable: 'customers',
  referencedColumns: ['tenant_id', 'id'],
}
const result: ResultSet = {
  columns: [
    { name: 'tenant_id', type: 'bigint' },
    { name: 'customer_id', type: 'text' },
  ],
  rows: [['9007199254740993', "x'; DELETE FROM customers; --"]],
  affectedRows: 0,
  command: 'SELECT',
  truncated: false,
}

describe('declared related-record navigation', () => {
  it('preserves composite tuple pairing, cross-schema scope, precision and private binding', () => {
    const target = relatedRecordTarget(key, result, 0, 'postgres', 'other').target!
    expect(target.database).toBe('database')
    expect(target.sql).toBe(
      'SELECT * FROM "crm"."customers"\nWHERE "tenant_id" = $1 AND "id" = $2\nLIMIT 200;',
    )
    expect(target.sql).not.toContain('DELETE')
    expect(target.parameters).toEqual([
      { name: 'foreign_key_1', type: 'integer', secret: true, value: '9007199254740993' },
      { name: 'foreign_key_2', type: 'text', secret: true, value: "x'; DELETE FROM customers; --" },
    ])
  })
  it.each(['mysql', 'mariadb', 'sqlite', 'duckdb'] as const)(
    'uses ordered native placeholders for %s',
    (dialect) => {
      const target = relatedRecordTarget(key, result, 0, dialect).target!
      expect(target.sql.match(/ = \?/g)).toHaveLength(2)
      expect(target.parameters.map((parameter) => parameter.value)).toEqual(result.rows[0])
    },
  )
  it('does not issue a lookup for missing, NULL, incomplete or ambiguous tuples', () => {
    expect(relatedRecordTarget(key, result, undefined, 'postgres').reason).toContain('Select one')
    expect(relatedRecordTarget(key, { ...result, rows: [['1', null]] }, 0, 'postgres').reason).toContain(
      'NULL',
    )
    expect(relatedRecordTarget({ ...key, referencedColumns: [] }, result, 0, 'postgres').reason).toContain(
      'complete ordered',
    )
    expect(
      relatedRecordTarget(key, { ...result, columns: [...result.columns, result.columns[0]] }, 0, 'postgres')
        .reason,
    ).toContain('ambiguous')
    expect(
      relatedRecordTarget(key, { ...result, rows: [[9007199254740992, 'id']] }, 0, 'postgres').reason,
    ).toContain('exactly')
  })
  it('retains binary key bytes as private base64 parameters and quotes catalog identifiers', () => {
    const binary: ResultSet = {
      ...result,
      columns: [{ name: 'binary_id', type: 'bytea' }],
      rows: [[{ type: 'binary', base64: 'AP8=' }]],
    }
    const target = relatedRecordTarget(
      {
        ...key,
        columns: ['binary_id'],
        referencedSchema: 'strange"schema',
        referencedTable: 'parent',
        referencedColumns: ['key"name'],
      },
      binary,
      0,
      'postgres',
    ).target!
    expect(target.sql).toContain('"strange""schema"."parent"')
    expect(target.sql).toContain('"key""name" = $1')
    expect(target.parameters[0]).toMatchObject({ type: 'binary', secret: true, value: 'AP8=' })
  })
})
