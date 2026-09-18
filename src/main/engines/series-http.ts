import http from 'node:http'
import https from 'node:https'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import type { Transport } from './transport'
export class SeriesHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Time-series authentication was rejected. Reconnect explicitly with a current credential.'
        : status === 403
          ? 'Time-series permission denied. No privileges were changed.'
          : `Time-series server returned HTTP ${status}. Response details are omitted; no automatic replay occurred.`,
    )
  }
}
/** One explicit origin, original-host TLS verification, no redirects or automatic retry. */
export class SeriesHttp {
  private agent: http.Agent | https.Agent
  private active = new Set<http.ClientRequest>()
  private closed = false
  private authorization: string
  constructor(
    private profile: ConnectionProfile,
    private transport: Transport,
    secrets: Secrets,
  ) {
    if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
      throw new Error('Time-series TLS requires certificate verification.')
    if (
      !profile.tls.enabled &&
      !profile.ssh.enabled &&
      !['localhost', '127.0.0.1', '::1'].includes(profile.host)
    )
      throw new Error('Use verified TLS or pinned SSH for a remote time-series endpoint.')
    if (/[\r\n\0]/.test(secrets.password || '') || /[:\r\n\0]/.test(profile.username))
      throw new Error('Invalid authentication fields.')
    this.authorization =
      profile.engine === 'influxdb'
        ? `Token ${secrets.password || ''}`
        : profile.username
          ? `Basic ${Buffer.from(profile.username + ':' + (secrets.password || '')).toString('base64')}`
          : ''
    this.agent = profile.tls.enabled
      ? new https.Agent({ ...transport.tls, keepAlive: true, maxSockets: 4 })
      : new http.Agent({ keepAlive: true, maxSockets: 4 })
  }
  request(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    signal?: AbortSignal,
    timeout = this.profile.queryTimeout,
  ): Promise<string> {
    if (this.closed || signal?.aborted)
      return Promise.reject(new Error('Time-series request cancelled before dispatch.'))
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\r\n\0#]/.test(path) ||
      Buffer.byteLength(path) > 64000
    )
      return Promise.reject(new Error('Invalid time-series API path.'))
    if (body && Buffer.byteLength(body) > 256 * 1024)
      return Promise.reject(new Error('Time-series request exceeds 256 KiB.'))
    if (this.active.size >= 4)
      return Promise.reject(new Error('Four time-series requests are already active.'))
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error?: Error, value?: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.active.delete(request)
        if (error) reject(error)
        else resolve(value!)
      }
      const request = (this.profile.tls.enabled ? https : http).request(
        {
          host: this.transport.host,
          port: this.transport.port,
          method,
          path,
          agent: this.agent,
          ...this.transport.tls,
          headers: {
            Host:
              (this.profile.host.includes(':') ? '[' + this.profile.host + ']' : this.profile.host) +
              ':' +
              this.profile.port,
            Accept:
              this.profile.engine === 'influxdb' && method === 'POST'
                ? 'application/csv'
                : 'application/json',
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/json',
            'Statement-Timeout': String(timeout),
            ...(this.authorization ? { Authorization: this.authorization } : {}),
            ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          },
        },
        (response) => {
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            finish(new SeriesHttpError(response.statusCode || 0))
            response.destroy()
            return
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            finish(new Error('Unsupported time-series response encoding.'))
            response.destroy()
            return
          }
          const parts: Buffer[] = []
          let bytes = 0
          response.on('data', (part: Buffer) => {
            bytes += part.length
            if (bytes > 8 * 1024 * 1024) {
              finish(new Error('Time-series response exceeds 8 MiB. Narrow the time range or fields.'))
              response.destroy()
            } else parts.push(part)
          })
          response.on('error', () =>
            finish(
              new Error(
                'Time-series response interrupted. Submitted work may have completed; inspect before retrying.',
              ),
            ),
          )
          response.on('end', () => {
            try {
              finish(undefined, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
            } catch {
              finish(new Error('Invalid UTF-8 time-series response.'))
            }
          })
        },
      )
      const abort = () => request.destroy(new Error('Cancelled'))
      const timer = setTimeout(abort, timeout)
      request.on('error', () =>
        finish(
          new Error(
            'Time-series transport interrupted or deadline exceeded. Server cancellation and any write outcome are unconfirmed; no replay occurred.',
          ),
        ),
      )
      this.active.add(request)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else request.end(body)
    })
  }
  close() {
    this.closed = true
    for (const request of this.active) request.destroy()
    this.agent.destroy()
    this.authorization = ''
  }
}
