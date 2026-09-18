import http from 'node:http'
import https from 'node:https'
import { parse, stringify, isLosslessNumber } from 'lossless-json'
import type { Cell, ConnectionProfile, Secrets } from '../../shared/contracts'
import type { TrinoPage } from '../../shared/trino'
import type { Transport } from './transport'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value))
    throw new Error('Trino returned an invalid protocol object.')
  return value as Record<string, unknown>
}
const count = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const text = String(value)
  if (!/^\d+$/.test(text)) throw new Error('Trino returned an invalid exact count.')
  return text
}
export function trinoCell(value: unknown, type: string): Cell {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (type.toLowerCase() === 'varbinary' && typeof value === 'string') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        throw new Error('Trino returned invalid binary encoding.')
      return { type: 'binary', base64: value }
    }
    return value
  }
  if (isLosslessNumber(value)) return value.value
  if (Array.isArray(value) || (value && typeof value === 'object')) return stringify(value)!
  throw new Error('Trino returned an unsupported value representation.')
}
export class TrinoHttpError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** Direct v1 protocol only: bounded exact JSON, fixed coordinator, no redirect or replay. */
export class TrinoHttp {
  private agent: http.Agent | https.Agent
  private requests = new Set<http.ClientRequest>()
  private closed = false
  private authorization?: string
  private origin: string
  constructor(private profile: ConnectionProfile, private transport: Transport, secrets: Secrets) {
    const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host
    this.origin = new URL(`${profile.tls.enabled ? 'https' : 'http'}://${host}:${profile.port}`).origin
    if (!profile.username || /[\r\n\0]/.test(profile.username)) throw new Error('Trino requires an explicit valid session user.')
    if (profile.trino.auth !== 'none') {
      if (!profile.tls.enabled || !profile.tls.rejectUnauthorized) throw new Error('Trino password and bearer authentication require verified TLS.')
      if (!secrets.password || /[\r\n]/.test(secrets.password)) throw new Error('Enter the selected Trino authentication credential.')
      if (profile.trino.auth === 'basic' && profile.username.includes(':')) throw new Error('Basic authentication usernames cannot contain a colon.')
      this.authorization = profile.trino.auth === 'basic'
        ? 'Basic ' + Buffer.from(profile.username + ':' + secrets.password).toString('base64')
        : 'Bearer ' + secrets.password
    }
    this.agent = profile.tls.enabled ? new https.Agent({ keepAlive: true, maxSockets: 8, ...transport.tls }) : new http.Agent({ keepAlive: true, maxSockets: 8 })
  }
  continuation(uri: string): string {
    let url: URL
    try { url = new URL(uri) } catch { throw new Error('Trino returned an invalid continuation URL.') }
    if (url.origin !== this.origin || url.username || url.password || url.hash || url.search || !/^\/v1\/statement\/[A-Za-z0-9_./-]+$/.test(url.pathname) || url.pathname.includes('..'))
      throw new Error('Trino continuation left the selected coordinator. Proxy forwarding must preserve the configured endpoint; no credentials were forwarded.')
    return url.pathname
  }
  async request(method: 'POST' | 'GET' | 'DELETE', path: string, options: { sql?: string; catalog?: string; schema?: string; transaction?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<TrinoPage | undefined> {
    if (this.closed || options.signal?.aborted) throw new Error('Trino request cancelled before dispatch.')
    if (this.requests.size >= 16) throw new Error('Too many concurrent Trino requests.')
    if (path !== '/v1/statement') path = this.continuation(path)
    const headers: Record<string, string | number> = {
      'Content-Type': 'text/plain; charset=utf-8', Accept: 'application/json', 'Accept-Encoding': 'identity',
      Host: new URL(this.origin).host, 'X-Trino-User': this.profile.username, 'X-Trino-Source': 'Harbor-DB',
      'X-Trino-Time-Zone': this.profile.trino.timeZone, 'X-Trino-Client-Capabilities': 'PARAMETRIC_DATETIME',
      'X-Trino-Transaction-Id': options.transaction || 'NONE',
      'X-Trino-Session': `query_max_run_time=${Math.max(1, Math.ceil(this.profile.queryTimeout / 1000))}s`,
      ...(this.authorization ? { Authorization: this.authorization } : {}),
    }
    for (const [header, value] of [['X-Trino-Catalog', options.catalog], ['X-Trino-Schema', options.schema]] as const) {
      if (value) { if (/[\r\n\0]/.test(value)) throw new Error('Invalid Trino catalog or schema header.'); headers[header] = encodeURIComponent(value) }
    }
    if (options.sql !== undefined) {
      const bytes = Buffer.byteLength(options.sql)
      if (bytes > 1024 * 1024) throw new Error('Trino statement exceeds 1 MiB.')
      headers['Content-Length'] = bytes
    }
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error?: Error, result?: TrinoPage) => {
        if (done) return
        done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.requests.delete(request)
        if (error) reject(error); else resolve(result)
      }
      const abort = () => request.destroy(new TrinoHttpError('Trino request interrupted. A submitted write may have completed; no replay was attempted.'))
      const request = (this.profile.tls.enabled ? https : http).request({
        hostname: this.transport.host, port: this.transport.port, path, method, headers, agent: this.agent,
        ...(this.profile.tls.enabled ? this.transport.tls : {}),
      }, (response) => {
        const chunks: Buffer[] = []; let bytes = 0
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          finish(new Error('Trino must return uncompressed bounded direct-protocol pages.')); response.destroy(); request.destroy(); return
        }
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) { finish(new Error('Trino page exceeded 8 MiB. Select fewer or smaller fields.')); response.destroy(); request.destroy() }
          else chunks.push(chunk)
        })
        response.once('error', () => finish(new TrinoHttpError('Trino response was interrupted; operation outcome may be uncertain.')))
        response.once('end', () => {
          if (done) return
          try {
            const status = response.statusCode || 0
            if (status < 200 || status >= 300) throw new TrinoHttpError(status === 401 ? 'Trino authentication failed. Re-enter credentials and reconnect.' : status === 403 ? 'Trino permission denied. Use an account with the required connector permissions.' : `Trino returned HTTP ${status}; redirects and automatic retries are disabled. A submitted write may have completed.`, status)
            if (method === 'DELETE') { finish(); return }
            let decoded: unknown
            try { decoded = parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new Error('Trino returned invalid bounded JSON; response contents are omitted.') }
            const body = object(decoded)
            if (body.error) {
              const error = object(body.error), code = typeof error.errorName === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.errorName) ? error.errorName : 'QUERY_FAILED'
              const location = error.errorLocation ? object(error.errorLocation) : undefined
              const where = location ? ` at line ${count(location.lineNumber)}, column ${count(location.columnNumber)}` : ''
              throw new TrinoHttpError(`Trino ${code}${where}. Inspect SQL, connector permissions and types. Driver messages and data are omitted; no retry occurred.`)
            }
            if (typeof body.id !== 'string' || body.id.length > 200) throw new Error('Trino response lacks a valid query identifier.')
            if (body.nextUri !== undefined) { if (typeof body.nextUri !== 'string') throw new Error('Invalid Trino cursor.'); this.continuation(body.nextUri) }
            const columns = body.columns === undefined ? undefined : (() => {
              if (!Array.isArray(body.columns) || body.columns.length > 2000) throw new Error('Trino columns exceed the supported bound.')
              return body.columns.map((raw) => { const value = object(raw); if (typeof value.name !== 'string' || typeof value.type !== 'string' || value.name.length > 10000 || value.type.length > 10000) throw new Error('Invalid Trino column metadata.'); return { name: value.name, type: value.type } })
            })()
            if (body.data !== undefined && !Array.isArray(body.data)) throw new Error('Trino spooled results are not enabled. Direct pages are required.')
            const rows = (body.data as unknown[][] | undefined || []).map((row) => {
              if (!Array.isArray(row) || !columns || row.length !== columns.length) throw new Error('Trino row shape differs from its metadata.')
              return row.map((value, index) => trinoCell(value, columns[index].type))
            })
            const stats = body.stats ? object(body.stats) : {}, transaction = response.headers['x-trino-started-transaction-id']
            if (transaction && (typeof transaction !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(transaction))) throw new Error('Invalid Trino transaction identity.')
            finish(undefined, { id: body.id, nextUri: body.nextUri as string | undefined, columns, rows,
              phase: typeof stats.state === 'string' ? stats.state.slice(0, 100) : 'RUNNING',
              processedRows: count(stats.processedRows), processedBytes: count(stats.processedBytes),
              updateType: typeof body.updateType === 'string' ? body.updateType.slice(0, 100) : undefined,
              updateCount: count(body.updateCount), transaction, clearTransaction: response.headers['x-trino-clear-transaction-id'] !== undefined,
            })
          } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Trino response.')) }
        })
      })
      const timer = setTimeout(() => request.destroy(new TrinoHttpError('Trino HTTP deadline exceeded; no automatic replay occurred.')), options.timeout ?? this.profile.queryTimeout)
      this.requests.add(request); request.once('error', () => finish(new TrinoHttpError('Trino transport failed or timed out. A submitted write may have completed; reconnect explicitly.')))
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort(); else request.end(options.sql)
    })
  }
  close(): void { this.closed = true; for (const request of this.requests) request.destroy(); this.agent.destroy() }
}
