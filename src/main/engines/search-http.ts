import http from 'node:http'
import https from 'node:https'
import { parse, stringify, isLosslessNumber, type LosslessNumber } from 'lossless-json'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import { searchProfileSchema } from '../../shared/search'
import type { Transport } from './transport'

export type SearchJson =
  null | string | boolean | number | LosslessNumber | SearchJson[] | { [key: string]: SearchJson }
export type SearchObject = { [key: string]: SearchJson }
export function searchObject(value: SearchJson | undefined): SearchObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value))
    throw new Error('Expected a JSON object from the search service.')
  return value
}
export function searchJson(source: string): SearchJson {
  try {
    return parse(source) as SearchJson
  } catch {
    throw new Error('Enter valid JSON without duplicate object keys.')
  }
}
export function encodeSearchJson(value: SearchJson): string {
  return stringify(value)!
}
export function searchNumber(value: SearchJson | undefined, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  const result = Number(String(value))
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('The search service returned an invalid count.')
  return result
}
export function searchPrefix(value: string): string {
  if (!value) return ''
  if (
    !value.startsWith('/') ||
    value.includes('//') ||
    /[?#%\\\s]/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(
      'Proxy path must be a relative /path without a scheme, query, fragment, encoded separators or parent traversal.',
    )
  return value.replace(/\/$/, '')
}
export class SearchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
/** Fixed endpoint, no redirects, sniffing, retries or lossy numeric JSON decoding. */
export class SearchHttp {
  private agent: http.Agent | https.Agent
  private closed = false
  private active = new Set<http.ClientRequest>()
  private authorization?: string
  private prefix: string
  constructor(
    private profile: ConnectionProfile,
    private transport: Transport,
    secrets: Secrets,
  ) {
    const configuration = searchProfileSchema.parse(profile.search)
    this.prefix = searchPrefix(configuration.pathPrefix)
    if (configuration.auth === 'basic') {
      if (!profile.username || profile.username.includes(':'))
        throw new Error('Basic authentication requires a username without a colon.')
      if (secrets.password === undefined)
        throw new Error('Enter the basic-auth password in the credential field.')
      this.authorization =
        'Basic ' + Buffer.from(profile.username + ':' + secrets.password).toString('base64')
    } else if (configuration.auth === 'api-key') {
      if (String(profile.engine) !== 'elasticsearch')
        throw new Error(
          'API-key authentication is currently available only for Elasticsearch. OpenSearch managed identities require a separately supported workflow.',
        )
      if (!secrets.password)
        throw new Error('Enter the encoded Elasticsearch API key in the credential field.')
      if (/[\r\n]/.test(secrets.password)) throw new Error('Invalid API-key credential.')
      this.authorization = 'ApiKey ' + secrets.password
    }
    this.agent = profile.tls.enabled
      ? new https.Agent({ keepAlive: true, maxSockets: 6, ...transport.tls })
      : new http.Agent({ keepAlive: true, maxSockets: 6 })
  }
  async request(
    method: string,
    path: string,
    body?: SearchJson,
    signal?: AbortSignal,
    timeout = this.profile.queryTimeout,
  ): Promise<{ body: SearchJson; headers: http.IncomingHttpHeaders }> {
    if (this.closed) throw new Error('Search connection is closed. Reconnect explicitly.')
    if (signal?.aborted) throw new Error('Request stopped. Server cancellation is not confirmed.')
    if (this.active.size >= 32)
      throw new Error('Too many concurrent search requests; wait for an existing request to finish.')
    const payload = body === undefined ? undefined : encodeSearchJson(body)
    if (payload && Buffer.byteLength(payload) > 1024 * 1024)
      throw new Error('The request exceeds the 1 MiB JSON limit.')
    return new Promise((resolve, reject) => {
      let complete = false
      const finish = (error?: Error, value?: { body: SearchJson; headers: http.IncomingHttpHeaders }) => {
        if (complete) return
        complete = true
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        this.active.delete(request)
        if (error) reject(error)
        else resolve(value!)
      }
      const abort = () =>
        request.destroy(
          new Error(
            'Request stopped. Server cancellation is not confirmed; a submitted write outcome may be uncertain.',
          ),
        )
      const request = (this.profile.tls.enabled ? https : http).request(
        {
          hostname: this.transport.host,
          port: this.transport.port,
          method,
          path: this.prefix + path,
          agent: this.agent,
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/json',
            'User-Agent': 'Harbor-DB',
            ...(this.authorization ? { Authorization: this.authorization } : {}),
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          ...(this.profile.tls.enabled ? this.transport.tls : {}),
        },
        (response) => {
          const chunks: Buffer[] = []
          let bytes = 0
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            const error = new Error(
              'Compressed search responses are unsupported; the bounded identity response was required.',
            )
            finish(error)
            response.destroy()
            request.destroy()
            return
          }
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 8 * 1024 * 1024) {
              finish(
                new Error(
                  'Search response exceeds the 8 MiB limit. Narrow the query, aggregation or source fields.',
                ),
              )
              response.destroy()
              request.destroy()
              return
            }
            chunks.push(chunk)
          })
          response.once('error', (error) => finish(error))
          response.once('end', () => {
            if (complete) return
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
              const status = response.statusCode || 0
              let value: SearchJson = null
              if (status >= 200 && status < 300) value = text ? searchJson(text) : null
              else {
                try {
                  value = text ? searchJson(text) : null
                } catch {
                  /* Error bodies can be plain text; never expose them. */
                }
              }
              if (status < 200 || status >= 300) {
                let code = 'request_failed'
                try {
                  const error = searchObject(searchObject(value).error)
                  if (typeof error.type === 'string' && /^[a-zA-Z0-9_]+$/.test(error.type)) code = error.type
                } catch {
                  /* retain a static error without response payloads */
                }
                const reason =
                  status === 401
                    ? 'Authentication failed. Check credentials and reconnect.'
                    : status === 403
                      ? 'Permission denied. The selected operation requires additional index or cluster permissions.'
                      : status === 409
                        ? 'Conflict: the document changed or already exists. Reload it and review again; no automatic retry occurred.'
                        : status === 404
                          ? 'The index, document or point-in-time snapshot is unavailable. Reload explicitly.'
                          : status >= 300 && status < 400
                            ? 'Redirect refused; use the intended endpoint directly.'
                            : `Search request failed (${code}). Check the JSON DSL, mappings and server limits.`
                throw new SearchHttpError(status, code, reason)
              }
              finish(undefined, { body: value, headers: response.headers })
            } catch (error) {
              finish(error instanceof Error ? error : new Error('Invalid search response.'))
            }
          })
        },
      )
      const deadline = setTimeout(
        () =>
          request.destroy(
            new Error(
              'Search request timed out. Server completion is unconfirmed; submitted writes may have an uncertain outcome.',
            ),
          ),
        Math.min(Math.max(timeout, 1), 600000),
      )
      request.once('error', (error) => finish(error))
      this.active.add(request)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      request.end(payload)
    })
  }
  close(): void {
    this.closed = true
    for (const request of this.active)
      request.destroy(new Error('Search connection closed; submitted write outcomes may be uncertain.'))
    this.agent.destroy()
  }
}
