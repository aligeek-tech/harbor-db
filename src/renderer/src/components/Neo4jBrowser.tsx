import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import {
  neoConfirmation,
  neoParameterSchema,
  type NeoPage,
  type NeoNode,
  type NeoRelationship,
} from '@shared/neo4j'
import { api } from '../lib/api'
import { useApp } from '../store'
import { errorText } from '../lib/utils'
import { ErrorPanel } from './common'
import { Button } from './ui/button'
import { Input } from './ui/input'
export function Neo4jBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const [database, setDatabase] = useState(tab.database || profile.database),
    [databases, setDatabases] = useState<string[]>([]),
    [cypher, setCypher] = useState('MATCH (n) RETURN n LIMIT 25'),
    [parameters, setParameters] = useState('[]'),
    [mode, setMode] = useState<'read' | 'mutation'>('read'),
    [confirm, setConfirm] = useState(''),
    [page, setPage] = useState<NeoPage>(),
    [selected, setSelected] = useState<NeoNode>(),
    [selectedRelationship, setSelectedRelationship] = useState<NeoRelationship>(),
    [activeRequest, setActiveRequest] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [view, setView] = useState<'table' | 'graph'>('table')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void api
      .neoDatabases(profile.id)
      .then(setDatabases)
      .catch((error) => setError(errorText(error)))
    return () => {
      mounted.current = false
      void api.closeSession({ connectionId: profile.id, sessionId: tab.id }).catch(() => {})
    }
  }, [profile.id, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy })
    return () => useApp.getState().setRuntime(tab.id, { running: false })
  }, [busy, tab.id])
  const invoke = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      setActiveRequest(undefined)
      if (mounted.current) setBusy(false)
    }
  }
  const run = () =>
    void invoke(async () => {
      await api.closeSession({ connectionId: profile.id, sessionId: tab.id })
      setPage(undefined)
      setSelected(undefined)
      setSelectedRelationship(undefined)
      const requestId = crypto.randomUUID()
      setActiveRequest(requestId)
      const values = neoParameterSchema.array().max(100).parse(JSON.parse(parameters))
      const result = await api.neoQuery({
        connectionId: profile.id,
        sessionId: tab.id,
        requestId,
        database,
        cypher,
        parameters: values,
        mode,
        pageSize: 25,
        confirm: mode === 'mutation' ? confirm : undefined,
      })
      if (mounted.current) {
        setPage(result)
        setConfirm('')
      }
    })
  const coords = new Map(
    (page?.nodes || []).map((node, index) => {
      const angle = (2 * Math.PI * index) / Math.max(page?.nodes.length || 1, 1)
      return [node.id, { x: 340 + 250 * Math.cos(angle), y: 220 + 175 * Math.sin(angle) }]
    }),
  )
  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', width: '100%' }}>
      <h2>Neo4j Cypher workspace</h2>
      <p>
        {profile.name} · {profile.host}:{profile.port} · {profile.environment} ·{' '}
        {profile.readOnly ? 'Read-only safeguard' : 'Writes enabled'}
      </p>
      <p>
        Queries run explicitly. Pages continue one execution; Neo4j read-committed isolation is not a
        snapshot. Closing a cursor stops its dedicated connection. Mutations use one reviewed native
        transaction and are never replayed.
      </p>
      <label>
        Graph database
        <Input
          aria-label="Neo4j database"
          list={'neo-databases-' + tab.id}
          value={database}
          disabled={busy || !!page?.cursor}
          onChange={(e) => {
            setDatabase(e.target.value)
            setPage(undefined)
            setSelected(undefined)
            setSelectedRelationship(undefined)
            setConfirm('')
          }}
        />
      </label>
      <datalist id={'neo-databases-' + tab.id}>
        {databases.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <label>
        Cypher
        <textarea
          aria-label="Neo4j Cypher"
          className="w-full font-mono"
          rows={6}
          value={cypher}
          disabled={busy || !!page?.cursor}
          onChange={(e) => {
            setCypher(e.target.value)
            setConfirm('')
          }}
        />
      </label>
      <label>
        Typed parameters
        <textarea
          aria-label="Neo4j typed parameters"
          className="w-full font-mono"
          rows={3}
          value={parameters}
          disabled={busy || !!page?.cursor}
          onChange={(e) => {
            setParameters(e.target.value)
            setConfirm('')
          }}
        />
      </label>
      <p>
        JSON array: name, type and string value. Types: string, integer, float, boolean, null, date, datetime,
        duration, json. Integers use exact signed 64-bit text; temporal values preserve native precision.
      </p>
      <label>
        Execution mode
        <select
          aria-label="Neo4j execution mode"
          value={mode}
          disabled={busy || !!page?.cursor}
          onChange={(e) => {
            setMode(e.target.value as typeof mode)
            setConfirm('')
          }}
        >
          <option value="read">Read Cypher</option>
          <option value="mutation" disabled={profile.readOnly}>
            Reviewed graph mutation
          </option>
        </select>
      </label>
      {mode === 'mutation' && (
        <>
          <p>
            Review the complete Cypher and parameters. Up to 500 returned rows are allowed; exceeding the
            result bound rolls back before commit. Procedures, external data loading and administration are
            excluded.
          </p>
          <p>
            Type: <code>{neoConfirmation(profile.id, database)}</code>
          </p>
          <Input
            aria-label="Confirm Neo4j mutation"
            value={confirm}
            disabled={busy || !!page?.cursor}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy || !database || (mode === 'mutation' && confirm !== neoConfirmation(profile.id, database))
          }
          onClick={run}
        >
          Run Cypher
        </Button>
        <Button
          variant="outline"
          disabled={busy || !page?.cursor}
          onClick={() =>
            void invoke(async () => {
              const requestId = crypto.randomUUID()
              setActiveRequest(requestId)
              setPage(
                await api.neoNext({
                  connectionId: profile.id,
                  sessionId: tab.id,
                  requestId,
                  cursor: page!.cursor!,
                }),
              )
              setSelected(undefined)
              setSelectedRelationship(undefined)
            })
          }
        >
          Next Cypher page
        </Button>
        <Button
          variant="outline"
          disabled={busy || !page?.cursor}
          onClick={() =>
            void invoke(async () => {
              await api.closeSession({ connectionId: profile.id, sessionId: tab.id })
              setPage((current) => (current ? { ...current, cursor: undefined } : current))
              setNotice('Cursor closed. Run again explicitly to obtain fresh results.')
            })
          }
        >
          Close Cypher cursor
        </Button>
        {busy && activeRequest && (
          <Button
            onClick={() =>
              void api
                .neoCancel({ connectionId: profile.id, sessionId: tab.id, requestId: activeRequest! })
                .then((result) => setNotice(result.message))
                .catch((error) => setError(errorText(error)))
            }
          >
            Cancel Cypher
          </Button>
        )}
      </div>
      {error && <ErrorPanel message={error} />} {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <p role="status">
            Result database: {page.database} · {page.rows.length} rows on page · {page.rowsRead} rows read ·{' '}
            {page.durationMs} ms ·{' '}
            {page.mutationAcknowledged
              ? 'Mutation committed and acknowledged'
              : page.cursor
                ? 'Cursor open'
                : 'Read complete'}
          </p>
          <p>{page.warning}</p>
          {page.counters && (
            <pre aria-label="Neo4j mutation counters">{JSON.stringify(page.counters, null, 2)}</pre>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setView('table')}>
              Table results
            </Button>
            <Button variant="outline" onClick={() => setView('graph')}>
              Graph results
            </Button>
          </div>
          {view === 'table' ? (
            <div style={{ overflow: 'auto' }}>
              <table aria-label="Neo4j result table">
                <thead>
                  <tr>
                    {page.columns.map((name, index) => (
                      <th key={index}>{name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, index) => (
                    <tr key={index}>
                      {row.map((cell, column) => (
                        <td key={column}>
                          <small>{cell.type}</small>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              maxWidth: 420,
                              maxHeight: 180,
                              overflow: 'auto',
                            }}
                          >
                            {cell.value === null ? 'NULL' : cell.value}
                          </pre>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <p>
                {page.nodes.length} nodes · {page.relationships.length} relationships{' '}
                {page.graphTruncated ? '· Graph display truncated' : ''}. Select a node to inspect its
                properties. Only entities returned by this query are drawn.
              </p>
              <svg
                role="img"
                aria-label="Bounded Neo4j graph"
                viewBox="0 0 680 440"
                style={{ width: '100%', minWidth: 500, maxHeight: 480 }}
              >
                {page.relationships.map((edge) => {
                  const start = coords.get(edge.start),
                    end = coords.get(edge.end)
                  return start && end ? (
                    <g
                      key={edge.id}
                      role="button"
                      tabIndex={0}
                      aria-label={'Inspect Neo4j relationship ' + edge.id}
                      onClick={() => {
                        setSelected(undefined)
                        setSelectedRelationship(edge)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          setSelected(undefined)
                          setSelectedRelationship(edge)
                        }
                      }}
                    >
                      <line
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        stroke="currentColor"
                        opacity="0.4"
                      />
                      <text
                        x={(start.x + end.x) / 2}
                        y={(start.y + end.y) / 2}
                        fill="currentColor"
                        fontSize={10}
                      >
                        {edge.type}
                      </text>
                    </g>
                  ) : null
                })}
                {page.nodes.map((node) => {
                  const position = coords.get(node.id)!
                  return (
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={'Inspect Neo4j node ' + node.id}
                      onClick={() => {
                        setSelected(node)
                        setSelectedRelationship(undefined)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          setSelected(node)
                          setSelectedRelationship(undefined)
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle
                        cx={position.x}
                        cy={position.y}
                        r={16}
                        fill={selected?.id === node.id ? '#e6a04b' : '#287d9f'}
                      />
                      <text
                        x={position.x}
                        y={position.y + 30}
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize={11}
                      >
                        {node.labels.join(':').slice(0, 24) || 'Node'}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </>
          )}
          {selectedRelationship && (
            <section aria-label="Neo4j relationship inspector">
              <h3>{selectedRelationship.type}</h3>
              <p>
                {selectedRelationship.start} → {selectedRelationship.end}
              </p>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{selectedRelationship.properties}</pre>
            </section>
          )}
          {selected && (
            <section aria-label="Neo4j property inspector">
              <h3>{selected.labels.join(':') || 'Node'}</h3>
              <p>
                Element ID: {selected.id}. IDs are scoped to this database and may become invalid after
                deletion; review current results before mutation.
              </p>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{selected.properties}</pre>
              <Button
                disabled={busy || !!page?.cursor}
                onClick={() => {
                  setCypher(
                    'MATCH (n) WHERE elementId(n) = $elementId OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 50',
                  )
                  setParameters(JSON.stringify([{ name: 'elementId', type: 'string', value: selected.id }]))
                  setMode('read')
                  setConfirm('')
                  setNotice(
                    'Prepared a one-hop query limited to 50 rows. Review and press Run Cypher; no expansion has run yet.',
                  )
                }}
              >
                Prepare one-hop expansion
              </Button>
            </section>
          )}
        </>
      )}
    </div>
  )
}
