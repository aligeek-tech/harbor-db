import { describe, expect, it } from 'vitest'
import {
  diagramId,
  diagramSchema,
  diagramSvg,
  focusedDiagram,
  schemaDiagram,
  type InspectedTable,
} from '../src/shared/schema-diagram'
const table = (schema: string, name: string): InspectedTable => ({
  database: 'db',
  schema,
  table: name,
  structure: {
    columns: [{ name: 'id', type: 'bigint', nullable: false, defaultValue: null, primaryKey: true }],
    indexes: [],
    constraints: [],
    ddl: '',
  },
})
describe('bounded authoritative schema diagram', () => {
  it('preserves ordered composite cross-schema keys, marks unloaded references, and focuses neighbors', () => {
    const orders = table('sales', 'orders'),
      customers = table('crm', 'customers'),
      unrelated = table('sales', 'other')
    orders.structure.foreignKeys = [
      {
        name: 'tenant_customer',
        columns: ['tenant', 'customer'],
        referencedSchema: 'crm',
        referencedTable: 'customers',
        referencedColumns: ['tenant', 'id'],
      },
    ]
    const partial = schemaDiagram('Catalog', [orders])
    expect(partial.nodes.find((node) => node.table === 'customers')).toMatchObject({
      inspected: false,
      columns: [],
    })
    expect(partial.edges[0]).toMatchObject({
      columns: ['tenant', 'customer'],
      referencedColumns: ['tenant', 'id'],
    })
    const full = schemaDiagram('Catalog', [orders, customers, unrelated])
    expect(focusedDiagram(full, diagramId(orders)).nodes.map((node) => node.table)).toEqual([
      'orders',
      'customers',
    ])
    expect(focusedDiagram(full, diagramId(unrelated)).edges).toEqual([])
    expect(schemaDiagram('No inference', [customers, unrelated]).edges).toEqual([])
  })
  it('escapes untrusted identifiers and produces passive self-contained SVG', () => {
    const graph = schemaDiagram('Title <script>alert(1)</script>', [
      table('x', '"><image href="https://secret.invalid"/>'),
    ])
    const svg = diagramSvg(graph)
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).not.toMatch(/<script|<image|<foreignObject|<[^>]*\shref=/)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })
  it('rejects oversized, ambiguous or malformed diagrams instead of exporting fake relationships', () => {
    const item = table('main', 't')
    expect(() =>
      schemaDiagram(
        'too many',
        Array.from({ length: 201 }, () => item),
      ),
    ).toThrow(/200/)
    const graph = schemaDiagram('Catalog', [item])
    expect(diagramSchema.safeParse({ ...graph, nodes: [...graph.nodes, ...graph.nodes] }).success).toBe(false)
    expect(
      diagramSchema.safeParse({
        ...graph,
        edges: [
          {
            name: 'invalid',
            source: diagramId(item),
            target: 'missing',
            columns: ['id'],
            referencedColumns: ['id'],
          },
        ],
      }).success,
    ).toBe(false)
  })
  it('renders the 200-table limit with bounded output and preserves every loaded edge', () => {
    const tables = Array.from({ length: 200 }, (_, index) => table('large', `table_${index}`))
    tables.forEach((item, index) => {
      if (index)
        item.structure.foreignKeys = [
          {
            name: `edge_${index}`,
            columns: ['id'],
            referencedSchema: 'large',
            referencedTable: `table_${index - 1}`,
            referencedColumns: ['id'],
          },
        ]
    })
    const started = performance.now(),
      graph = schemaDiagram('Large schema', tables),
      svg = diagramSvg(graph)
    expect(graph.edges).toHaveLength(199)
    expect(new TextEncoder().encode(svg).byteLength).toBeLessThan(1024 * 1024)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
