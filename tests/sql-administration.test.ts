import { describe, expect, it, vi } from 'vitest'
import { SqlAdministrationService } from '../src/main/persistence/sql-administration'
import { profileSchema, type QueryInput } from '../src/shared/contracts'
import {
  previewSqlAdministrationSchema,
  executeSqlAdministrationSchema,
  inspectSqlAdministrationSchema,
} from '../src/shared/sql-administration'

describe('SQL administration trust and payload boundaries', () => {
  const profile = profileSchema.parse({
    id: 'admin',
    name: 'Bounded inspection',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 1,
    username: 'fixture',
    database: 'fixture',
    readOnly: false,
  })
  it('bounds the aggregate of multiple driver result sets and marks omitted rows', async () => {
    const adapter = {
      execute: vi.fn(async (_input: QueryInput) => ({
        requestId: 'snapshot',
        durationMs: 1,
        transaction: 'idle' as const,
        messages: [],
        sets: [
          {
            columns: [{ name: 'catalog_value', type: 'text' }],
            rows: [['x'.repeat(5 * 1024 * 1024)]],
            command: 'SELECT',
            affectedRows: 0,
            truncated: false,
          },
        ],
      })),
      closeSession: vi.fn(async () => undefined),
      transaction: vi.fn(async () => ({ state: 'idle' as const })),
    }
    const service = new SqlAdministrationService({ profile: () => profile, adapter: () => adapter })
    const snapshot = await service.inspect({
      connectionId: profile.id,
      kind: 'health',
      includeQueryText: false,
    })
    expect(snapshot.sets).toHaveLength(2)
    expect(snapshot.sets[0].rows).toHaveLength(1)
    expect(snapshot.sets[1]).toMatchObject({ rows: [], truncated: true })
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(8 * 1024 * 1024)
    expect(snapshot.warnings.join(' ')).toContain('aggregate 8 MiB')
    expect(adapter.execute.mock.calls.every(([input]) => input.privateSession && input.maxRows === 201)).toBe(
      true,
    )
    expect(adapter.closeSession).toHaveBeenCalledOnce()
  })
  it('blocks read-only administration before any database query', async () => {
    const adapter = { execute: vi.fn(), transaction: vi.fn(), closeSession: vi.fn(async () => undefined) }
    const service = new SqlAdministrationService({
      profile: () => ({ ...profile, readOnly: true }),
      adapter: () => adapter,
    })
    const result = await service.preview({
      target: { connectionId: profile.id },
      action: { kind: 'session', mode: 'terminate', sessionId: '123' },
    })
    expect(result.blockedReasons.join(' ')).toContain('read-only')
    expect(adapter.execute).not.toHaveBeenCalled()
    await expect(service.execute({ token: result.token, confirm: result.confirmation })).rejects.toThrow(
      /expired/,
    )
  })
  it('rejects renderer SQL, unbounded session IDs and unsupported privileges at the shared IPC boundary', () => {
    expect(
      executeSqlAdministrationSchema.safeParse({
        token: crypto.randomUUID(),
        confirm: 'target',
        sql: 'DROP TABLE x',
      }).success,
    ).toBe(false)
    expect(
      previewSqlAdministrationSchema.safeParse({
        target: { connectionId: profile.id },
        action: { kind: 'session', mode: 'terminate', sessionId: '1; DROP DATABASE fixture' },
      }).success,
    ).toBe(false)
    expect(
      previewSqlAdministrationSchema.safeParse({
        target: { connectionId: profile.id },
        action: { kind: 'privilege', mode: 'grant', principal: 'fixture', privileges: ['ALL PRIVILEGES'] },
      }).success,
    ).toBe(false)
    expect(
      inspectSqlAdministrationSchema.safeParse({ connectionId: profile.id, kind: 'health', limit: 10000000 })
        .success,
    ).toBe(false)
  })
})
