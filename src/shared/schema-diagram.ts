import { z } from 'zod'
import type { TableStructure } from './contracts'

const name = z.string().min(1).max(1024)
export const diagramNodeSchema = z
  .object({
    database: z.string().max(1024).optional(),
    schema: name,
    table: name,
    inspected: z.boolean(),
    columns: z
      .array(z.object({ name, type: z.string().max(1024), primaryKey: z.boolean() }).strict())
      .max(2000),
  })
  .strict()
export const diagramSchema = z
  .object({
    title: z.string().max(2000),
    nodes: z.array(diagramNodeSchema).max(400),
    edges: z
      .array(
        z
          .object({
            name,
            source: name,
            target: name,
            columns: z.array(name).max(64),
            referencedColumns: z.array(name).max(64),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict()
  .superRefine((graph, context) => {
    const ids = new Set(graph.nodes.map(diagramId))
    if (
      ids.size !== graph.nodes.length ||
      graph.edges.some(
        (edge) =>
          !ids.has(edge.source) ||
          !ids.has(edge.target) ||
          !edge.columns.length ||
          edge.columns.length !== edge.referencedColumns.length,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Diagram contains duplicate identities or an incomplete relationship.',
      })
  })
export type DiagramNode = z.infer<typeof diagramNodeSchema>
export type SchemaDiagramData = z.infer<typeof diagramSchema>
export const diagramId = (node: { database?: string; schema: string; table: string }): string =>
  JSON.stringify([node.database || '', node.schema, node.table])
export interface InspectedTable {
  database?: string
  schema: string
  table: string
  structure: TableStructure
}
export function schemaDiagram(title: string, tables: InspectedTable[]): SchemaDiagramData {
  if (tables.length > 200) throw new Error('Inspect at most 200 tables per diagram.')
  const nodes = new Map<string, DiagramNode>(),
    edges: SchemaDiagramData['edges'] = []
  for (const table of tables)
    nodes.set(diagramId(table), {
      database: table.database,
      schema: table.schema,
      table: table.table,
      inspected: true,
      columns: table.structure.columns.map(({ name, type, primaryKey }) => ({ name, type, primaryKey })),
    })
  for (const table of tables)
    for (const key of table.structure.foreignKeys || []) {
      const target = {
        database: key.referencedDatabase || table.database,
        schema: key.referencedSchema,
        table: key.referencedTable,
      }
      if (!nodes.has(diagramId(target)))
        nodes.set(diagramId(target), { ...target, inspected: false, columns: [] })
      edges.push({
        name: key.name,
        source: diagramId(table),
        target: diagramId(target),
        columns: key.columns,
        referencedColumns: key.referencedColumns,
      })
    }
  return diagramSchema.parse({ title, nodes: [...nodes.values()], edges })
}
export function focusedDiagram(graph: SchemaDiagramData, focus: string): SchemaDiagramData {
  if (!focus) return graph
  const edges = graph.edges.filter((edge) => edge.source === focus || edge.target === focus)
  const included = new Set([focus, ...edges.flatMap((edge) => [edge.source, edge.target])])
  return { ...graph, nodes: graph.nodes.filter((node) => included.has(diagramId(node))), edges }
}
export const diagramLayout = (graph: SchemaDiagramData) => {
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length))))
  return {
    width: columns * 350 + 40,
    height: Math.max(1, Math.ceil(graph.nodes.length / columns)) * 220 + 60,
    nodes: graph.nodes.map((node, index) => ({
      ...node,
      id: diagramId(node),
      x: 20 + (index % columns) * 350,
      y: 50 + Math.floor(index / columns) * 220,
    })),
  }
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!,
  )
const short = (value: string) => (value.length > 42 ? value.slice(0, 39) + '…' : value)
/** Generates passive local SVG, with no scripts, links, embedded HTML, images, or external resources. */
export function diagramSvg(input: SchemaDiagramData): string {
  const graph = diagramSchema.parse(input),
    layout = diagramLayout(graph)
  const positions = new Map(layout.nodes.map((node) => [node.id, node]))
  const lines = graph.edges
    .map((edge) => {
      const source = positions.get(edge.source)!,
        target = positions.get(edge.target)!
      return `<path d="M ${source.x + 310} ${source.y + 35} C ${source.x + 345} ${source.y + 35}, ${target.x - 35} ${target.y + 35}, ${target.x} ${target.y + 35}" fill="none" stroke="#64748b" marker-end="url(#arrow)"><title>${escape(edge.name + ': ' + edge.columns.join(', ') + ' → ' + edge.referencedColumns.join(', '))}</title></path>`
    })
    .join('')
  const nodes = layout.nodes
    .map(
      (node) =>
        `<g><title>${escape(`${node.database ? node.database + '.' : ''}${node.schema}.${node.table}`)}</title><rect x="${node.x}" y="${node.y}" width="310" height="190" rx="7" fill="#fff" stroke="#334155"${node.inspected ? '' : ' stroke-dasharray="5 4"'}/><text x="${node.x + 12}" y="${node.y + 24}" font-weight="bold">${escape(short(node.schema + '.' + node.table))}</text>${
          !node.inspected
            ? `<text x="${node.x + 12}" y="${node.y + 50}">Referenced table · not inspected</text>`
            : node.columns
                .slice(0, 6)
                .map(
                  (column, i) =>
                    `<text x="${node.x + 12}" y="${node.y + 48 + i * 20}">${escape(short((column.primaryKey ? 'PK ' : '') + column.name + ' : ' + column.type))}</text>`,
                )
                .join('')
        }${node.columns.length > 6 ? `<text x="${node.x + 12}" y="${node.y + 174}">+${node.columns.length - 6} columns · inspect in app</text>` : ''}</g>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img"><title>${escape(graph.title)}</title><desc>Inspected database foreign keys only. Dashed tables have not been inspected. Missing edges do not prove absence of constraints.</desc><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#64748b"/></marker></defs><rect width="100%" height="100%" fill="#f8fafc"/><g font-family="monospace" font-size="12" fill="#0f172a"><text x="20" y="24">${escape(short(graph.title))}</text>${lines}${nodes}</g></svg>`
}
