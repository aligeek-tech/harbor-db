import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImportService } from '../src/main/persistence/transfer-imports'
import { importOptionsSchema, type StartImportInput } from '../src/shared/imports'
import type { Cell, ColumnInfo } from '../src/shared/contracts'
import type { ImportBackend } from '../src/main/persistence/import-writer'

const columns: ColumnInfo[] = [
  { name: 'id', type: 'integer', nullable: false, defaultValue: null, primaryKey: true },
]
const input = (sourceId: string): StartImportInput => ({
  connectionId: 'local',
  database: 'disposable',
  schema: 'public',
  table: 'test',
  sourceId,
  mapping: [{ source: 0, target: 'id', type: 'integer' }],
  batchSize: 2,
  errorPolicy: 'stop',
  consentBatchCommits: true,
})
const options = importOptionsSchema.parse({ format: 'csv' })
async function finished(imports: ImportService, id: string) {
  for (let index = 0; index < 1000; index++) {
    const job = imports.getJob(id)
    if (job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Import unit job did not finish.')
}
describe('main import source grants and bounded jobs', () => {
  let directory = ''
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-import-jobs-'))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  async function source(text = 'id\n1\n2\n3\n4\n') {
    const path = join(directory, crypto.randomUUID() + '.csv')
    await writeFile(path, text)
    return path
  }
  function backend(write: (rows: Cell[][]) => Promise<void> = async () => undefined): ImportBackend {
    return { openImport: async () => ({ columns, writeBatch: write, close: async () => undefined }) }
  }

  it('does not allow silent consent omission, invalid mappings, or reused file grants', async () => {
    const imports = new ImportService(backend())
    try {
      const preview = await imports.previewImport(options, await source())
      await expect(
        imports.startImport({ ...input(preview.sourceId), consentBatchCommits: false as unknown as true }),
      ).rejects.toThrow()
      await expect(
        imports.startImport({
          ...input(preview.sourceId),
          mapping: [{ source: 100, target: 'id', type: 'integer' }],
        }),
      ).rejects.toThrow('Map valid')
      const job = await imports.startImport(input(preview.sourceId))
      expect((await finished(imports, job.id)).committedRows).toBe(4)
      await expect(imports.startImport(input(preview.sourceId))).rejects.toThrow('already used')
    } finally {
      await imports.closeAll()
    }
  })

  it('pins the open inode when a pathname is replaced during import', async () => {
    const path = await source(),
      replacement = await source('id\n999\n')
    const rows: Cell[][] = []
    const imports = new ImportService(
      backend(async (batch) => {
        rows.push(...batch)
        if (rows.length === 2) await rename(replacement, path)
      }),
    )
    try {
      const preview = await imports.previewImport(options, path)
      const done = await finished(imports, (await imports.startImport(input(preview.sourceId))).id)
      // Rename changes the pinned inode's ctime on some filesystems; either
      // continuing the original inode or stopping on identity change is safe.
      expect(['completed', 'failed']).toContain(done.state)
      expect(rows.flat()).not.toContain('999')
      expect(done.committedRows).toBeGreaterThanOrEqual(2)
    } finally {
      await imports.closeAll()
    }
  })

  it('detects in-place file changes before writing another batch and preserves exact earlier progress', async () => {
    const path = await source()
    let writes = 0
    const imports = new ImportService(
      backend(async () => {
        if (++writes === 1) await appendFile(path, '5\n')
      }),
    )
    try {
      const preview = await imports.previewImport(options, path)
      const done = await finished(imports, (await imports.startImport(input(preview.sourceId))).id)
      expect(done.state).toBe('failed')
      expect(done.error).toContain('changed during import')
      expect(done.committedRows).toBe(2)
      expect(done.uncertainRows).toBe(0)
      expect(writes).toBe(1)
    } finally {
      await imports.closeAll()
    }
  })

  it('stops on invalid encoding after preview instead of replacing bytes or marking completion', async () => {
    const path = await source(
      'id\n' + Array.from({ length: 30000 }, (_item, index) => `${index + 1}\n`).join(''),
    )
    await appendFile(path, Buffer.from([0xff, 0x0a]))
    const imports = new ImportService(backend())
    try {
      const preview = await imports.previewImport(options, path)
      expect(preview.rows).toHaveLength(20)
      const done = await finished(
        imports,
        (await imports.startImport({ ...input(preview.sourceId), batchSize: 500 })).id,
      )
      expect(done.state).toBe('failed')
      expect(done.error).toContain('invalid bytes')
      expect(done.committedRows).toBeGreaterThan(0)
    } finally {
      await imports.closeAll()
    }
  })

  it('invalidates a pending target before any batch begins', async () => {
    let release!: () => void,
      opening!: () => void,
      writes = 0,
      closes = 0
    const entered = new Promise<void>((resolve) => {
      opening = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const imports = new ImportService({
      openImport: async () => {
        opening()
        await gate
        return {
          columns,
          writeBatch: async () => {
            writes++
          },
          close: async () => {
            closes++
          },
        }
      },
    })
    try {
      const preview = await imports.previewImport(options, await source())
      const starting = imports.startImport(input(preview.sourceId))
      const rejection = expect(starting).rejects.toThrow('target changed')
      await entered
      await imports.cancelForConnection('local')
      release()
      await rejection
      expect(writes).toBe(0)
      expect(closes).toBe(1)
    } finally {
      release()
      await imports.closeAll()
    }
  })

  it('enforces internal automation row limits before acknowledging a batch', async () => {
    const written: Cell[][] = []
    const imports = new ImportService(backend(async (batch) => { written.push(...batch) }))
    try {
      const preview = await imports.previewImport(options, await source())
      const started = await imports.startImport(input(preview.sourceId), { maxRows: 1, maxBytes: 4096 })
      const done = await finished(imports, started.id)
      expect(done).toMatchObject({ state: 'failed', committedRows: 0, committedBatches: 0 })
      expect(done.error).toContain('row limit')
      expect(written).toHaveLength(0)
    } finally {
      await imports.closeAll()
    }
  })

  it('enforces internal automation source-byte limits before writing rows', async () => {
    const written: Cell[][] = []
    const imports = new ImportService(backend(async (batch) => { written.push(...batch) }))
    try {
      const preview = await imports.previewImport(options, await source())
      const started = await imports.startImport(input(preview.sourceId), { maxRows: 100, maxBytes: 4 })
      const done = await finished(imports, started.id)
      expect(done).toMatchObject({ state: 'failed', committedRows: 0, committedBatches: 0 })
      expect(done.error).toContain('byte limit')
      expect(written).toHaveLength(0)
    } finally {
      await imports.closeAll()
    }
  })
})
