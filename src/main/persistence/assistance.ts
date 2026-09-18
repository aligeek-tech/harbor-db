import { randomUUID } from 'node:crypto'
import {
  assistancePreviewInputSchema,
  assistanceRequest,
  assistanceStartSchema,
  assistanceSuggestionSchema,
  type AssistancePreview,
  type AssistanceResult,
} from '../../shared/assistance'

const MAX_REQUEST_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const PREVIEW_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 60_000
const MAX_ACTIVE_REQUESTS = 2

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class AssistanceService {
  private readonly previews = new Map<
    string,
    { preview: AssistancePreview; createdAt: number }
  >()
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  preview(value: unknown): AssistancePreview {
    const input = assistancePreviewInputSchema.parse(value)
    this.prune()
    while (this.previews.size >= 3) this.previews.delete(this.previews.keys().next().value!)
    const token = randomUUID()
    const endpoint =
      input.provider === 'ollama-local'
        ? 'http://127.0.0.1:11434/api/generate'
        : 'https://ollama.com/api/generate'
    const request = assistanceRequest(input)
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES)
      throw new Error('The reviewed assistance scope exceeds the 128 KiB request limit.')
    const preview: AssistancePreview = {
      token,
      provider: input.provider,
      endpoint,
      task: input.task,
      model: input.model,
      engine: input.engine,
      scope: {
        queryCharacters: request.prompt.length,
        schemaItems: input.schemaFacts.length,
        rowData: false,
        parameterValues: false,
        credentials: false,
        localPaths: false,
      },
      request,
      warnings: [
        'Only the exact request shown here will be sent. Database content is treated as untrusted data.',
        'Harbor does not separately attach row data, parameter values, credentials, local paths or results.',
        'SQL and schema text can itself contain sensitive literals, comments, identifiers or paths. Redaction is best-effort; inspect the exact preview before sending.',
        'The suggestion is returned as an inert draft. Harbor DB never executes it automatically.',
      ],
      expiresAt: new Date(this.now() + PREVIEW_TTL_MS).toISOString(),
    }
    this.previews.set(token, { preview: structuredClone(preview), createdAt: this.now() })
    return structuredClone(preview)
  }

  async run(value: unknown): Promise<AssistanceResult> {
    const input = assistanceStartSchema.parse(value)
    this.prune()
    const record = this.previews.get(input.token)
    this.previews.delete(input.token)
    if (!record) throw new Error('This assistance preview expired. Review the outbound scope again.')
    if (this.running.has(input.requestId)) throw new Error('This assistance request is already running.')
    if (this.running.size >= MAX_ACTIVE_REQUESTS)
      throw new Error('Two assistance requests are already running. Wait or cancel one before starting another.')
    const remote = record.preview.provider === 'ollama-cloud'
    if (remote && (!input.consentRemote || !input.apiKey))
      throw new Error('Remote Ollama requires explicit consent and a session-only API key.')
    if (!remote && (input.consentRemote || input.apiKey))
      throw new Error('Local Ollama does not accept a remote API key or remote consent flag.')
    const controller = new AbortController()
    this.running.set(input.requestId, controller)
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS)
    timer.unref()
    try {
      const response = await this.fetcher(record.preview.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(remote ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify(record.preview.request),
      })
      const text = await boundedText(response, controller.signal)
      if (!response.ok)
        throw new Error(`Ollama returned HTTP ${response.status}. The provider response body was omitted.`)
      let outer: { response?: unknown; done?: unknown }
      try {
        outer = JSON.parse(text) as { response?: unknown; done?: unknown }
      } catch {
        throw new Error('Ollama returned invalid JSON. The provider response body was omitted.')
      }
      if (outer.done !== true || typeof outer.response !== 'string')
        throw new Error('Ollama returned an incomplete or invalid non-streaming response.')
      let suggestion: ReturnType<typeof assistanceSuggestionSchema.parse>
      try {
        suggestion = assistanceSuggestionSchema.parse(JSON.parse(outer.response))
      } catch {
        throw new Error('Ollama returned an invalid structured suggestion. Provider content was omitted.')
      }
      return {
        requestId: input.requestId,
        provider: record.preview.provider,
        model: record.preview.model,
        suggestion,
        inert: true,
        completedAt: new Date(this.now()).toISOString(),
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          controller.signal.reason === 'timeout'
            ? 'Assistance timed out after 60 seconds. No SQL was executed.'
            : 'Assistance was cancelled. No SQL was executed.',
        )
      throw error
    } finally {
      clearTimeout(timer)
      this.running.delete(input.requestId)
    }
  }

  cancel(requestId: string): { requested: boolean } {
    const controller = this.running.get(requestId)
    if (!controller) return { requested: false }
    controller.abort('cancelled')
    return { requested: true }
  }

  close(): void {
    for (const controller of this.running.values()) controller.abort('cancelled')
    this.running.clear()
    this.previews.clear()
  }

  private prune(): void {
    for (const [token, record] of this.previews)
      if (this.now() - record.createdAt > PREVIEW_TTL_MS) this.previews.delete(token)
  }
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    if (signal.aborted) throw new Error('cancelled')
    const item = await reader.read()
    if (item.done) break
    bytes += item.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Ollama response exceeds the 256 KiB limit. No SQL was executed.')
    }
    chunks.push(item.value)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged)
}
