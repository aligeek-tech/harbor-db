import { describe, expect, it, vi } from 'vitest'
import { Db2Process } from '../src/main/engines/db2-process'

const fixture = new URL('./fixtures/db2-process.mjs', import.meta.url)
const query = { action: 'query' as const, sql: 'block', parameters: [], maxRows: 1, timeout: 1000 }
describe('Db2 parent isolation and backpressure with a protocol fixture, not a native driver', () => {
  it('kills a synchronously blocked child on deadline, remains responsive, and never reconnects it', async () => {
    const process = new Db2Process(fixture)
    try {
      await process.request({ action: 'open', connectionString: 'fixture', timeout: 1000 }, 2000)
      let ticks = 0
      const interval = setInterval(() => ticks++, 10)
      const started = performance.now()
      await expect(process.request(query, 150)).rejects.toThrow(/Server completion is unconfirmed/)
      clearInterval(interval)
      expect(ticks).toBeGreaterThan(2)
      expect(performance.now() - started).toBeLessThan(2000)
      expect(process.dead).toBe(true)
      await expect(process.request({ ...query, sql: 'SELECT 1' }, 1000)).rejects.toThrow(
        /No statement was replayed/,
      )
    } finally {
      await process.close()
    }
  })
  it('does not acknowledge a row until the asynchronous sink completes', async () => {
    const process = new Db2Process(fixture),
      abort = new AbortController()
    let release: () => void = () => {},
      completed = false
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const onRow = vi.fn(async () => barrier)
    try {
      const execution = process
        .request({ ...query, sql: 'stream', stream: true }, 3000, {
          signal: abort.signal,
          onColumns: async () => {},
          onRow,
        })
        .then(() => {
          completed = true
        })
      await vi.waitFor(() => expect(onRow).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      release()
      await execution
      expect(completed).toBe(true)
    } finally {
      release()
      await process.close()
    }
  })
  it('kills a child that violates stream backpressure and rejects sink errors without echoing secret content', async () => {
    for (const violate of [true, false]) {
      const process = new Db2Process(fixture),
        abort = new AbortController()
      let release: () => void = () => {}
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await expect(
          process.request({ ...query, sql: violate ? 'break-protocol' : 'stream', stream: true }, 3000, {
            signal: abort.signal,
            onColumns: async () => {
              if (violate) await barrier
            },
            onRow: async () => {
              throw new Error('private payload')
            },
          }),
        ).rejects.toThrow(violate ? /backpressure/ : /consumer failed/)
        expect(process.dead).toBe(true)
      } finally {
        release()
        await process.close()
      }
    }
  })
  it('cancels a blocked child while another independent session stays usable', async () => {
    const first = new Db2Process(fixture),
      second = new Db2Process(fixture)
    try {
      const pending = first.request(query, 4000)
      const rejection = expect(pending).rejects.toThrow(/unconfirmed/)
      first.cancel()
      await rejection
      expect((await second.request({ ...query, sql: 'SELECT 1' }, 2000)).set?.truncated).toBe(false)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})
