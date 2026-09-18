import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  fluxBrowse,
  fluxString,
  questIdentifier,
  questLiteral,
  seriesQuerySchema,
  seriesInspectSchema,
  seriesConfirmation,
  type SeriesQuery,
  type SeriesInspect,
  type SeriesSource,
  type SeriesInspection,
  type SeriesResult,
  type SeriesSet,
} from '../../shared/time-series'
import { openTransport, type Transport } from './transport'
import { SeriesHttp, SeriesHttpError } from './series-http'
import { influxSets, questSet, seriesJson } from './series-values'
interface Operation {
  requestId: string
  controller: AbortController
  done: Promise<void>
  release: () => void
}
interface Live {
  profile: ConnectionProfile
  transport: Transport
  http: SeriesHttp
  status: ConnectionStatus
  active: Map<string, Operation>
  closed: boolean
}
const records = (set: SeriesSet) =>
  set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]])))
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid time-series catalog.')
  return value as Record<string, unknown>
}
const str = (value: unknown) => (typeof value === 'string' ? value : '')
export class TimeSeriesService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (!['influxdb', 'questdb'].includes(profile.engine))
      throw new Error('Use an InfluxDB 2 Flux or QuestDB connection.')
    await this.disconnect(profile.id)
    let transport: Transport | undefined, live: Live | undefined
    const started = performance.now()
    try {
      if (
        profile.engine === 'influxdb' &&
        (!/^[a-f0-9]{16}$/i.test(profile.timeSeries.orgId) || !secrets.password)
      )
        throw new Error('InfluxDB 2 requires an explicit 16-character organization ID and API token.')
      if (profile.autoReconnect)
        throw new Error('Automatic reconnect is unavailable for time-series HTTP sessions.')
      transport = await openTransport(profile, secrets)
      live = {
        profile: structuredClone(profile),
        transport,
        http: new SeriesHttp(profile, transport, secrets),
        active: new Map(),
        status: { state: 'connecting' },
        closed: false,
      }
      this.connections.set(profile.id, live)
      let version: string
      if (profile.engine === 'influxdb') {
        const health = seriesJson(
          await live.http.request('GET', '/health', undefined, undefined, profile.connectTimeout),
        )
        if (health.name !== 'influxdb' || !/^v?2\.\d+\.\d+/.test(str(health.version)))
          throw new Error(
            'This profile supports InfluxDB 2.x Flux only. InfluxDB 1.x/3.x and InfluxQL are not enabled.',
          )
        version = `InfluxDB ${health.version} · Flux`
      } else {
        const build = await this.quest(live, 'SELECT build()', 1)
        version = String(build.rows[0]?.[0] || '')
        if (!/QuestDB.*(?:10\.0\.)/i.test(version))
          throw new Error('Expected QuestDB 10.0.x HTTP SQL. Other releases/protocols are not enabled.')
      }
      const catalog = await this.catalog({ connectionId: profile.id })
      if (profile.engine === 'influxdb' && !catalog.length)
        throw new Error(
          'No accessible bucket confirms this InfluxDB organization. Check the explicit organization ID and bucket permissions.',
        )
      live.status = {
        state: 'connected',
        version,
        durationMs: Math.round(performance.now() - started),
        transport: `${profile.ssh.enabled ? 'Pinned SSH · ' : ''}${profile.tls.enabled ? 'Verified TLS' : 'Loopback HTTP'} · direct ${profile.engine === 'influxdb' ? 'Flux v2' : 'QuestDB HTTP SQL'}`,
        checkedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, live.status)
      return structuredClone(live.status)
    } catch (error) {
      live?.http.close()
      await transport?.close()
      this.connections.delete(profile.id)
      const status: ConnectionStatus = {
        state: error instanceof SeriesHttpError && error.status === 401 ? 'authentication-failed' : 'failed',
        error: error instanceof Error ? error.message : 'Time-series connection failed.',
        checkedAt: new Date().toISOString(),
      }
      this.states.set(profile.id, status)
      return status
    }
  }
  status(id: string): ConnectionStatus {
    return structuredClone(
      this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' },
    )
  }
  private live(id: string) {
    const live = this.connections.get(id)
    if (!live || live.closed) throw new Error('Connect explicitly to the time-series server.')
    return live
  }
  private async operation<T>(
    live: Live,
    sessionId: string,
    requestId: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (live.active.has(sessionId)) throw new Error('This time-series tab is already running.')
    if (live.active.size >= 4) throw new Error('Four time-series operations are already active.')
    let release!: () => void
    const done = new Promise<void>((resolve) => {
        release = resolve
      }),
      operation: Operation = { requestId, controller: new AbortController(), done, release }
    live.active.set(sessionId, operation)
    const timer = setTimeout(() => operation.controller.abort(), live.profile.queryTimeout)
    try {
      const result = await run(operation.controller.signal)
      if (operation.controller.signal.aborted || live.closed)
        throw new Error('Time-series request cancelled. Server outcome is unconfirmed.')
      return result
    } finally {
      clearTimeout(timer)
      live.active.delete(sessionId)
      release()
    }
  }
  private async quest(live: Live, sql: string, limit: number, signal?: AbortSignal): Promise<SeriesSet> {
    const query = new URLSearchParams({
      query: sql,
      limit: `0,${limit}`,
      count: 'false',
      quoteLargeNum: 'true',
    })
    return questSet(seriesJson(await live.http.request('GET', `/exec?${query}`, undefined, signal)))
  }
  private async flux(live: Live, query: string, limit: number, signal?: AbortSignal) {
    const body = JSON.stringify({
      query,
      type: 'flux',
      dialect: {
        header: true,
        delimiter: ',',
        annotations: ['datatype', 'group', 'default'],
        dateTimeFormat: 'RFC3339Nano',
      },
    })
    return influxSets(
      await live.http.request('POST', `/api/v2/query?orgID=${live.profile.timeSeries.orgId}`, body, signal),
      limit,
    )
  }
  async catalog(input: { connectionId: string }): Promise<SeriesSource[]> {
    const live = this.live(input.connectionId)
    return this.operation(live, 'catalog', randomUUID(), async (signal) => {
      if (live.profile.engine === 'influxdb') {
        const body = seriesJson(
          await live.http.request(
            'GET',
            `/api/v2/buckets?orgID=${live.profile.timeSeries.orgId}&limit=100&offset=0`,
            undefined,
            signal,
          ),
        )
        if (!Array.isArray(body.buckets)) throw new Error('InfluxDB returned no bucket catalog.')
        // Names can also be entered explicitly when the organization contains more than this bounded page.
        return body.buckets.slice(0, 100).map((raw) => {
          const bucket = object(raw)
          if (bucket.orgID !== live.profile.timeSeries.orgId)
            throw new Error('Bucket belongs to a different organization.')
          if (typeof bucket.name !== 'string' || typeof bucket.id !== 'string')
            throw new Error('Invalid InfluxDB bucket identity.')
          return {
            name: bucket.name,
            id: bucket.id,
            details: {
              retention: JSON.stringify(bucket.retentionRules ?? []),
              catalog: 'First 100 accessible buckets; enter another exact name if omitted.',
            },
          }
        })
      }
      const set = await this.quest(
        live,
        'SELECT table_name, designatedTimestamp, partitionBy, walEnabled FROM tables() ORDER BY table_name LIMIT 5001',
        5001,
        signal,
      )
      if (set.rows.length > 5000)
        throw new Error('More than 5000 QuestDB objects are visible. Use a narrower database principal.')
      return records(set).map((row) => ({
        name: String(row.table_name),
        timestamp: row.designatedTimestamp ? String(row.designatedTimestamp) : undefined,
        partition: String(row.partitionBy),
        details: { wal: String(row.walEnabled) },
      }))
    })
  }
  private async inspectLive(
    live: Live,
    input: SeriesInspect,
    signal: AbortSignal,
  ): Promise<SeriesInspection> {
    if (live.profile.engine === 'questdb') {
      const set = await this.quest(
        live,
        `SELECT * FROM table_columns(${questLiteral(input.source)})`,
        512,
        signal,
      )
      if (set.rows.length >= 512) throw new Error('QuestDB column metadata reached the 512-column bound.')
      const rows = records(set)
      return {
        measurements: [],
        fields: rows.map((row) => ({
          name: String(row.column),
          type: String(row.type),
          designated: row.designated === true,
        })),
        details: {
          protocol:
            'QuestDB 10.0.x HTTP JSON; timestamp values remain native UTC text; HTTP BINARY results are refused.',
        },
        limited: false,
      }
    }
    const args = `bucket: ${fluxString(input.source)}, start: time(v: ${fluxString(input.start)}), stop: time(v: ${fluxString(input.stop)})`
    const query = `import "influxdata/influxdb/schema"\nschema.${input.measurement ? 'measurementFieldKeys' : 'measurements'}(${args}${input.measurement ? `, measurement: ${fluxString(input.measurement)}` : ''}) |> limit(n: 201)`
    const result = await this.flux(live, query, 201, signal),
      values = result.sets.flatMap((set) =>
        set.rows.map((row) => String(row[set.columns.findIndex((c) => c.name === '_value')])),
      ),
      limited = result.truncated || values.length > 200
    return {
      measurements: input.measurement ? [] : values.slice(0, 200),
      fields: input.measurement
        ? values.slice(0, 200).map((name) => ({ name, type: 'Flux field; type provided in query results' }))
        : [],
      details: { language: 'InfluxDB 2.x Flux only', range: `${input.start} — ${input.stop}` },
      limited,
    }
  }
  async inspect(raw: SeriesInspect): Promise<SeriesInspection> {
    const input = seriesInspectSchema.parse(raw),
      live = this.live(input.connectionId)
    return this.operation(live, input.sessionId, input.requestId, (signal) =>
      this.inspectLive(live, input, signal),
    )
  }
  async query(raw: SeriesQuery): Promise<SeriesResult> {
    const input = seriesQuerySchema.parse(raw),
      live = this.live(input.connectionId),
      started = performance.now()
    return this.operation(live, input.sessionId, input.requestId, async (signal) => {
      let query: string,
        sets: SeriesSet[],
        truncated = false,
        message: string
      if (live.profile.engine === 'influxdb') {
        if (input.mode !== 'browse')
          throw new Error(
            'InfluxDB accepts only generated Flux queries here; arbitrary scripts and network functions are not submitted.',
          )
        query = fluxBrowse(input)
        const result = await this.flux(live, query, input.limit, signal)
        sets = result.sets
        truncated = result.truncated
        message =
          'Flux series retain native numeric and nanosecond timestamp text. Group keys identify each table. Preview is bounded across all series.'
      } else {
        if (input.mode === 'sql') {
          if (live.profile.readOnly)
            throw new Error(
              'Read-only safeguard permits generated time-range browsing only. Raw QuestDB SQL requires explicit write-enabled profile and confirmation.',
            )
          if (input.confirm !== seriesConfirmation(input.connectionId))
            throw new Error('Review and confirm this exact QuestDB connection before SQL dispatch.')
          if (!input.sql.trim() || input.sql.includes('\0')) throw new Error('Enter a QuestDB SQL statement.')
          query = input.sql
        } else {
          const meta = await this.inspectLive(live, input, signal),
            timestamp = meta.fields.find((c) => c.designated)
          if (!timestamp)
            throw new Error(
              'This table has no designated timestamp. Use reviewed SQL on a write-enabled profile for arbitrary queries.',
            )
          const fields = input.field ? [input.field] : meta.fields.map((c) => c.name)
          if (fields.some((name) => !meta.fields.some((c) => c.name === name)))
            throw new Error('Choose a field present in the current table metadata.')
          if (input.aggregate !== 'none')
            throw new Error('Use reviewed SQL for QuestDB SAMPLE BY or aggregate queries.')
          for (const tag of input.tags)
            if (
              !meta.fields.some((c) => c.name === tag.key && ['STRING', 'SYMBOL', 'VARCHAR'].includes(c.type))
            )
              throw new Error('QuestDB tag filters require a current STRING, SYMBOL or VARCHAR column.')
          query = `SELECT ${fields.map(questIdentifier).join(', ')} FROM ${questIdentifier(input.source)} WHERE ${questIdentifier(timestamp.name)} >= ${questLiteral(input.start)} AND ${questIdentifier(timestamp.name)} < ${questLiteral(input.stop)}${input.tags.map((t) => ` AND ${questIdentifier(t.key)} = ${questLiteral(t.value)}`).join('')} ORDER BY ${questIdentifier(timestamp.name)} LIMIT ${input.limit + 1}`
        }
        let set: SeriesSet
        try {
          set = await this.quest(live, query, input.limit + 1, signal)
        } catch (error) {
          if (input.mode === 'sql')
            throw new Error(
              (error instanceof Error ? error.message : 'QuestDB request failed.') +
                ' A statement was submitted; any write outcome may be uncertain. Inspect before retrying.',
            )
          throw error
        }
        truncated = set.rows.length > input.limit
        set.rows = set.rows.slice(0, input.limit)
        sets = [set]
        message =
          input.mode === 'sql'
            ? 'QuestDB HTTP statement acknowledged. Writes auto-commit; HTTP provides no transaction or rollback guarantee. WAL ingestion may become visible later. No automatic retry.'
            : 'Time range is start-inclusive, stop-exclusive on the designated timestamp. Exact native text is retained.'
      }
      return {
        sets,
        query,
        rows: sets.reduce((n, s) => n + s.rows.length, 0),
        truncated,
        durationMs: Math.round(performance.now() - started),
        message,
      }
    })
  }
  cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const op = this.connections.get(input.connectionId)?.active.get(input.sessionId)
    const requested = !!op && op.requestId === input.requestId
    if (requested) op.controller.abort()
    return {
      requested,
      message: requested
        ? 'Local HTTP request stopped. Server completion or cancellation is unconfirmed; inspect any submitted write before retrying.'
        : 'No matching request is active.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }) {
    const op = this.connections.get(input.connectionId)?.active.get(input.sessionId)
    op?.controller.abort()
    await op?.done
    return { closed: true }
  }
  async disconnect(id: string) {
    const live = this.connections.get(id)
    if (live) {
      live.closed = true
      for (const op of live.active.values()) op.controller.abort()
      live.http.close()
      await Promise.all([...live.active.values()].map((op) => op.done))
      await live.transport.close()
      this.connections.delete(id)
    }
    this.states.set(id, { state: 'disconnected' })
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
