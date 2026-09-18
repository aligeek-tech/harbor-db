import http from 'node:http'
import https from 'node:https'
import { parse, stringify, isLosslessNumber, type LosslessNumber } from 'lossless-json'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import type { Transport } from './transport'

export type CouchJson =
  null | string | boolean | number | LosslessNumber | CouchJson[] | { [key: string]: CouchJson }
export type CouchObject = { [key: string]: CouchJson }
export function couchObject(value: CouchJson | undefined): CouchObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value))
    throw new Error('Expected a JSON object from the couch service.')
  return value
}
export function couchJson(source: string): CouchJson {
  try {
    return parse(source, undefined, {
      onDuplicateKey: () => {
        throw new Error('Duplicate key')
      },
    }) as CouchJson
  } catch {
    throw new Error('Enter valid JSON without duplicate object keys.')
  }
}
export function encodeCouchJson(value: CouchJson): string {
  return stringify(value)!
}
export function couchNumber(value: CouchJson | undefined, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  const result = Number(String(value))
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('The couch service returned an invalid count.')
  return result
}
export function couchPrefix(value: string): string {
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
export class CouchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
/** Fixed endpoint, no redirects, sniffing, retries or lossy numeric JSON decoding. */
export class CouchHttp {
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
    this.prefix = ''
    if (!profile.username || profile.username.includes(':') || secrets.password === undefined)
      throw new Error('CouchDB requires a username and password in the credential fields.')
    if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
      throw new Error('CouchDB TLS requires certificate and hostname verification.')
    this.authorization = 'Basic ' + Buffer.from(profile.username + ':' + secrets.password).toString('base64')
    this.agent = profile.tls.enabled
      ? new https.Agent({ keepAlive: true, maxSockets: 6, ...transport.tls })
      : new http.Agent({ keepAlive: true, maxSockets: 6 })
  }
  async request(
    method: string,
    path: string,
    body?: CouchJson,
    signal?: AbortSignal,
    timeout = this.profile.queryTimeout,
  ): Promise<{ body: CouchJson; headers: http.IncomingHttpHeaders }> {
    if (this.closed) throw new Error('CouchDB connection is closed. Reconnect explicitly.')
    if (signal?.aborted) throw new Error('Request stopped. Server cancellation is not confirmed.')
    if (this.active.size >= 32)
      throw new Error('Too many concurrent couch requests; wait for an existing request to finish.')
    const payload = body === undefined ? undefined : encodeCouchJson(body)
    if (payload && Buffer.byteLength(payload) > 1024 * 1024)
      throw new Error('The request exceeds the 1 MiB JSON limit.')
    return new Promise((resolve, reject) => {
      let complete = false
      const finish = (error?: Error, value?: { body: CouchJson; headers: http.IncomingHttpHeaders }) => {
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
              'Compressed couch responses are unsupported; the bounded identity response was required.',
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
                  'Couch response exceeds the 8 MiB limit. Narrow the query, aggregation or source fields.',
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
              let value: CouchJson = null
              if (status >= 200 && status < 300) value = text ? couchJson(text) : null
              else {
                try {
                  value = text ? couchJson(text) : null
                } catch {
                  /* Error bodies can be plain text; never expose them. */
                }
              }
              if (status < 200 || status >= 300) {
                let code = 'request_failed'
                try {
                  const error = couchObject(value)
                  if (typeof error.error === 'string' && /^[a-zA-Z0-9_]+$/.test(error.error))
                    code = error.error
                } catch {
                  /* retain a static error without response payloads */
                }
                const reason =
                  status === 401
                    ? 'Authentication failed. Check credentials and reconnect.'
                    : status === 403
                      ? 'Permission denied. The selected operation requires additional database permissions.'
                      : status === 409
                        ? 'Conflict: the document changed or already exists. Reload it and review again; no automatic retry occurred.'
                        : status === 404
                          ? 'The database or document revision is unavailable. Reload explicitly.'
                          : status >= 300 && status < 400
                            ? 'Redirect refused; use the intended endpoint directly.'
                            : code === 'invalid_index' || code === 'no_usable_index'
                              ? 'No usable index is available. Choose an existing suitable index, or explicitly allow fallback scanning and run again.'
                              : `CouchDB request failed (${code}). Check the selector, revision and server limits.`
                throw new CouchHttpError(status, code, reason)
              }
              finish(undefined, { body: value, headers: response.headers })
            } catch (error) {
              finish(error instanceof Error ? error : new Error('Invalid CouchDB response.'))
            }
          })
        },
      )
      const deadline = setTimeout(
        () =>
          request.destroy(
            new Error(
              'Couch request timed out. Server completion is unconfirmed; submitted writes may have an uncertain outcome.',
            ),
          ),
        Math.min(Math.max(timeout, 1), 600000),
      )
      request.once('error', () =>
        finish(
          new Error(
            'CouchDB transport stopped. A submitted write may have an uncertain outcome; inspect its revision before retrying. No request was replayed.',
          ),
        ),
      )
      this.active.add(request)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      request.end(payload)
    })
  }
  close(): void {
    this.closed = true
    for (const request of this.active)
      request.destroy(new Error('CouchDB connection closed; submitted write outcomes may be uncertain.'))
    this.agent.destroy()
  }
}
