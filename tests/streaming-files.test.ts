import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { TransferService, type FullExportInput } from '../src/main/persistence/transfers'
import { parseCsv } from '../src/shared/csv'

const input: FullExportInput = {
  connectionId: 'unused',
  sql: 'SELECT 1',
  format: 'jsonl',
  spreadsheetSafe: true,
  consentRerun: true,
}

describe('streaming export file safety', () => {
  it('distinguishes literal NULL tokens, empty text, NULL and spreadsheet formulas in CSV', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-csv-'))
    const transfers = new TransferService({
      streamQuery: async (_input, sink) => {
        await sink.onColumns([{ name: 'value', type: 'text' }])
        for (const value of [null, '', '\\N', '=1+1']) await sink.onRow([value])
      },
    })
    try {
      const path = join(directory, 'tokens.csv')
      const job = await transfers.startExport({ ...input, format: 'csv' }, path)
      while (transfers.getJob(job.id).state === 'running')
        await new Promise((resolve) => setTimeout(resolve, 2))
      expect(transfers.getJob(job.id).state).toBe('completed')
      expect(parseCsv(await readFile(path, 'utf8')).rows).toEqual([[null], [''], ['\\N'], ["'=1+1"]])
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('invalidates an export still creating its file when the connection target changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-generation-'))
    let called = false
    const transfers = new TransferService({
      streamQuery: async () => {
        called = true
      },
    })
    try {
      const started = transfers.startExport(input, join(directory, 'changed.jsonl'))
      await transfers.cancelForConnection(input.connectionId)
      await expect(started).rejects.toThrow('target changed')
      expect(called).toBe(false)
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('requires explicit consent and never replaces an existing destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-files-'))
    const transfers = new TransferService({
      streamQuery: async () => {
        throw new Error('Should not execute')
      },
    })
    try {
      const path = join(directory, 'existing.csv')
      await writeFile(path, 'original user data')
      await expect(transfers.startExport(input, path)).rejects.toThrow('already exists')
      await expect(
        transfers.startExport(
          { ...input, consentRerun: false } as unknown as FullExportInput,
          join(directory, 'new.csv'),
        ),
      ).rejects.toThrow('Confirm')
      expect(await readFile(path, 'utf8')).toBe('original user data')
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reserves concurrency slots before asynchronous file creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-slots-'))
    const transfers = new TransferService({
      streamQuery: async (_input, sink) => {
        await new Promise<void>((resolve) =>
          sink.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      },
    })
    try {
      const first = transfers.startExport(input, join(directory, 'first.jsonl'))
      const second = transfers.startExport(input, join(directory, 'second.jsonl'))
      await expect(transfers.startExport(input, join(directory, 'third.jsonl'))).rejects.toThrow(
        'Two transfers',
      )
      await Promise.all([first, second])
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces internal automation row limits before writing or publishing the next record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-hard-limit-'))
    const transfers = new TransferService({
      streamQuery: async (_input, sink) => {
        await sink.onColumns([{ name: 'value', type: 'text' }])
        for (const value of ['first', 'second', 'third']) await sink.onRow([value])
      },
    })
    try {
      const path = join(directory, 'bounded.jsonl')
      const started = await transfers.startExport(input, path, { maxRows: 1, maxBytes: 4096 })
      while (transfers.getJob(started.id).state === 'running')
        await new Promise((resolve) => setTimeout(resolve, 2))
      const result = transfers.getJob(started.id)
      expect(result).toMatchObject({ state: 'failed', rows: 1 })
      expect(result.error).toContain('row limit')
      await expect(stat(path)).rejects.toThrow()
      expect(await readFile(result.partialPath!, 'utf8')).toContain('first')
      expect(await readFile(result.partialPath!, 'utf8')).not.toContain('second')
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces internal automation byte limits before the first oversized write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-export-byte-limit-'))
    const transfers = new TransferService({
      streamQuery: async (_input, sink) => {
        await sink.onColumns([{ name: 'very-long-column-name', type: 'text' }])
        await sink.onRow(['must-not-be-written'])
      },
    })
    try {
      const path = join(directory, 'bounded.jsonl')
      const started = await transfers.startExport(input, path, { maxRows: 10, maxBytes: 8 })
      while (transfers.getJob(started.id).state === 'running')
        await new Promise((resolve) => setTimeout(resolve, 2))
      const result = transfers.getJob(started.id)
      expect(result).toMatchObject({ state: 'failed', rows: 0, bytes: 0 })
      expect(result.error).toContain('byte limit')
      await expect(stat(path)).rejects.toThrow()
    } finally {
      await transfers.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'reports a real kernel file-size failure and preserves accurate partial bytes',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'harbor-export-filelimit-'))
      try {
        const script = join(directory, 'native-file-limit.cjs')
        await build({
          stdin: {
            contents: `
        import { TransferService } from ${JSON.stringify(resolve('src/main/persistence/transfers.ts'))};
        const transfer = new TransferService({ streamQuery: async (_input, sink) => {
          await sink.onColumns([{name:'value',type:'text'}]);
          for(let index=0;index<100;index++) await sink.onRow(['x'.repeat(16384)]);
        }});
        (async()=>{
          const job=await transfer.startExport(${JSON.stringify(input)},${JSON.stringify(join(directory, 'output.jsonl'))});
          let state=job;
          while(state.state==='running'){ await new Promise(resolve=>setTimeout(resolve,2)); state=transfer.getJob(job.id); }
          process.stdout.write(JSON.stringify(state)); await transfer.closeAll();
        })().catch(error=>{process.stderr.write(error.message);process.exitCode=1});
      `,
            resolveDir: process.cwd(),
            loader: 'ts',
          },
          bundle: true,
          platform: 'node',
          packages: 'external',
          format: 'cjs',
          outfile: script,
          logLevel: 'silent',
        })
        // Limit only this disposable subprocess's writes; no disk filling or host settings.
        const child = spawnSync(
          'python3',
          [
            '-c',
            'import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536)); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.argv[1],sys.argv[1:])',
            process.execPath,
            script,
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, NODE_PATH: resolve('node_modules') },
          },
        )
        expect(child.status, child.stderr).toBe(0)
        const result = JSON.parse(child.stdout)
        expect(result.state).toBe('failed')
        expect(result.error).toMatch(/EFBIG|file too large/i)
        expect(result.rows).toBeGreaterThan(0)
        expect(result.bytes).toBe(65536)
        expect(result.bytes).toBe((await stat(result.partialPath)).size)
        await expect(stat(join(directory, 'output.jsonl'))).rejects.toThrow()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    20000,
  )
  it('does not submit an export cancelled while its output file is opening', async () => {
    const directory=await mkdtemp(join(tmpdir(),'harbor-export-parent-'))
    let queried=false
    const service=new TransferService({streamQuery:async()=>{queried=true}})
    const parent=new AbortController()
    try {
      const started=service.startExport(input,join(directory,'out.jsonl'),{maxRows:1,maxBytes:4096,signal:parent.signal})
      parent.abort()
      await expect(started).rejects.toThrow('before export started')
      expect(queried).toBe(false)
    } finally {await service.closeAll();await rm(directory,{recursive:true,force:true})}
  })

})
