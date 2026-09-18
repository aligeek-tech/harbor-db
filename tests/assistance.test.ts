import { describe, expect, it, vi } from 'vitest'
import { AssistanceService } from '../src/main/persistence/assistance'
import { assistancePreviewInputSchema } from '../src/shared/assistance'

const previewInput = (provider: 'ollama-local' | 'ollama-cloud' = 'ollama-local') => ({
  task: 'explain' as const,
  provider,
  model: provider === 'ollama-local' ? 'qwen2.5-coder:7b' : 'gemma4:31b',
  engine: 'postgres' as const,
  query:
    "SELECT * FROM orders WHERE owner='safe'; -- password=private postgres://admin:private@db.example/harbor /Users/alice/private.sql",
  schemaFacts: [
    {
      kind: 'table' as const,
      name: 'orders',
      definition: 'CREATE TABLE orders(id bigint); -- token=private',
    },
  ],
})

const successfulResponse = () =>
  new Response(
    JSON.stringify({
      done: true,
      response: JSON.stringify({
        summary: 'Uses a sequential scan.',
        sql: 'SELECT * FROM orders WHERE id = $1',
        risks: ['Review the target and parameter before execution.'],
      }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('opt-in Ollama assistance boundary', () => {
  it('pins an exact redacted local request with no separate data attachments and an honest text warning', () => {
    const service = new AssistanceService()
    const preview = service.preview(previewInput())
    expect(preview.endpoint).toBe('http://127.0.0.1:11434/api/generate')
    expect(preview.scope).toEqual({
      queryCharacters: expect.any(Number),
      schemaItems: 1,
      rowData: false,
      parameterValues: false,
      credentials: false,
      localPaths: false,
    })
    const text = JSON.stringify(preview.request)
    for (const secret of ['password=private', 'admin:private', '/Users/alice', 'token=private'])
      expect(text).not.toContain(secret)
    expect(text).toContain('untrusted data')
    expect(preview.warnings.join(' ')).toContain('Redaction is best-effort')
    expect(preview.request).toMatchObject({ stream: false, think: false, keep_alive: 0 })
    expect(() => assistancePreviewInputSchema.parse({ ...previewInput(), rowData: [['private']] })).toThrow()
  })

  it('calls only the fixed local endpoint and returns an inert suggestion', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => successfulResponse())
    const service = new AssistanceService(fetcher)
    const preview = service.preview(previewInput())
    const result = await service.run({ token: preview.token, requestId: crypto.randomUUID() })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:11434/api/generate')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined()
    expect(result).toMatchObject({
      provider: 'ollama-local',
      inert: true,
      suggestion: { sql: 'SELECT * FROM orders WHERE id = $1' },
    })
    await expect(
      service.run({ token: preview.token, requestId: crypto.randomUUID() }),
    ).rejects.toThrow('expired')
  })

  it('requires explicit remote consent and a session-only key, and redacts it from errors', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('provider echoed REMOTE_KEY_PRIVATE', { status: 401 }),
    )
    const service = new AssistanceService(fetcher)
    let preview = service.preview(previewInput('ollama-cloud'))
    await expect(service.run({ token: preview.token, requestId: crypto.randomUUID() })).rejects.toThrow(
      'explicit consent',
    )
    preview = service.preview(previewInput('ollama-cloud'))
    await expect(
      service.run({
        token: preview.token,
        requestId: crypto.randomUUID(),
        consentRemote: true,
        apiKey: 'REMOTE_KEY_PRIVATE',
      }),
    ).rejects.not.toThrow('REMOTE_KEY_PRIVATE')
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://ollama.com/api/generate')
    expect((init!.headers as Record<string, string>).authorization).toBe(
      'Bearer REMOTE_KEY_PRIVATE',
    )
  })

  it('cancels the actual request and accepts a later preview without replay', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const service = new AssistanceService(fetcher)
    const preview = service.preview(previewInput())
    const requestId = crypto.randomUUID()
    const running = service.run({ token: preview.token, requestId })
    await Promise.resolve()
    expect(service.cancel(requestId)).toEqual({ requested: true })
    await expect(running).rejects.toThrow('cancelled')
    expect(service.cancel(requestId)).toEqual({ requested: false })
    expect(service.preview(previewInput()).token).not.toBe(preview.token)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects oversized and invalid provider responses without returning SQL', async () => {
    const oversized = new Response('x'.repeat(256 * 1024 + 1), { status: 200 })
    const service = new AssistanceService(async () => oversized)
    const preview = service.preview(previewInput())
    await expect(
      service.run({ token: preview.token, requestId: crypto.randomUUID() }),
    ).rejects.toThrow('256 KiB')

    const invalid = new AssistanceService(async () =>
      new Response(JSON.stringify({ done: true, response: '{"sql":"SELECT 1","extra":true}' })),
    )
    const invalidPreview = invalid.preview(previewInput())
    await expect(
      invalid.run({ token: invalidPreview.token, requestId: crypto.randomUUID() }),
    ).rejects.toThrow('invalid structured suggestion')
  })

  it('never echoes provider-body canaries from HTTP, outer JSON, or structured-output errors', async () => {
    for (const response of [
      new Response('HTTP_CANARY_PRIVATE', { status: 503 }),
      new Response('{OUTER_JSON_CANARY_PRIVATE', { status: 200 }),
      new Response(JSON.stringify({ done: true, response: '{"summary":"STRUCTURED_CANARY_PRIVATE"}' })),
    ]) {
      const service = new AssistanceService(async () => response)
      const preview = service.preview(previewInput())
      let message = ''
      try {
        await service.run({ token: preview.token, requestId: crypto.randomUUID() })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).not.toContain('CANARY_PRIVATE')
      expect(message).toMatch(/omitted|invalid structured suggestion/)
    }
  })

  it('bounds all active assistance requests, not only duplicate request identifiers', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const service = new AssistanceService(fetcher)
    const requestIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const previews = requestIds.map(() => service.preview(previewInput()))
    const first = service.run({ token: previews[0].token, requestId: requestIds[0] })
    const second = service.run({ token: previews[1].token, requestId: requestIds[1] })
    await expect(service.run({ token: previews[2].token, requestId: requestIds[2] })).rejects.toThrow(
      'Two assistance requests are already running',
    )
    expect(service.cancel(requestIds[0])).toEqual({ requested: true })
    expect(service.cancel(requestIds[1])).toEqual({ requested: true })
    await expect(first).rejects.toThrow('cancelled')
    await expect(second).rejects.toThrow('cancelled')
  })
})
