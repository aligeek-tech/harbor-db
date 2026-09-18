import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationService } from '../src/main/persistence/automation'
import { MetadataStore, SCHEMA_VERSION } from '../src/main/persistence/store'
import {
  automationDefinitionSchema,
  automationHostTimeZone,
  nextDailyRun,
  type AutomationDefinition,
} from '../src/shared/automation'

const directories: string[] = []
const stores: MetadataStore[] = []
const openStore = () => {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-automation-'))
  directories.push(directory)
  const store = new MetadataStore(directory)
  stores.push(store)
  return { store, directory }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

function task(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionSchema.parse({
    id: crypto.randomUUID(),
    name: 'Daily bounded report',
    enabled: true,
    schedule: { kind: 'daily', hour: 3, minute: 15, timeZone: automationHostTimeZone() },
    target: { kind: 'report', connectionId: 'duck', reportId: 'report-1' },
    limits: { maxDurationMs: 30_000, maxRows: 1000, maxOutputBytes: 1_000_000 },
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    nextRunAt: '2026-09-18T03:15:00.000Z',
    ...overrides,
  })
}

describe('reusable local task automation', () => {
  it('persists strict secret-free definitions and bounded structured logs in schema v6', () => {
    const { store, directory } = openStore()
    const value = store.saveAutomation(task())
    store.saveAutomationRun({
      id: crypto.randomUUID(), taskId: value.id, state: 'completed', code: 'completed', trigger: 'manual',
      startedAt: '2026-09-18T01:00:00.000Z', finishedAt: '2026-09-18T01:00:01.000Z',
      rows: 10, bytes: 20, message: 'Completed within configured limits.',
    })
    expect(store.automations()).toEqual([value])
    expect(store.automationRuns(value.id)[0]).toMatchObject({ rows: 10, state: 'completed' })
    expect(SCHEMA_VERSION).toBe(6)
    expect(readdirSync(directory).some((name) => name.includes('before-v6'))).toBe(false)
    expect(() => store.saveAutomation({ ...value, apiKey: 'CANARY_SECRET' } as never)).toThrow()
  })

  it('records missed desktop schedules without backfill or execution', () => {
    const { store } = openStore()
    const missed = task()
    store.saveAutomation(missed)
    const execute = vi.fn()
    const scheduler = new AutomationService(store, execute, () => Date.parse('2026-09-18T12:00:00.000Z'))
    scheduler.start()
    scheduler.close()
    expect(execute).not.toHaveBeenCalled()
    expect(store.automationRuns(missed.id)[0]).toMatchObject({
      state: 'desktop-unavailable',
      code: 'desktop-runtime-unavailable',
      trigger: 'startup-audit',
    })
    expect(new Date(store.automations()[0].nextRunAt!).getTime()).toBeGreaterThan(
      Date.parse('2026-09-18T12:00:00.000Z'),
    )
  })

  it('requires a fresh reviewed source for every import and never calls the executor without it', async () => {
    const { store } = openStore()
    const value = task({
      schedule: { kind: 'manual' },
      target: {
        kind: 'import', connectionId: 'pg',
        target: { connectionId: 'pg', schema: 'public', table: 'orders' },
        options: { format: 'csv', encoding: 'utf8', delimiter: ',', header: true, nullToken: '\\N' },
        mapping: [{ source: 0, target: 'id', type: 'integer' }], batchSize: 100, errorPolicy: 'stop',
      },
    })
    store.saveAutomation(value)
    const execute = vi.fn()
    const scheduler = new AutomationService(store, execute)
    const outcome = await scheduler.run(value.id)
    expect(outcome).toMatchObject({ state: 'needs-review', code: 'fresh-import-review-required' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('enforces one-at-a-time execution, cancellation and duration limits', async () => {
    vi.useFakeTimers()
    const { store } = openStore()
    const value = task({ schedule: { kind: 'manual' }, limits: { maxDurationMs: 1000, maxRows: 10, maxOutputBytes: 1024 } })
    store.saveAutomation(value)
    const scheduler = new AutomationService(
      store,
      (_task, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      () => Date.parse('2026-09-18T12:00:00.000Z'),
    )
    const running = scheduler.run(value.id)
    expect(() => scheduler.run(value.id)).toThrow('already running')
    await vi.advanceTimersByTimeAsync(1001)
    await expect(running).resolves.toMatchObject({ state: 'failed', code: 'resource-limit' })
  })

  it('redacts secrets, credential URIs and local paths from failure logs', async () => {
    const { store } = openStore()
    const value = task({ schedule: { kind: 'manual' } })
    store.saveAutomation(value)
    const scheduler = new AutomationService(store, async () => {
      throw new Error('password=PRIVATE postgres://owner:PRIVATE@db /Users/alice/private.csv')
    })
    const run = await scheduler.run(value.id)
    expect(run.state).toBe('failed')
    expect(run.message).not.toContain('PRIVATE')
    expect(run.message).not.toContain('/Users/alice')
    expect(run.message).toContain('[redacted]')
  })

  it('preserves edits made while a task is running instead of advancing a stale snapshot', async () => {
    const { store } = openStore()
    const value = task()
    store.saveAutomation(value)
    let finish!: () => void
    const scheduler = new AutomationService(store, () => new Promise((resolve) => {
      finish = () => resolve({ rows: 1, bytes: 1, message: 'done' })
    }))
    const running = scheduler.run(value.id)
    await Promise.resolve()
    store.saveAutomation({
      ...value,
      name: 'Edited while running',
      enabled: false,
      schedule: { kind: 'manual' },
      nextRunAt: undefined,
      updatedAt: '2026-09-18T01:00:00.000Z',
    })
    finish()
    await running
    expect(store.automations()[0]).toMatchObject({
      name: 'Edited while running',
      enabled: false,
      schedule: { kind: 'manual' },
    })
    expect(store.automations()[0].nextRunAt).toBeUndefined()
  })

  it('rejects a foreign or drifted daily time zone and disables an existing mismatched schedule at startup', () => {
    const host = automationHostTimeZone()
    const foreign = host === 'Etc/UTC' ? 'Asia/Tehran' : 'Etc/UTC'
    expect(() => nextDailyRun({ kind: 'daily', hour: 3, minute: 15, timeZone: foreign }, new Date())).toThrow(
      'desktop now uses',
    )
    const { store } = openStore()
    const value = task({ schedule: { kind: 'daily', hour: 3, minute: 15, timeZone: foreign } })
    store.saveAutomation(value)
    const scheduler = new AutomationService(store, vi.fn())
    scheduler.start()
    scheduler.close()
    expect(store.automations()[0].enabled).toBe(false)
    expect(store.automationRuns(value.id)[0]).toMatchObject({
      state: 'failed',
      code: 'schedule-zone-mismatch',
    })
  })

  it('cannot report completed after cancellation even when the executor resolves', async () => {
    const { store } = openStore()
    const value = task({ schedule: { kind: 'manual' } })
    store.saveAutomation(value)
    let finish!: () => void
    const scheduler = new AutomationService(store, () => new Promise((resolve) => {
      finish = () => resolve({ rows: 1, bytes: 1, message: 'late success' })
    }))
    const running = scheduler.run(value.id)
    expect(scheduler.cancel(value.id)).toEqual({ requested: true })
    finish()
    await expect(running).resolves.toMatchObject({ state: 'cancelled', code: 'cancelled' })
  })

  it('clears its running lock when repository run persistence fails', async () => {
    const { store } = openStore()
    const value = task({ schedule: { kind: 'manual' } })
    store.saveAutomation(value)
    const original = store.saveAutomationRun.bind(store)
    vi.spyOn(store, 'saveAutomationRun')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })
      .mockImplementation((run) => original(run))
    const scheduler = new AutomationService(store, async () => ({ rows: 1, bytes: 1, message: 'done' }))
    await expect(scheduler.run(value.id)).rejects.toThrow('disk unavailable')
    await expect(scheduler.run(value.id)).resolves.toMatchObject({ state: 'completed' })
  })

  it('rejects an import whose nested destination uses another connection', () => {
    expect(() => task({
      schedule: { kind: 'manual' },
      target: {
        kind: 'import',
        connectionId: 'pg',
        target: { connectionId: 'other', schema: 'public', table: 'orders' },
        options: { format: 'csv', encoding: 'utf8', delimiter: ',', header: true, nullToken: '\\N' },
        mapping: [{ source: 0, target: 'id', type: 'integer' }],
        batchSize: 100,
        errorPolicy: 'stop',
      },
    })).toThrow('reviewed import destination')
  })
})
