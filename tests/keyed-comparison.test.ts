import { describe, expect, it } from 'vitest'
import { compareKeyedResults, type KeyedComparisonOptions } from '../src/shared/keyed-comparison'
import type { Cell, ResultSet } from '../src/shared/contracts'
const set = (rows: Cell[][], truncated = false): ResultSet => ({
  columns: [
    { name: 'id', type: 'bigint' },
    { name: 'value', type: 'text' },
  ],
  rows,
  truncated,
  affectedRows: 0,
  command: 'SELECT',
})
const options: KeyedComparisonOptions = {
  keys: [{ left: 0, right: 0 }],
  columns: [{ left: 1, right: 1 }],
  rowLimit: 1000,
  maxDifferences: 200,
}
const controls = () => ({ signal: new AbortController().signal, yield: async () => {} })
describe('incremental exact keyed comparison', () => {
  it('distinguishes NULL, empty, huge integers, duplicate groups, missing keys, binary, and timezone text without coercion', async () => {
    const left = set([
      ['9007199254740993', '1.000'],
      [null, ''],
      ['duplicate', 'a'],
      ['duplicate', 'b'],
      ['left', null],
      ['time', '2026-01-01T00:00:00Z'],
      ['bytes', { type: 'binary', base64: 'AAE=' }],
    ])
    const right = set([
      ['9007199254740993', '1.000'],
      [null, null],
      ['duplicate', 'a'],
      ['right', ''],
      ['time', '2025-12-31T19:00:00-05:00'],
      ['bytes', { type: 'binary', base64: 'AAI=' }],
    ])
    const result = await compareKeyedResults(left, right, options, controls())
    expect(result).toMatchObject({
      matched: 1,
      changed: 3,
      duplicateKeys: 1,
      nullKeys: 1,
      leftOnly: 1,
      rightOnly: 1,
      complete: true,
    })
    expect(result.differences.find((item) => item.kind === 'duplicate')).toMatchObject({
      leftRows: [2, 3],
      rightRows: [2],
    })
    expect(result.differences.find((item) => item.key[0] === 'time')?.kind).toBe('changed')
  })
  it('matches mapped composite columns while preserving duplicate labels by position and differing metadata', async () => {
    const left = set([[1, 'same']]),
      right = set([['same', 1]])
    right.columns = [
      { name: 'value', type: 'varchar' },
      { name: 'id', type: 'integer' },
    ]
    const result = await compareKeyedResults(
      left,
      right,
      {
        ...options,
        keys: [
          { left: 0, right: 1 },
          { left: 1, right: 0 },
        ],
        columns: [
          { left: 0, right: 1 },
          { left: 1, right: 0 },
        ],
      },
      controls(),
    )
    expect(result.matched).toBe(1)
    expect(result.metadataDifferences).toEqual([0, 1])
    expect((await compareKeyedResults(set([[1, 'a']]), set([['1', 'a']]), options, controls())).matched).toBe(
      0,
    )
  })
  it('marks capped or server-truncated scopes partial and bounds displayed differences', async () => {
    const result = await compareKeyedResults(
      set([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]),
      set(
        [
          [1, 'x'],
          [2, 'y'],
        ],
        true,
      ),
      { ...options, rowLimit: 2, maxDifferences: 1 },
      controls(),
    )
    expect(result).toMatchObject({
      complete: false,
      changed: 2,
      displayedAllDifferences: false,
      leftRows: 2,
      rightRows: 2,
    })
    expect(result.differences).toHaveLength(1)
  })
  it('yields while processing real-sized loaded arrays and acknowledges cancellation without partial success', async () => {
    const rows = Array.from({ length: 10000 }, (_, index) => [String(index), 'v'] as Cell[]),
      controller = new AbortController()
    let yields = 0
    await expect(
      compareKeyedResults(
        set(rows),
        set(rows),
        { ...options, rowLimit: 10000 },
        {
          signal: controller.signal,
          yield: async () => {
            if (++yields === 2) controller.abort()
          },
        },
      ),
    ).rejects.toThrow(/cancelled/)
    expect(yields).toBe(2)
    let steps = 0
    const result = await compareKeyedResults(
      set(rows),
      set([...rows].reverse()),
      { ...options, rowLimit: 10000 },
      {
        signal: new AbortController().signal,
        yield: async () => {
          steps++
        },
      },
    )
    expect(result.matched).toBe(10000)
    expect(steps).toBeGreaterThanOrEqual(300)
  })
  it('rejects invalid mappings, excess work, and oversized exact keys rather than silently truncating them', async () => {
    await expect(
      compareKeyedResults(
        set([[1, 'a']]),
        set([[1, 'a']]),
        {
          ...options,
          keys: [
            { left: 0, right: 0 },
            { left: 0, right: 1 },
          ],
        },
        controls(),
      ),
    ).rejects.toThrow(/only once/)
    await expect(
      compareKeyedResults(
        set([[1, 'a']]),
        set([[1, 'a']]),
        { ...options, columns: [{ left: 2, right: 0 }] },
        controls(),
      ),
    ).rejects.toThrow(/absent/)
    await expect(
      compareKeyedResults(set([['x'.repeat(17 * 1024 * 1024), 'a']]), set([]), options, controls()),
    ).rejects.toThrow(/16 MiB/)
  })
})
