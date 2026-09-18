import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile, ObjectInfo } from '@shared/contracts'
import {
  diagramId,
  diagramSvg,
  focusedDiagram,
  schemaDiagram,
  type InspectedTable,
} from '@shared/schema-diagram'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

/** Each explicit batch inspects at most twenty table catalogs, never table rows. */
export function SchemaDiagram({
  profile,
  database,
  initialSchema,
  initialTable,
  onClose,
}: {
  profile: ConnectionProfile
  database?: string
  initialSchema: string
  initialTable: string
  onClose: () => void
}) {
  const [objects, setObjects] = useState<ObjectInfo[]>([]),
    [tables, setTables] = useState<InspectedTable[]>([])
  const [schema, setSchema] = useState(initialSchema),
    [search, setSearch] = useState(''),
    [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  useEffect(() => {
    const version = ++generation.current
    setBusy(true)
    void api
      .listObjects({ connectionId: profile.id, database })
      .then((items) => {
        if (generation.current === version) setObjects(items.filter((item) => item.kind === 'table'))
      })
      .catch((failure) => {
        if (generation.current === version) setError(errorText(failure))
      })
      .finally(() => {
        if (generation.current === version) setBusy(false)
      })
    return () => {
      generation.current++
    }
  }, [profile.id, database])
  const scoped = useMemo(
    () =>
      objects
        .filter(
          (object) =>
            (!schema || object.schema === schema) &&
            `${object.schema}.${object.name}`.toLowerCase().includes(search.toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(b.name === initialTable && b.schema === initialSchema) -
              Number(a.name === initialTable && a.schema === initialSchema) ||
            `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
        ),
    [objects, schema, search, initialSchema, initialTable],
  )
  const loaded = useMemo(() => new Set(tables.map(diagramId)), [tables])
  const pending = scoped.filter(
    (object) =>
      !loaded.has(
        diagramId({ database: object.database || database, schema: object.schema, table: object.name }),
      ),
  )
  const graph = useMemo(
    () => schemaDiagram(`${profile.name} · ${database || profile.database || 'Local database'}`, tables),
    [profile.name, profile.database, database, tables],
  )
  const visible = useMemo(() => focusedDiagram(graph, focus), [graph, focus])
  const svg = useMemo(
    () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(diagramSvg(visible)),
    [visible],
  )
  async function load() {
    const version = ++generation.current
    setBusy(true)
    setError('')
    setNotice('')
    let count = 0
    try {
      const next: InspectedTable[] = []
      for (const object of pending.slice(0, Math.min(20, 200 - tables.length))) {
        const target = {
          connectionId: profile.id,
          database: object.database || database,
          schema: object.schema,
          table: object.name,
        }
        const structure = await api.structure(target)
        if (generation.current !== version) return
        next.push({ ...target, structure })
        schemaDiagram(profile.name, [...tables, ...next])
        count++
        // Commit each completed catalog so one inaccessible table does not discard previous results.
        setTables((current) => [...current, { ...target, structure }])
      }
      setNotice(`${count} table catalogs inspected. No table rows were read.`)
    } catch (failure) {
      if (generation.current === version) setError(errorText(failure))
    } finally {
      if (generation.current === version) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-6xl flex-col">
        <DialogHeader>
          <DialogTitle>Schema relationships</DialogTitle>
          <DialogDescription>
            {profile.name} · {database || profile.database || 'Local database'} · {profile.environment}.
            Database foreign keys only; no name-based inference. Catalog permissions limit visibility.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <label>
            Schema
            <select
              aria-label="Diagram schema"
              value={schema}
              disabled={busy}
              onChange={(event) => setSchema(event.target.value)}
            >
              <option value="">All visible schemas</option>
              {[...new Set([initialSchema, ...objects.map((object) => object.schema)])]
                .sort()
                .map((value) => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </label>
          <label>
            Find tables
            <Input
              aria-label="Find diagram tables"
              value={search}
              disabled={busy}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button disabled={busy || !pending.length || tables.length >= 200} onClick={() => void load()}>
            Inspect next {Math.min(20, pending.length, 200 - tables.length)} tables
          </Button>
          {busy && (
            <Button
              variant="outline"
              onClick={() => {
                generation.current++
                setBusy(false)
                setNotice(
                  'Stopped waiting. An in-flight metadata read may finish on the server; no further tables will be inspected.',
                )
              }}
            >
              Stop waiting
            </Button>
          )}
          <Button
            variant="outline"
            disabled={!tables.length || busy}
            onClick={() => {
              setTables([])
              setFocus('')
              setNotice('Diagram cleared. Choose the next scope and inspect again.')
            }}
          >
            Clear diagram
          </Button>
          <Button
            variant="outline"
            disabled={!visible.nodes.length}
            onClick={async () => {
              try {
                const result = await api.exportSchemaDiagram(visible)
                if (!result.cancelled) setNotice(`Saved local SVG: ${result.path}`)
              } catch (failure) {
                setError(errorText(failure))
              }
            }}
          >
            Export diagram SVG
          </Button>
        </div>
        <p className="text-xs muted">
          {scoped.length} catalog tables match this scope; {tables.length}/200 inspected. Scope filters select
          the next batch; existing nodes stay until cleared. Incoming relationships appear only after their
          source table is inspected. Dashed nodes are references whose columns have not been inspected.
        </p>
        <label>
          Focused neighborhood
          <select
            aria-label="Focused relationship neighborhood"
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
          >
            <option value="">All loaded relationships</option>
            {graph.nodes.map((node) => (
              <option key={diagramId(node)} value={diagramId(node)}>
                {node.schema}.{node.table}
                {node.inspected ? '' : ' (not inspected)'}
              </option>
            ))}
          </select>
        </label>
        {error && <ErrorPanel message={error} />}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="min-h-0 overflow-auto rounded border bg-white" aria-label="Relationship diagram">
          <img
            src={svg}
            alt={`Foreign-key diagram: ${visible.nodes.length} tables and ${visible.edges.length} inspected constraints. Full mappings appear below.`}
            className="max-w-none"
          />
        </div>
        <details>
          <summary>{visible.edges.length} exact foreign-key mappings</summary>
          <div className="max-h-48 overflow-auto">
            <table>
              <thead>
                <tr>
                  <th>Constraint</th>
                  <th>Source</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {visible.edges.map((edge, index) => (
                  <tr key={index}>
                    <td>{edge.name}</td>
                    <td>
                      {edge.source}: {edge.columns.join(', ')}
                    </td>
                    <td>
                      {edge.target}: {edge.referencedColumns.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </DialogContent>
    </Dialog>
  )
}
