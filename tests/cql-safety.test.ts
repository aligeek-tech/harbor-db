import { describe, it, expect } from 'vitest'
import { once } from 'node:events'
import { cqlExecuteSchema, type CqlTable } from '../src/shared/cql'
import { guardCql } from '../src/main/engines/cql-guard'
import { cqlParameters, cqlCell } from '../src/main/engines/cql-values'
import { CqlFrameBound } from '../src/main/engines/cql-transport'
const table: CqlTable = {
  id: 'fixture',
  keyspace: 'harbor',
  name: 'events',
  partition: ['tenant', 'bucket'],
  clustering: ['sequence'],
  columns: [
    { name: 'tenant', type: 'text', kind: 'partition_key', position: 0 },
    { name: 'bucket', type: 'int', kind: 'partition_key', position: 1 },
    { name: 'sequence', type: 'bigint', kind: 'clustering', position: 0 },
    { name: 'version', type: 'int', kind: 'regular', position: -1 },
    { name: 'value', type: 'text', kind: 'regular', position: -1 },
  ],
}
const input = (cql: string, count: number, mutation = false) =>
  cqlExecuteSchema.parse({
    connectionId: 'c',
    sessionId: 's',
    requestId: 'r',
    keyspace: table.keyspace,
    table: table.name,
    cql,
    mode: mutation ? 'mutation' : 'read',
    parameters: Array.from({ length: count }, () => ({ type: 'text', value: 'x' })),
  })
describe('CQL explicit prepared grammar and typed boundaries', () => {
  it('requires every composite partition key unless scan is explicitly consented', () => {
    expect(
      guardCql(input('SELECT * FROM harbor.events WHERE tenant = ? AND bucket = ? LIMIT 25', 2), table)
        .mutation,
    ).toBe(false)
    expect(() => guardCql(input('SELECT * FROM harbor.events WHERE tenant = ? LIMIT 25', 1), table)).toThrow(
      'every partition',
    )
    expect(() => guardCql(input('SELECT * FROM harbor.events LIMIT 25', 0), table)).toThrow('partition')
    expect(
      guardCql({ ...input('SELECT * FROM harbor.events LIMIT 25', 0), allowScan: true }, table),
    ).toBeDefined()
    expect(() =>
      guardCql(
        {
          ...input('SELECT * FROM harbor.events WHERE value = ? LIMIT 25 ALLOW FILTERING', 1),
          allowScan: true,
        },
        table,
      ),
    ).toThrow('separate explicit')
    expect(
      guardCql(
        {
          ...input('SELECT * FROM harbor.events WHERE value = ? LIMIT 25 ALLOW FILTERING', 1),
          allowScan: true,
          allowFiltering: true,
        },
        table,
      ),
    ).toBeDefined()
  })
  it('rejects changed target, unbounded projections, literal values, functions and stacked CQL', () => {
    for (const cql of [
      'SELECT * FROM other.events WHERE tenant = ? AND bucket = ? LIMIT 25',
      'SELECT count(*) FROM harbor.events WHERE tenant = ? AND bucket = ? LIMIT 25',
      'SELECT * FROM harbor.events WHERE tenant = ? AND bucket = ?',
      'SELECT * FROM harbor.events WHERE tenant = ? AND bucket = ? LIMIT 1001',
      'SELECT * FROM harbor.events WHERE tenant = ? AND bucket = ? LIMIT 25; DROP TABLE harbor.events',
      "SELECT * FROM harbor.events WHERE tenant = 'secret' AND bucket = ? LIMIT 25",
      'SELECT * FROM harbor.events WHERE tenant = ? AND bucket = ? LIMIT 25 /* comment */',
    ])
      expect(() => guardCql(input(cql, 2), table)).toThrow()
  })
  it('requires complete primary key and native condition for mutations', () => {
    expect(
      guardCql(
        input(
          'INSERT INTO harbor.events (tenant,bucket,sequence,value) VALUES (?,?,?,?) IF NOT EXISTS',
          4,
          true,
        ),
        table,
      ).mutation,
    ).toBe(true)
    expect(
      guardCql(
        input(
          'UPDATE harbor.events SET value = ? WHERE tenant = ? AND bucket = ? AND sequence = ? IF version = ?',
          5,
          true,
        ),
        table,
      ).mutation,
    ).toBe(true)
    expect(
      guardCql(
        input(
          'DELETE FROM harbor.events WHERE tenant = ? AND bucket = ? AND sequence = ? IF version = ?',
          4,
          true,
        ),
        table,
      ).mutation,
    ).toBe(true)
    for (const cql of [
      'UPDATE harbor.events SET value = ? WHERE tenant = ? AND bucket = ? IF version = ?',
      'UPDATE harbor.events SET sequence = ? WHERE tenant = ? AND bucket = ? AND sequence = ? IF version = ?',
      'DELETE FROM harbor.events WHERE tenant = ? AND bucket = ? AND sequence = ?',
      'BEGIN BATCH DELETE FROM harbor.events WHERE tenant = ?; APPLY BATCH',
    ])
      expect(() => guardCql(input(cql, 4, true), table)).toThrow()
  })
  it('preserves nested arbitrary integer/decimal/time/blob values using driver public types', () => {
    const values = cqlParameters([
      { type: 'bigint', value: '9223372036854775807' },
      { type: 'varint', value: '12345678901234567890123456789012345678901234567890' },
      { type: 'decimal', value: '12345678901234567890.12345678901234567890' },
      { type: 'time', value: '12:34:56.123456789' },
      { type: 'blob', value: 'AP+A' },
      {
        type: 'map',
        value: JSON.stringify([
          [
            { type: 'text', value: 'exact' },
            { type: 'bigint', value: '9007199254740993' },
          ],
        ]),
      },
    ])
    const encoded = values.map(cqlCell)
    expect(encoded[0]).toContain('9223372036854775807')
    expect(encoded[1]).toContain('12345678901234567890123456789012345678901234567890')
    expect(encoded[2]).toContain('12345678901234567890.12345678901234567890')
    expect(encoded[3]).toContain('123456789')
    expect(encoded[4]).toContain('AP+A')
    expect(encoded[5]).toContain('9007199254740993')
    expect(() => cqlParameters([{ type: 'bigint', value: '9223372036854775808' }])).toThrow('64-bit')
    expect(() => cqlParameters([{ type: 'float', value: '3.5e38' }])).toThrow('32-bit')
    expect(() => cqlParameters([{ type: 'timestamp', value: '2026-09-18T12:00:00.123456789Z' }])).toThrow(
      'millisecond',
    )
  })
})
describe('CQL v4 frame boundary transport', () => {
  const frame = (size: number) => {
    const header = Buffer.alloc(9)
    header[0] = 0x84
    header[4] = 8
    header.writeInt32BE(size, 5)
    return header
  }
  it('passes split headers and consecutive frames without altering native bytes', async () => {
    const bound = new CqlFrameBound(),
      chunks: Buffer[] = []
    bound.on('data', (chunk) => chunks.push(chunk))
    const bytes = Buffer.concat([frame(3), Buffer.from('abc'), frame(0), frame(4), Buffer.from('defg')])
    const end = once(bound, 'end')
    for (let i = 0; i < bytes.length; i += 2) bound.write(bytes.subarray(i, i + 2))
    bound.end()
    await end
    expect(Buffer.concat(chunks)).toEqual(bytes)
  })
  it('rejects a declared oversized frame before its body is delivered', async () => {
    const bound = new CqlFrameBound(),
      chunks: Buffer[] = []
    bound.on('data', (chunk) => chunks.push(chunk))
    const error = once(bound, 'error')
    bound.end(frame(8 * 1024 * 1024 + 1))
    expect(String((await error)[0])).toContain('8 MiB')
    expect(chunks).toHaveLength(0)
  })
  it('rejects compressed frames and truncated native responses', async () => {
    const compressed = new CqlFrameBound(),
      header = frame(0)
    header[1] = 1
    const error = once(compressed, 'error')
    compressed.end(header)
    expect(String((await error)[0])).toContain('uncompressed')
    const partial = new CqlFrameBound()
    partial.resume()
    const truncated = once(partial, 'error')
    partial.end(Buffer.concat([frame(4), Buffer.from('a')]))
    expect(String((await truncated)[0])).toContain('prematurely')
  })
})
