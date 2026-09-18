import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import {
  seriesConfirmation,
  type SeriesInspection,
  type SeriesQuery,
  type SeriesResult,
  type SeriesSource,
} from '@shared/time-series'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ErrorPanel } from './common'
export function TimeSeriesBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const influx = profile.engine === 'influxdb',
    draft = tab.seriesDraft
  const [sources, setSources] = useState<SeriesSource[]>([]),
    [source, setSource] = useState(draft?.source ?? ''),
    [measurement, setMeasurement] = useState(draft?.measurement ?? ''),
    [field, setField] = useState(draft?.field ?? ''),
    [start, setStart] = useState(draft?.start ?? new Date(Date.now() - 3600000).toISOString()),
    [stop, setStop] = useState(draft?.stop ?? new Date().toISOString()),
    [tags, setTags] = useState(draft?.tags ?? '[]'),
    [aggregate, setAggregate] = useState<SeriesQuery['aggregate']>(draft?.aggregate ?? 'none'),
    [interval, setInterval] = useState(draft?.interval ?? '1m'),
    [limit, setLimit] = useState(draft?.limit ?? 200),
    [inspection, setInspection] = useState<SeriesInspection>(),
    [result, setResult] = useState<SeriesResult>(),
    [mode, setMode] = useState<'browse' | 'sql'>(draft?.mode ?? 'browse'),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [request, setRequest] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [tableIndex, setTableIndex] = useState(0),
    [page, setPage] = useState(0),
    [columnPage, setColumnPage] = useState(0),
    [cell, setCell] = useState<string>()
  useEffect(() => {
    const value = { source, measurement, field, start, stop, tags, aggregate, interval, limit, mode }
    if (JSON.stringify(tab.seriesDraft) !== JSON.stringify(value))
      useApp.getState().updateTab(tab.id, { seriesDraft: value })
  }, [
    source,
    measurement,
    field,
    start,
    stop,
    tags,
    aggregate,
    interval,
    limit,
    mode,
    tab.id,
    tab.seriesDraft,
  ])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void api
      .seriesCatalog({ connectionId: profile.id })
      .then((v) => {
        if (mounted.current) setSources(v)
      })
      .catch((e) => {
        if (mounted.current) setError(errorText(e))
      })
    return () => {
      mounted.current = false
      void api.closeSession({ connectionId: profile.id, sessionId: tab.id }).catch(() => {})
    }
  }, [profile.id, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy })
    return () => useApp.getState().setRuntime(tab.id, { running: false })
  }, [busy, tab.id])
  const run = async (work: (requestId: string) => Promise<void>) => {
    const id = crypto.randomUUID()
    setRequest(id)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work(id)
    } catch (e) {
      if (mounted.current) setError(errorText(e))
    } finally {
      if (mounted.current) {
        setBusy(false)
        setRequest('')
        setConfirm('')
      }
    }
  }
  const table = result?.sets[tableIndex]
  return (
    <div
      className="space-y-3 [&_label]:block [&_label]:my-2"
      style={{ padding: 16, overflow: 'auto', height: '100%', width: '100%' }}
    >
      <h2>{influx ? 'InfluxDB 2 · Flux' : 'QuestDB 10.0 · HTTP SQL'} time-series workspace</h2>
      <p>
        {profile.name} · {profile.readOnly ? 'Read-only safeguard' : 'Writes enabled'} · explicit UTC ranges ·
        queries run only on request
      </p>
      <p>
        {influx
          ? 'This workspace generates Flux reads. InfluxDB 1/3, InfluxQL, arbitrary Flux scripts and writes are not enabled. Use a least-privilege bucket read token.'
          : 'Browse applies your range to the designated timestamp. Raw SQL requires a write-enabled profile and explicit confirmation because this HTTP interface has no per-request read-only transaction.'}
      </p>
      <label>
        {influx ? 'Bucket' : 'Table'}
        <Input
          maxLength={255}
          aria-label="Time-series source"
          list={'series-sources-' + tab.id}
          value={source}
          disabled={busy}
          onChange={(e) => {
            setSource(e.target.value)
            setInspection(undefined)
            setResult(undefined)
            setConfirm('')
          }}
        />
      </label>
      <datalist id={'series-sources-' + tab.id}>
        {sources.map((s) => (
          <option key={s.name} value={s.name}>
            {s.timestamp ? `timestamp: ${s.timestamp} · ${s.partition}` : s.id}
          </option>
        ))}
      </datalist>
      <div className="grid grid-cols-2 gap-3">
        <label>
          Start UTC (inclusive)
          <Input
            maxLength={64}
            aria-label="Time-series start"
            value={start}
            disabled={busy}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Stop UTC (exclusive)
          <Input
            maxLength={64}
            aria-label="Time-series stop"
            value={stop}
            disabled={busy}
            onChange={(e) => setStop(e.target.value)}
          />
        </label>
      </div>
      {influx && (
        <label>
          Measurement
          <Input
            maxLength={255}
            aria-label="InfluxDB measurement"
            list={'series-measurements-' + tab.id}
            value={measurement}
            disabled={busy}
            onChange={(e) => {
              setMeasurement(e.target.value)
              setInspection(undefined)
            }}
          />
        </label>
      )}
      <datalist id={'series-measurements-' + tab.id}>
        {inspection?.measurements.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button
        variant="outline"
        disabled={busy || !source}
        onClick={() =>
          void run(async (requestId) => {
            const value = await api.seriesInspect({
              connectionId: profile.id,
              sessionId: tab.id,
              requestId,
              source,
              measurement,
              start,
              stop,
            })
            if (mounted.current) setInspection(value)
          })
        }
      >
        {influx ? 'Inspect measurements / fields in range' : 'Inspect timestamp and column types'}
      </Button>
      {inspection && (
        <section aria-label="Time-series metadata">
          <p>
            {Object.entries(inspection.details)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')}
          </p>
          {inspection.limited && <p>Metadata preview reached its bound; enter an exact name to narrow it.</p>}
          <p>{inspection.measurements.join(' · ')}</p>
          <ul>
            {inspection.fields.map((f) => (
              <li key={f.name}>
                {f.name} — {f.type}
                {f.designated ? ' · designated timestamp' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!influx && (
        <label>
          Operation
          <select
            aria-label="QuestDB operation"
            value={mode}
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as typeof mode)
              setConfirm('')
            }}
          >
            <option value="browse">Browse time range</option>
            <option value="sql">Reviewed SQL (may write)</option>
          </select>
        </label>
      )}
      {mode === 'browse' ? (
        <>
          <label>
            Field (empty selects all)
            <Input
              maxLength={255}
              aria-label="Time-series field"
              list={'series-fields-' + tab.id}
              value={field}
              disabled={busy}
              onChange={(e) => setField(e.target.value)}
            />
          </label>
          <datalist id={'series-fields-' + tab.id}>
            {inspection?.fields.map((f) => (
              <option key={f.name} value={f.name} />
            ))}
          </datalist>
          <label>
            Tag equality filters — JSON array of key/value pairs
            <textarea
              maxLength={65536}
              aria-label="Time-series tag filters"
              className="w-full font-mono"
              rows={2}
              value={tags}
              disabled={busy}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          {influx && (
            <div className="flex gap-3">
              <label>
                Window aggregate
                <select
                  aria-label="InfluxDB aggregate"
                  value={aggregate}
                  disabled={busy}
                  onChange={(e) => setAggregate(e.target.value as typeof aggregate)}
                >
                  {['none', 'mean', 'sum', 'min', 'max', 'count', 'first', 'last'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label>
                Window size
                <Input
                  maxLength={32}
                  aria-label="InfluxDB interval"
                  value={interval}
                  disabled={busy || aggregate === 'none'}
                  onChange={(e) => setInterval(e.target.value)}
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <>
          <p>
            Review the full SQL and target. SQL may auto-commit; no rollback, automatic retry or row-edit
            conflict protection is provided here. SAMPLE BY and engine-specific statements are supported by
            the server. HTTP query text can appear in your server/proxy logs.
          </p>
          <textarea
            maxLength={12000}
            aria-label="QuestDB SQL"
            className="w-full font-mono"
            rows={7}
            value={tab.sql}
            disabled={busy || profile.readOnly}
            onChange={(e) => {
              useApp.getState().updateTab(tab.id, { sql: e.target.value })
              setConfirm('')
            }}
          />
          <label>
            Type {seriesConfirmation(profile.id)}
            <Input
              aria-label="Confirm QuestDB SQL"
              value={confirm}
              disabled={busy || profile.readOnly}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        </>
      )}
      <label>
        Maximum preview rows (1–1000)
        <Input
          aria-label="Time-series row limit"
          type="number"
          min={1}
          max={1000}
          value={limit}
          disabled={busy}
          onChange={(e) => setLimit(Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value) || 0))))}
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={
            busy ||
            !source ||
            (mode === 'sql' && (profile.readOnly || confirm !== seriesConfirmation(profile.id)))
          }
          onClick={() =>
            void run(async (requestId) => {
              setResult(undefined)
              const value = await api.seriesQuery({
                connectionId: profile.id,
                sessionId: tab.id,
                requestId,
                source,
                measurement,
                field,
                start,
                stop,
                tags: JSON.parse(tags),
                aggregate,
                interval,
                limit,
                mode,
                sql: tab.sql,
                confirm,
              })
              if (mounted.current) {
                setResult(value)
                setTableIndex(0)
                setPage(0); setColumnPage(0)
              }
            })
          }
        >
          Run time-series query
        </Button>
        <Button
          variant="outline"
          disabled={!busy || !request}
          onClick={() =>
            void api
              .seriesCancel({ connectionId: profile.id, sessionId: tab.id, requestId: request })
              .then((v) => setNotice(v.message))
              .catch((e) => setError(errorText(e)))
          }
        >
          Cancel time-series request
        </Button>
      </div>
      {result && (
        <section aria-label="Time-series results">
          <p role="status">
            {result.rows} rows · {result.durationMs} ms ·{' '}
            {result.truncated ? 'Preview limit reached; narrow the range' : 'Complete response'}
          </p>
          <p>{result.message}</p>
          <details>
            <summary>Executed query</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{result.query}</pre>
          </details>
          {result.sets.length > 1 && (
            <label>
              Series table
              <select
                aria-label="Time-series result table"
                value={tableIndex}
                onChange={(e) => {
                  setTableIndex(Number(e.target.value))
                  setPage(0); setColumnPage(0)
                }}
              >
                {result.sets.map((s, i) => (
                  <option key={i} value={i}>
                    {i + 1}: {JSON.stringify(s.group)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {table && (
            <>
              <p>{JSON.stringify(table.group)}</p>
              {table.columns.length > 32 && <div><p>Columns {columnPage * 32 + 1}–{Math.min((columnPage + 1) * 32,table.columns.length)} of {table.columns.length}. The view renders at most 100 rows × 32 columns; all preview values remain available.</p><Button variant="outline" disabled={columnPage===0} onClick={()=>setColumnPage(p=>p-1)}>Previous columns</Button><Button variant="outline" disabled={(columnPage+1)*32>=table.columns.length} onClick={()=>setColumnPage(p=>p+1)}>Next columns</Button></div>}
              <div style={{ overflow: 'auto', maxHeight: 420 }}>
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      {table.columns.slice(columnPage * 32, (columnPage + 1) * 32).map((c, i) => (
                        <th key={i} className="px-2">
                          {c.name}
                          <small className="block">{c.type}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(page * 100, (page + 1) * 100).map((row, i) => (
                      <tr key={i}>
                        {row.slice(columnPage * 32, (columnPage + 1) * 32).map((v, j) => (
                          <td key={j} className="px-2">
                            <button
                              title="Inspect exact value"
                              onClick={() => setCell(v === null ? 'NULL' : String(v))}
                              style={{
                                maxWidth: 280,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {v === null ? 'NULL' : String(v).slice(0, 256) || '〈empty text〉'}
                            </button>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous rows
              </Button>
              <Button
                variant="outline"
                disabled={(page + 1) * 100 >= table.rows.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next rows
              </Button>
            </>
          )}
        </section>
      )}
      {cell !== undefined && (
        <section>
          <Button variant="outline" onClick={() => setCell(undefined)}>
            Close exact value
          </Button>
          <pre
            aria-label="Exact time-series value"
            style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}
          >
            {cell}
          </pre>
        </section>
      )}
      {error && <ErrorPanel message={error} />} {notice && <p role="status">{notice}</p>}
    </div>
  )
}
