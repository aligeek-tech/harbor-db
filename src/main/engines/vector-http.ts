import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import type { Transport } from './transport'

/** Native HTTP preserves custom CA, mutual TLS and the original server identity through SSH. */
export function vectorHttp(url: URL, init: RequestInit, transport: Transport): Promise<Response> {
  if (init.signal?.aborted) return Promise.reject(new Error('Vector request cancelled.'))
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request({
      hostname: transport.host, port: transport.port, path: url.pathname + url.search,
      method: init.method, ...transport.tls,
      headers: { ...(init.headers as Record<string, string>), Host: url.host, 'Accept-Encoding': 'identity' },
    }, response => {
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.destroy(); reject(new Error('Unsupported vector response encoding.')); return
      }
      response.once('close', cleanup)
      const body = [204, 205, 304].includes(response.statusCode || 0) ? null : Readable.toWeb(response)
      if (!body) response.resume()
      resolve(new Response(body as ReadableStream<Uint8Array> | null, { status: response.statusCode || 500 }))
    })
    const abort = () => request.destroy(new Error('Vector request cancelled.'))
    const cleanup = () => init.signal?.removeEventListener('abort', abort)
    request.once('error', () => { cleanup(); reject(new Error('Vector transport interrupted.')) })
    init.signal?.addEventListener('abort', abort, { once: true })
    if (init.signal?.aborted) abort()
    else request.end(init.body as string | undefined)
  })
}
