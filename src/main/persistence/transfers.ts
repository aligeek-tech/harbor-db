import { constants } from 'node:fs'
import { access, link, open, unlink, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EXPORT_CONSISTENCY, type SqlService, type StreamQueryInput } from '../engines/sql'
import type { Cell, ResultColumn } from '../../shared/contracts'

export interface FullExportInput extends StreamQueryInput {
  format: 'csv' | 'jsonl'
  spreadsheetSafe: boolean
  consentRerun: true
}
export interface ExportJobSnapshot {
  id: string
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  rows: number
  bytes: number
  durationMs: number
  consistency: string
  error?: string
  partialPath?: string
  outputPath?: string
}
export interface ExportHardLimits {
  maxRows: number
  maxBytes: number
  signal?: AbortSignal
}
interface ExportJob {
  connectionId: string
  snapshot: ExportJobSnapshot
  started: number
  controller: AbortController
  done: Promise<void>
  finalizing: boolean
}

function csv(value: Cell, spreadsheetSafe: boolean): string {
  if (value === null) return '\\N'
  let text = typeof value === 'object' ? 'base64:' + value.base64 : String(value)
  if (spreadsheetSafe && /^[=+@\-\t\r]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}

/** Main-only transfer jobs. Only bounded progress snapshots cross the renderer IPC boundary. */
export class TransferService {
  private readonly jobs = new Map<string, ExportJob>()
  private closed = false
  private starting = 0
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly sql: Pick<SqlService, 'streamQuery'> & {
      exportConsistency?: (input: StreamQueryInput) => string
    },
  ) {}

  async startExport(
    input: FullExportInput,
    outputPath: string,
    limits?: ExportHardLimits,
  ): Promise<ExportJobSnapshot> {
    if (limits?.signal?.aborted) throw new Error('Export was cancelled before it started.')
    if (this.closed) throw new Error('The transfer service is closing.')
    if (this.starting + [...this.jobs.values()].filter((job) => job.snapshot.state === 'running').length >= 2)
      throw new Error('Two transfers are already running. Wait or cancel one before starting another.')
    this.starting++
    try {
      return await this.beginExport(input, outputPath, this.generations.get(input.connectionId) ?? 0, limits)
    } finally {
      this.starting--
    }
  }

  private async beginExport(
    input: FullExportInput,
    outputPath: string,
    generation: number,
    limits?: ExportHardLimits,
  ): Promise<ExportJobSnapshot> {
    if (input.consentRerun !== true)
      throw new Error('Confirm that the read-only statement may run again for a full export.')
    if (!['csv', 'jsonl'].includes(input.format)) throw new Error('Choose CSV or JSONL for a full export.')
    if (!outputPath || outputPath.includes('\0')) throw new Error('Choose a valid new output path.')
    const consistency = this.sql.exportConsistency?.(input) ?? EXPORT_CONSISTENCY
    const path = resolve(outputPath)
    try {
      await access(path, constants.F_OK)
      throw new Error(
        'The export destination already exists. Choose a new filename; existing files are never replaced.',
      )
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const id = crypto.randomUUID()
    const partialPath = `${path}.harbor-${id}.partial`
    const file = await open(partialPath, 'wx', 0o600)
    if (limits?.signal?.aborted || this.closed || (this.generations.get(input.connectionId) ?? 0) !== generation) {
      await file.close()
      await unlink(partialPath)
      throw new Error('The connection target changed or the transfer service closed before export started.')
    }
    for (const [key, value] of this.jobs) {
      if (this.jobs.size < 100) break
      if (value.snapshot.state !== 'running') this.jobs.delete(key)
    }
    const job: ExportJob = {
      connectionId: input.connectionId,
      snapshot: {
        id,
        state: 'running',
        rows: 0,
        bytes: 0,
        durationMs: 0,
        consistency,
        partialPath,
      },
      started: performance.now(),
      controller: new AbortController(),
      done: Promise.resolve(),
      finalizing: false,
    }
    const cancel = () => { if (!job.finalizing) job.controller.abort(limits?.signal?.reason) }
    limits?.signal?.addEventListener('abort', cancel, { once: true })
    if (limits?.signal?.aborted) cancel()
    this.jobs.set(id, job)
    job.done = this.run(job, input, path, partialPath, file, limits).finally(() => limits?.signal?.removeEventListener('abort', cancel))
    return this.getJob(id)
  }

  getJob(id: string): ExportJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This transfer job is no longer available.')
    return {
      ...job.snapshot,
      durationMs:
        job.snapshot.state === 'running'
          ? Math.round(performance.now() - job.started)
          : job.snapshot.durationMs,
    }
  }

  cancelJob(id: string): ExportJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This transfer job is no longer available.')
    // Finalization is a short atomic commit point. Never mark a published file cancelled.
    if (job.snapshot.state === 'running' && !job.finalizing) job.controller.abort()
    return this.getJob(id)
  }

  async closeAll(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.values()) if (!job.finalizing) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
  }

  async cancelForConnection(connectionId: string): Promise<void> {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1)
    const jobs = [...this.jobs.values()].filter((job) => job.connectionId === connectionId)
    for (const job of jobs) if (!job.finalizing) job.controller.abort()
    await Promise.allSettled(jobs.map((job) => job.done))
  }

  private async run(
    job: ExportJob,
    input: FullExportInput,
    outputPath: string,
    partialPath: string,
    file: FileHandle,
    limits?: ExportHardLimits,
  ): Promise<void> {
    let closed = false
    const check = () => {
      if (job.controller.signal.aborted)
        throw new Error('Export cancelled. Partial output was not finalized.')
    }
    const write = async (text: string) => {
      check()
      // Await each filesystem write: at most one serialized row is queued to disk.
      const bytes = Buffer.from(text, 'utf8')
      if (limits && job.snapshot.bytes + bytes.length > limits.maxBytes)
        throw new Error('Export reached its configured byte limit before writing the next record.')
      let offset = 0
      while (offset < bytes.length) {
        check()
        const result = await file.write(bytes, offset, bytes.length - offset)
        if (!result.bytesWritten) throw new Error('The export file stopped accepting data.')
        offset += result.bytesWritten
        job.snapshot.bytes += result.bytesWritten
      }
    }
    try {
      await this.sql.streamQuery(input, {
        signal: job.controller.signal,
        onColumns: async (columns: ResultColumn[]) => {
          if (input.format === 'jsonl') {
            // One metadata object, then ordered row arrays. Duplicate column names and Cell types survive.
            await write(
              JSON.stringify({
                format: 'harbor-db-jsonl',
                version: 1,
                consistency: job.snapshot.consistency,
                columns,
              }) + '\n',
            )
          } else
            await write(columns.map((column) => csv(column.name, input.spreadsheetSafe)).join(',') + '\r\n')
        },
        onRow: async (row: Cell[]) => {
          if (limits && job.snapshot.rows + 1 > limits.maxRows)
            throw new Error('Export reached its configured row limit before writing the next record.')
          await write(
            input.format === 'jsonl'
              ? JSON.stringify(row) + '\n'
              : row.map((value) => csv(value, input.spreadsheetSafe)).join(',') + '\r\n',
          )
          job.snapshot.rows++
        },
      })
      check()
      await file.sync()
      await file.close()
      closed = true
      check()
      job.finalizing = true
      // Same-directory hard link is atomic and fails if another process created the destination.
      await link(partialPath, outputPath)
      job.snapshot.outputPath = outputPath
      try {
        await unlink(partialPath)
        delete job.snapshot.partialPath
      } catch {
        job.snapshot.error = 'Export completed, but its temporary hard link could not be removed.'
      }
      job.snapshot.state = 'completed'
    } catch (error) {
      job.snapshot.state = job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.snapshot.error =
        error instanceof Error
          ? error.message.slice(0, 2000)
          : 'Export failed. Partial output was not finalized.'
    } finally {
      if (!closed) await file.close().catch(() => undefined)
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
    }
  }
}
