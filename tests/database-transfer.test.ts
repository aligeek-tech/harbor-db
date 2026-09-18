import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseTransferService } from '../src/main/persistence/database-transfer'
import { ImportBatchError } from '../src/main/persistence/import-writer'
import {
  profileSchema,
  type Cell,
  type ColumnInfo,
  type ResultColumn,
  type TableStructure,
} from '../src/shared/contracts'
import type {
  PreviewDatabaseTransferInput,
  StartDatabaseTransferInput,
} from '../src/shared/database-transfer'

const column: ColumnInfo = {
  name: 'value',
  type: 'text',
  nullable: true,
  primaryKey: false,
  defaultValue: null,
}
function fixture() {
  const source = profileSchema.parse({
    id: 'source',
    name: 'Source',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    readOnly: true,
  })
  const target = profileSchema.parse({
    id: 'target',
    name: 'Destination',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    readOnly: false,
  })
  const profiles = new Map([
    [source.id, source],
    [target.id, target],
  ])
  let rows: Cell[][] = [['one'], ['two'], ['three']]
  let columns: ResultColumn[] = [{ name: 'value', type: 'text' }]
  const structure: TableStructure = { columns: [column], ddl: '', constraints: [], indexes: [] }
  const writer = {
    columns: structure.columns,
    writeBatch: vi.fn(async (_rows: Cell[][]) => {}),
    close: vi.fn(async () => {}),
  }
  const backend = {
    profile: (id: string) => profiles.get(id)!,
    structure: vi.fn(async () => structuredClone(structure)),
    openImport: vi.fn(async () => writer),
    streamQuery: vi.fn(async (_input, sink) => {
      await sink.onColumns(columns)
      for (const row of rows) {
        if (sink.signal.aborted) throw new Error('Cancelled')
        await sink.onRow(row)
      }
    }),
  } satisfies ConstructorParameters<typeof DatabaseTransferService>[0]
  const service = new DatabaseTransferService(backend)
  const request: PreviewDatabaseTransferInput = {
    source: { connectionId: source.id, sql: 'SELECT value' },
    target: { connectionId: target.id, schema: 'public', table: 'sample' },
  }
  const review = async (changes: Partial<StartDatabaseTransferInput> = {}) => {
    const preview = await service.preview(request)
    return {
      token: preview.token,
      confirm: preview.confirmation,
      mapping: [{ source: 0, target: 'value', type: 'text' }],
      batchSize: 2,
      maxRows: 10000,
      consentBatchCommits: true,
      consentRerun: true,
      ...changes,
    } as StartDatabaseTransferInput
  }
  const finish = async (input: StartDatabaseTransferInput) => {
    const job = await service.start(input)
    await expect.poll(() => service.get(job.id).state).not.toBe('running')
    return service.get(job.id)
  }
  return {
    service,
    source,
    target,
    profiles,
    backend,
    writer,
    request,
    review,
    finish,
    structure,
    rows: (value: Cell[][]) => {
      rows = value
    },
    columns: (value: ResultColumn[]) => {
      columns = value
    },
  }
}
afterEach(() => vi.restoreAllMocks())
describe('transfer orchestration safety (unit checks, separate from real matrix)', () => {
  it('requires exact single-use review consent and rejects changed profiles before opening a writer', async () => {
    const f = fixture(),
      input = await f.review()
    await expect(f.service.start({ ...input, confirm: 'wrong' })).rejects.toThrow(/exact/)
    await expect(f.service.start(input)).rejects.toThrow(/used/)
    const fresh = await f.review()
    f.target.host = 'changed'
    await expect(f.service.start(fresh)).rejects.toThrow(/profile changed/)
    expect(f.writer.writeBatch).not.toHaveBeenCalled()
    await f.service.closeAll()
  })
  it('bounds displayed previews without modifying actual values and keeps distinct duplicate columns', async () => {
    const f = fixture()
    f.rows(Array.from({ length: 100 }, () => ['x'.repeat(1000), '9007199254740993']))
    f.columns([
      { name: 'same', type: 'text' },
      { name: 'same', type: 'int8' },
    ])
    const preview = await f.service.preview(f.request)
    expect(preview.rows).toHaveLength(20)
    expect(preview.rows[0][0]).toHaveLength(512)
    expect(preview.sourceColumns.map((value) => value.name)).toEqual(['same', 'same'])
    const result = await f.finish({
      token: preview.token,
      confirm: preview.confirmation,
      mapping: [{ source: 0, target: 'value', type: 'text' }],
      batchSize: 50,
      maxRows: 51,
      consentBatchCommits: true,
      consentRerun: true,
    })
    expect(result).toMatchObject({ committedRows: 51, limitReached: true, bufferedRows: 0, unwrittenRows: 0 })
    expect(f.writer.writeBatch.mock.calls[0][0][0][0]).toHaveLength(1000)
  })
  it('rejects generated/required/native temporal mappings and mismatched source columns', async () => {
    const f = fixture()
    f.structure.columns = [{ ...column, generated: true }]
    await expect(f.service.start(await f.review())).rejects.toThrow(/Generated/)
    f.structure.columns = [column, { ...column, name: 'required', nullable: false }]
    await expect(f.service.start(await f.review())).rejects.toThrow(/required/)
    f.structure.columns = [{ ...column, type: 'timestamp with time zone' }]
    await expect(f.service.start(await f.review())).rejects.toThrow(/temporal/)
    f.structure.columns = [column]
    const input = await f.review()
    f.columns([{ name: 'changed', type: 'text' }])
    expect(await f.finish(input)).toMatchObject({ state: 'failed', committedRows: 0 })
    expect(f.writer.writeBatch).not.toHaveBeenCalled()
  })
  it('never counts rolled-back or uncertain rows as buffered and never retries a failed batch', async () => {
    for (const outcome of ['rolled-back', 'uncertain'] as const) {
      const f = fixture()
      f.rows([['one'], ['two'], ['three'], ['four'], ['five']])
      f.writer.writeBatch
        .mockImplementationOnce(async () => {})
        .mockImplementationOnce(async (rows) => {
          throw new ImportBatchError('native failure', outcome, rows.length)
        })
      const result = await f.finish(await f.review())
      expect(result).toMatchObject({
        state: 'failed',
        committedRows: 2,
        bufferedRows: 0,
        unwrittenRows: 0,
        [outcome === 'rolled-back' ? 'rolledBackRows' : 'uncertainRows']: 2,
      })
      expect(f.writer.writeBatch).toHaveBeenCalledTimes(2)
      expect(f.writer.close).toHaveBeenCalledOnce()
    }
  })
  it('distinguishes read but unsubmitted rows after source loss from acknowledged rollback', async () => {
    const f = fixture(),
      input = await f.review({ batchSize: 3 })
    f.backend.streamQuery.mockImplementationOnce(async (_input, sink) => {
      await sink.onColumns([{ name: 'value', type: 'text' }])
      await sink.onRow(['pending'])
      throw new Error('connection lost')
    })
    expect(await f.finish(input)).toMatchObject({
      state: 'failed',
      rowsRead: 1,
      unwrittenRows: 1,
      committedRows: 0,
      rolledBackRows: 0,
      uncertainRows: 0,
      bufferedRows: 0,
    })
  })
  it('rejects a profile edited in-place during preview and after opening a writer', async () => {
    const f = fixture(),
      original = f.backend.streamQuery.getMockImplementation()!
    f.backend.streamQuery.mockImplementationOnce(async (input, sink) => {
      await original(input, sink)
      f.target.database = 'changed'
    })
    await expect(f.service.preview(f.request)).rejects.toThrow(/profile changed/)
    const input = await f.review()
    f.backend.openImport.mockImplementationOnce(async () => {
      f.target.database = 'newer'
      return f.writer
    })
    await expect(f.service.start(input)).rejects.toThrow(/connection changed/)
    expect(f.writer.writeBatch).not.toHaveBeenCalled()
    expect(f.writer.close).toHaveBeenCalledOnce()
  })
  it('invalidates a preview when disconnected after its intentional bounded stop', async () => {
    const f = fixture(),
      original = f.backend.streamQuery.getMockImplementation()!
    f.rows(Array.from({ length: 21 }, () => ['bounded']))
    f.backend.streamQuery.mockImplementationOnce(async (input, sink) => {
      try {
        await original(input, sink)
      } finally {
        await f.service.cancelForConnection(f.source.id)
      }
    })
    await expect(f.service.preview(f.request)).rejects.toThrow(/cancelled/)
  })
  it('expires review tokens and rejects unsupported/read-only/same-connection destinations', async () => {
    const f = fixture(),
      input = await f.review(),
      now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 300001)
    await expect(f.service.start(input)).rejects.toThrow(/expired/)
    f.target.readOnly = true
    await expect(f.service.preview(f.request)).rejects.toThrow(/read-only/)
    f.target.readOnly = false
    f.target.engine = 'mariadb'
    await expect(f.service.preview(f.request)).rejects.toThrow(/matrix/)
    await expect(
      f.service.preview({ ...f.request, target: { ...f.request.target, connectionId: f.source.id } }),
    ).rejects.toThrow(/different/)
  })
})
