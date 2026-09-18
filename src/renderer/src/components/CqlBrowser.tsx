import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import {
  cqlConfirmation,
  cqlQuote,
  cqlParameterSchema,
  type CqlTable,
  type CqlPage,
  type CqlExecute,
  type CqlParameter,
} from '@shared/cql'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { ErrorPanel } from './common'
import { Input } from './ui/input'
import { Button } from './ui/button'
function emptyParameter(type: string): CqlParameter {
  const aliases: Record<string, CqlParameter['type']> = { varchar: 'text', counter: 'bigint' }
  const kind = (aliases[type] || type) as CqlParameter['type']
  const values: Record<string, string> = {
    text: '',
    ascii: '',
    int: '0',
    smallint: '0',
    tinyint: '0',
    bigint: '0',
    varint: '0',
    decimal: '0',
    float: '0',
    double: '0',
    boolean: 'false',
    uuid: '00000000-0000-0000-0000-000000000000',
    timeuuid: '00000000-0000-1000-8000-000000000000',
    timestamp: '2000-01-01T00:00:00.000Z',
    date: '2000-01-01',
    time: '00:00:00.000000000',
    duration: '0s',
    inet: '127.0.0.1',
    blob: '',
  }
  return kind in values ? { type: kind, value: values[kind]! } : { type: 'null', value: '' }
}
export function CqlBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const [keyspace, setKeyspace] = useState(tab.database || profile.database),
    [keyspaces, setKeyspaces] = useState<string[]>([]),
    [tableName, setTableName] = useState(''),
    [tables, setTables] = useState<string[]>([]),
    [table, setTable] = useState<CqlTable>(),
    [cql, setCql] = useState(''),
    [parameters, setParameters] = useState('[]'),
    [mode, setMode] = useState<'read' | 'mutation'>('read'),
    [consistency, setConsistency] = useState<CqlExecute['consistency']>('localOne'),
    [scan, setScan] = useState(false),
    [filtering, setFiltering] = useState(false),
    [confirm, setConfirm] = useState(''),
    [page, setPage] = useState<CqlPage>(),
    [busy, setBusy] = useState(false),
    [request, setRequest] = useState<string>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void api
      .cqlKeyspaces(profile.id)
      .then((values) => {
        if (mounted.current) setKeyspaces(values)
      })
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
  const invoke = async (work: (requestId: string) => Promise<void>) => {
    const id = crypto.randomUUID()
    setRequest(id)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work(id)
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) {
        setBusy(false)
        setRequest(undefined)
      }
    }
  }
  const locked = busy || !!page?.cursor,
    close = () => api.closeSession({ connectionId: profile.id, sessionId: tab.id })
  const prepare = (target: CqlTable, kind: 'read' | 'insert' | 'update' | 'delete') => {
    const name = cqlQuote(target.keyspace) + '.' + cqlQuote(target.name),
      keys = [...target.partition, ...target.clustering],
      regular = target.columns.find((column) => column.kind === 'regular' && column.type !== 'counter'),
      version = target.columns.find((column) => column.name === 'version') || regular
    let fields: string[] = [],
      query = ''
    if (kind === 'read') {
      fields = target.partition
      query = `SELECT * FROM ${name} WHERE ${fields.map((name) => cqlQuote(name) + ' = ?').join(' AND ')} LIMIT 100`
    } else if (kind === 'insert') {
      fields = target.columns.filter((column) => column.type !== 'counter').map((column) => column.name)
      query = `INSERT INTO ${name} (${fields.map(cqlQuote).join(', ')}) VALUES (${fields.map(() => '?').join(', ')}) IF NOT EXISTS`
    } else {
      if (!regular || !version) {
        setNotice('No regular field is available for a conditional mutation example.')
        return
      }
      fields = [...(kind === 'update' ? [regular.name] : []), ...keys, version.name]
      query = `${kind === 'update' ? `UPDATE ${name} SET ${cqlQuote(regular.name)} = ?` : `DELETE FROM ${name}`} WHERE ${keys.map((name) => cqlQuote(name) + ' = ?').join(' AND ')} IF ${cqlQuote(version.name)} = ?`
    }
    setCql(query)
    setParameters(
      JSON.stringify(
        fields.map((name) => emptyParameter(target.columns.find((column) => column.name === name)!.type)),
        null,
        2,
      ),
    )
    setMode(kind === 'read' ? 'read' : 'mutation')
    setConfirm('')
    setScan(false)
    setFiltering(false)
    setNotice(
      'Prepared a CQL draft only. Review and enter every typed value before explicit execution. No query has run.',
    )
  }
  return (
    <div
      className="space-y-3 [&_label]:block [&_label]:my-3 [&_select]:ml-2"
      style={{ padding: 16, height: '100%', width: '100%', overflow: 'auto' }}
    >
      <h2>Cassandra CQL workspace</h2>
      <p>
        {profile.name} · {profile.host}:{profile.port} · data center {profile.cql.dataCenter} ·{' '}
        {profile.readOnly ? 'Read-only safeguard' : 'Writes enabled'}
      </p>
      <p>
        Explicit single-endpoint prepared CQL. Partition restrictions and consistency matter; LIMIT does not
        make filtering cheap. No relational transaction, commit/rollback workflow or server-side cancellation
        is provided.
      </p>
      <label>
        Keyspace
        <Input
          aria-label="CQL keyspace"
          list={'cql-keyspaces-' + tab.id}
          value={keyspace}
          disabled={locked}
          onChange={(event) => {
            setKeyspace(event.target.value)
            setTable(undefined)
            setTables([])
            setPage(undefined)
            setConfirm('')
          }}
        />
      </label>
      <datalist id={'cql-keyspaces-' + tab.id}>
        {keyspaces.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button
        variant="outline"
        disabled={locked || !keyspace}
        onClick={() =>
          void invoke(async () => setTables(await api.cqlTables({ connectionId: profile.id, keyspace })))
        }
      >
        List CQL tables
      </Button>
      <label>
        Table
        <Input
          aria-label="CQL table"
          list={'cql-tables-' + tab.id}
          value={tableName}
          disabled={locked}
          onChange={(event) => {
            setTableName(event.target.value)
            setTable(undefined)
            setPage(undefined)
            setConfirm('')
          }}
        />
      </label>
      <datalist id={'cql-tables-' + tab.id}>
        {tables.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button
        disabled={locked || !keyspace || !tableName}
        onClick={() =>
          void invoke(async () => {
            await close()
            setPage(undefined)
            const result = await api.cqlStructure({ connectionId: profile.id, keyspace, table: tableName })
            setTable(result)
            prepare(result, 'read')
          })
        }
      >
        Inspect CQL table
      </Button>
      {table && (
        <>
          <p>
            Partition key: {table.partition.join(', ')} · Clustering: {table.clustering.join(', ') || 'none'}
          </p>
          <details>
            <summary>CQL column types and key positions</summary>
            <table aria-label="CQL table structure">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Type</th>
                  <th>Key role</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr key={column.name}>
                    <td>{column.name}</td>
                    <td>{column.type}</td>
                    <td>
                      {column.kind} {column.position >= 0 ? column.position : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={locked} onClick={() => prepare(table, 'read')}>
              Prepare partition SELECT
            </Button>
            {(['insert', 'update', 'delete'] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                disabled={locked || profile.readOnly}
                onClick={() => prepare(table, kind)}
              >
                Prepare conditional {kind.toUpperCase()}
              </Button>
            ))}
          </div>
          <label>
            CQL statement
            <textarea
              aria-label="CQL statement"
              className="w-full font-mono"
              rows={6}
              disabled={locked}
              value={cql}
              onChange={(event) => {
                setCql(event.target.value)
                setConfirm('')
              }}
            />
          </label>
          <label>
            Typed positional parameters
            <textarea
              aria-label="CQL typed parameters"
              className="w-full font-mono"
              rows={6}
              disabled={locked}
              value={parameters}
              onChange={(event) => {
                setParameters(event.target.value)
                setConfirm('')
              }}
            />
          </label>
          <p>
            Each ? uses a JSON entry with type and string value. Supported exact native types include bigint,
            varint, decimal, date/time, UUID, blob and typed list/set/map/tuple/UDT. Nested collections
            contain typed entries; blob uses base64. Timestamp requires timezone and at most millisecond
            precision.
          </p>
          <label>
            Consistency
            <select
              aria-label="CQL consistency"
              value={consistency}
              disabled={locked}
              onChange={(event) => {
                setConsistency(event.target.value as typeof consistency)
                setConfirm('')
              }}
            >
              {['one', 'localOne', 'localQuorum', 'quorum', 'all'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <p>
            Conditional mutations use LOCAL_SERIAL for the condition phase and the selected normal
            consistency. Availability depends on replication and reachable nodes; no automatic downgrade.
          </p>
          <label>
            Execution mode
            <select
              aria-label="CQL execution mode"
              value={mode}
              disabled={locked}
              onChange={(event) => {
                setMode(event.target.value as typeof mode)
                setConfirm('')
              }}
            >
              <option value="read">Read SELECT</option>
              <option value="mutation" disabled={profile.readOnly}>
                Reviewed native conditional mutation
              </option>
            </select>
          </label>
          {mode === 'read' ? (
            <>
              <label>
                <input
                  type="checkbox"
                  aria-label="Allow CQL partition scan"
                  checked={scan}
                  disabled={locked}
                  onChange={(event) => {
                    setScan(event.target.checked)
                    if (!event.target.checked) setFiltering(false)
                  }}
                />
                Allow a read without complete partition-key equality; this may scan many partitions.
              </label>
              <label>
                <input
                  type="checkbox"
                  aria-label="Allow CQL filtering"
                  checked={filtering}
                  disabled={locked || !scan}
                  onChange={(event) => setFiltering(event.target.checked)}
                />
                Permit explicit ALLOW FILTERING in reviewed CQL; the cost can be high even with LIMIT.
              </label>
            </>
          ) : (
            <>
              <p>
                Review full primary key, CQL and every parameter. INSERT requires IF NOT EXISTS; UPDATE/DELETE
                require complete primary-key equality and native IF conditions. No batches, TTL, custom
                timestamps, counters or unconditional writes.
              </p>
              <p>
                Type: <code>{cqlConfirmation(profile.id, table.keyspace, table.name)}</code>
              </p>
              <Input
                aria-label="Confirm CQL mutation"
                disabled={locked}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                !cql ||
                (mode === 'mutation' &&
                  (profile.readOnly || confirm !== cqlConfirmation(profile.id, table.keyspace, table.name)))
              }
              onClick={() =>
                void invoke(async (requestId) => {
                  await close()
                  setPage(undefined)
                  const result = await api.cqlExecute({
                    connectionId: profile.id,
                    sessionId: tab.id,
                    requestId,
                    keyspace: table.keyspace,
                    table: table.name,
                    cql,
                    parameters: cqlParameterSchema.array().max(100).parse(JSON.parse(parameters)),
                    mode,
                    consistency,
                    allowScan: scan,
                    allowFiltering: filtering,
                    pageSize: 25,
                    confirm: mode === 'mutation' ? confirm : undefined,
                  })
                  setPage(result)
                  setConfirm('')
                })
              }
            >
              Run prepared CQL
            </Button>
            <Button
              variant="outline"
              disabled={busy || !page?.cursor}
              onClick={() =>
                void invoke(async (requestId) =>
                  setPage(
                    await api.cqlNext({
                      connectionId: profile.id,
                      sessionId: tab.id,
                      requestId,
                      cursor: page!.cursor!,
                    }),
                  ),
                )
              }
            >
              Next CQL page
            </Button>
            <Button
              variant="outline"
              disabled={busy || !page?.cursor}
              onClick={() =>
                void invoke(async () => {
                  await close()
                  setPage((value) => (value ? { ...value, cursor: undefined } : value))
                  setNotice('Cursor closed. Run a fresh statement explicitly.')
                })
              }
            >
              Close CQL cursor
            </Button>
          </div>
          {page && (
            <>
              <p role="status">
                {page.keyspace}.{page.table} · {page.rows.length} rows on page · {page.rowsRead} rows read ·
                consistency {page.consistency} ·{' '}
                {page.acknowledged
                  ? page.applied
                    ? 'Mutation applied and acknowledged'
                    : 'Condition not met; no mutation applied'
                  : page.cursor
                    ? 'Cursor open'
                    : 'Read complete'}
              </p>
              <p>{page.warning}</p>
              <div style={{ overflow: 'auto' }}>
                <table aria-label="CQL result table">
                  <thead>
                    <tr>
                      {page.columns.map((column, index) => (
                        <th key={index}>
                          {column.name}
                          <small> {column.type}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((value, column) => (
                          <td key={column}>
                            <pre
                              style={{
                                whiteSpace: 'pre-wrap',
                                maxWidth: 400,
                                maxHeight: 180,
                                overflow: 'auto',
                              }}
                            >
                              {value}
                            </pre>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      {busy && request && (
        <Button
          onClick={() =>
            void api
              .cqlCancel({ connectionId: profile.id, sessionId: tab.id, requestId: request })
              .then((result) => setNotice(result.message))
              .catch((error) => setError(errorText(error)))
          }
        >
          Stop CQL locally
        </Button>
      )}
      {error && <ErrorPanel message={error} />} {notice && <p role="status">{notice}</p>}
    </div>
  )
}
