import https from 'node:https'
import type { RequestOptions } from 'node:https'
import { createGunzip } from 'node:zlib'
import { isLosslessNumber, parse, stringify } from 'lossless-json'

export type JsonRecord = Record<string, unknown>
export const record = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isLosslessNumber(value))
    throw new Error('The provider returned an invalid object.')
  return value as JsonRecord
}
export const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('The provider returned an invalid list.')
  return value
}
export const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('The provider returned an invalid text field.')
  return value
}
export const exact = (value: unknown): string => {
  const result = String(value)
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(result))
    throw new Error('The provider returned an invalid exact number.')
  return result
}
export const canonical = (value: unknown): string => stringify(value)!
export interface JsonEndpoint {
  request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<JsonRecord>
  close(): void
}
export class CloudHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Authentication token expired or was rejected. Supply a fresh token and reconnect explicitly.'
        : status === 403
          ? 'Provider permission denied. No privileges were changed.'
          : `Provider returned HTTP ${status}. Driver details are omitted; no automatic retry occurred.`,
    )
  }
}

/** Fixed HTTPS endpoint, exact JSON and a bounded body. No redirects, cloud discovery, ambient credentials or replay. */
export class CloudJson implements JsonEndpoint {
  private agent: https.Agent
  private active = new Set<ReturnType<typeof https.request>>()
  private closed = false
  constructor(
    private host: string,
    private token: string,
    private timeout: number,
    private headers: Record<string, string> = {},
    ca?: string,
    private gzip = false,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]+$/i.test(host) || host.includes('..'))
      throw new Error('Use a plain provider hostname without a URL, credentials or path.')
    if (!token || /[\r\n\0]/.test(token)) throw new Error('Enter a valid session access token.')
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    })
  }
  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    if (this.closed || signal?.aborted) throw new Error('Provider request cancelled before dispatch.')
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\0#]/.test(path))
      throw new Error('Invalid provider API path.')
    if (this.active.size >= 8) throw new Error('Provider request concurrency limit reached.')
    const data = body === undefined ? undefined : JSON.stringify(body)
    if (data && Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('Provider request exceeds 2 MiB.')
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error?: Error, value?: JsonRecord) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.active.delete(request)
        if (error) reject(error)
        else resolve(value!)
      }
      const options: RequestOptions = {
        host: this.host,
        port: 443,
        path,
        method,
        agent: this.agent,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Accept-Encoding': this.gzip ? 'gzip' : 'identity',
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...this.headers,
        },
      }
      const request = https.request(options, (response) => {
        const parts: Buffer[] = []
        let bytes = 0
        const encoding = response.headers['content-encoding'] || 'identity'
        if (encoding !== 'identity' && !(encoding === 'gzip' && this.gzip)) {
          finish(new Error('The provider returned an unsupported content encoding.'))
          response.destroy()
          return
        }
        const decoded = encoding === 'gzip' ? response.pipe(createGunzip()) : response
        let transferred = 0
        response.on('data', (part: Buffer) => {
          transferred += part.length
          if (transferred > 32 * 1024 * 1024) {
            finish(new Error('Provider compressed page exceeds 32 MiB.'))
            decoded.destroy()
            response.destroy()
          }
        })
        decoded.on('data', (part: Buffer) => {
          bytes += part.length
          if (bytes > 32 * 1024 * 1024) {
            finish(new Error('Provider page exceeds 32 MiB; select fewer or smaller fields.'))
            decoded.destroy()
            response.destroy()
          } else parts.push(part)
        })
        response.on('error', () =>
          finish(
            new Error(
              'Provider response interrupted. Submitted work may have completed; no replay occurred.',
            ),
          ),
        )
        decoded.on('error', () => {
          finish(new Error('Provider JSON transfer or compression was invalid.'))
          response.destroy()
        })
        decoded.on('end', () => {
          try {
            if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300)
              throw new CloudHttpError(response.statusCode || 0)
            const bytes = Buffer.concat(parts)
            finish(
              undefined,
              bytes.length ? record(parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) : {},
            )
          } catch (error) {
            finish(
              error instanceof CloudHttpError
                ? error
                : new Error('Provider returned invalid bounded JSON; response contents are omitted.'),
            )
          }
        })
      })
      const abort = () => request.destroy(new Error('Cancelled'))
      const timer = setTimeout(abort, this.timeout)
      this.active.add(request)
      request.once('error', () =>
        finish(
          new Error('Provider transport interrupted. Submitted work may have completed; no replay occurred.'),
        ),
      )
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else request.end(data)
    })
  }
  close(): void {
    this.closed = true
    for (const request of this.active) request.destroy()
    this.agent.destroy()
    this.token = ''
  }
}
