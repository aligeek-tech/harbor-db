import { describe, expect, it } from 'vitest'
import { AssistanceService } from '../src/main/persistence/assistance'

const live = Boolean(process.env.HARBOR_OLLAMA_MODEL)
const model = process.env.HARBOR_OLLAMA_MODEL || 'qwen3:0.6b'

describe.skipIf(!live)('Ollama local live contract', () => {
  it(
    'returns a bounded structured suggestion that remains inert',
    async () => {
      const service = new AssistanceService()
      const preview = service.preview({
        task: 'explain',
        provider: 'ollama-local',
        model,
        engine: 'postgres',
        query: 'SELECT id, total_cents FROM synthetic_orders WHERE total_cents > 1000 ORDER BY id',
        schemaFacts: [
          {
            kind: 'table',
            name: 'synthetic_orders',
            definition: 'CREATE TABLE synthetic_orders(id bigint PRIMARY KEY, total_cents bigint NOT NULL)',
          },
        ],
      })

      expect(preview.endpoint).toBe('http://127.0.0.1:11434/api/generate')
      expect(preview.scope).toMatchObject({
        rowData: false,
        parameterValues: false,
        credentials: false,
        localPaths: false,
      })

      const result = await service.run({
        token: preview.token,
        requestId: crypto.randomUUID(),
      })

      expect(result).toMatchObject({
        provider: 'ollama-local',
        model,
        inert: true,
      })
      expect(result.suggestion.summary.length).toBeGreaterThan(0)
      expect(result.suggestion.sql).toBeTypeOf('string')
      expect(result.suggestion.risks).toBeInstanceOf(Array)
      service.close()
    },
    70_000,
  )
})
