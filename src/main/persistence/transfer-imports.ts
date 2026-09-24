import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { parse } from 'lossless-json'
import type { Cell, ColumnInfo } from '../../shared/contracts'
import { parameterValue } from '../../shared/parameters'
import {
  importOptionsSchema,
  startImportSchema,
  type ImportOptions,
  type ImportPreview,
  type StartImportInput,
  type ImportJobSnapshot,
} from '../../shared/imports'
import { ImportBatchError, type ImportBackend, type ImportWriter } from './import-writer'
import { IMPORT_ROW_BYTES, parseImport } from './import-parser'

interface Source {
  path: string
  identity: string
  bytes: number
  columns: string[]
  options: ImportOptions
  expires: number
}
interface Job {
  connectionId: string
  snapshot: ImportJobSnapshot
  controller: AbortController
  started: number
  done: Promise<void>
}
export interface ImportHardLimits {
  maxRows: number
  maxBytes: number
  signal?: AbortSignal
}
const warnings = [
  'Each batch commits independently. Cancellation or a later error does not undo earlier committed batches.',
  'Preview validates only a bounded prefix. Database constraints, defaults, triggers, and permissions may reject later rows.',
  'Automatic retry and resume are disabled. Re-importing a file can create duplicate rows; inspect committed and uncertain outcomes first.',
  'Skip invalid skips source width, NULL, and selected type-validation errors only. Syntax, filesystem, and database errors stop the import.',
]
async function identity(file: FileHandle): Promise<{ key: string; bytes: number }> {
  const stat = await file.stat({ bigint: true })
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Choose a regular import file with a supported size.')
  return {
    key: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
    bytes: Number(stat.size),
  }
}
export function convertImportCell(value: Cell, mapping: StartImportInput['mapping'][number], column: ColumnInfo): Cell {
  if (value === null) {
    if (!column.nullable) throw new Error('The destination column does not allow NULL.')
    return null
  }
  if (mapping.type === 'null')
    throw new Error(
      'Select a value type for non-NULL input; NULL conversion never silently discards a value.',
    )
  if (typeof value === 'object') {
    if (mapping.type !== 'binary') throw new Error('A binary source cell requires binary mapping.')
    return value
  }
  let text = String(value)
  if (text.length > 1000000) throw new Error('A field exceeds 1,000,000 characters.')
  if (mapping.type === 'json') {
    try {
      parse(text)
    } catch {
      throw new Error('The field is not valid lossless JSON.')
    }
    return text
  }
  if (mapping.type === 'binary' && text.startsWith('base64:')) text = text.slice(7)
  try {
    const native = parameterValue({ name: 'source field', type: mapping.type, value: text, secret: true })
    return native instanceof Uint8Array
      ? { type: 'binary', base64: Buffer.from(native).toString('base64') }
      : native
  } catch {
    throw new Error(`The field is not a valid ${mapping.type} value.`)
  }
}

/** File grants and imported values stay in main memory only; jobs expose bounded, value-free progress. */
export class ImportService {
  private readonly sources = new Map<string, Source>()
  private readonly jobs = new Map<string, Job>()
  private readonly generations = new Map<string, number>()
  private closed = false
  private starting = 0
  constructor(private readonly backend: ImportBackend) {}

  async previewImport(optionsInput: ImportOptions, path: string): Promise<ImportPreview> {
    if (this.closed) throw new Error('The import service is closing.')
    const options = importOptionsSchema.parse(optionsInput)
    const resolved = await realpath(path)
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const original = await identity(file)
      const columns: string[] = [],
        rows: Cell[][] = [],
        lineNumbers: number[] = []
      const previewWarnings = [...warnings]
      let sampleBytes = 0
      for await (const record of parseImport(file, options, new AbortController().signal, () => undefined)) {
        if ('columns' in record) {
          columns.push(...record.columns)
          continue
        }
        if (record.issue) throw new Error(`Line ${record.line}: ${record.issue}`)
        const cells = record.cells.map((cell): Cell => {
          if (cell && typeof cell === 'object') return { type: 'binary', base64: cell.base64.slice(0, 512) }
          return typeof cell === 'string' && cell.length > 512 ? cell.slice(0, 512) + '…' : cell
        })
        sampleBytes += Buffer.byteLength(JSON.stringify(cells), 'utf8')
        if (sampleBytes > 256 * 1024) break
        rows.push(cells)
        lineNumbers.push(record.line)
        if (rows.length >= 20) break
      }
      if (!rows.length) throw new Error('The source file has no data rows to import.')
      if ((await identity(file)).key !== original.key)
        throw new Error('The source file changed while previewing. Choose it again.')
      previewWarnings.push(
        'Preview contains at most 20 rows / 256 KiB; each displayed field is shortened to 512 characters. The full source value is used at import time.',
      )
      if (options.format === 'jsonl')
        previewWarnings.push(
          'JSONL numeric tokens are preserved as exact text, including nested JSON. Missing object fields become NULL; extra fields are invalid.',
        )
      for (const [id, source] of this.sources) if (source.expires < Date.now()) this.sources.delete(id)
      while (this.sources.size >= 20) this.sources.delete(this.sources.keys().next().value!)
      const sourceId = crypto.randomUUID()
      this.sources.set(sourceId, {
        path: resolved,
        identity: original.key,
        bytes: original.bytes,
        columns,
        options,
        expires: Date.now() + 30 * 60 * 1000,
      })
      return {
        sourceId,
        name: basename(resolved),
        bytes: original.bytes,
        options,
        columns,
        rows,
        lineNumbers,
        warnings: previewWarnings,
      }
    } finally {
      await file.close()
    }
  }

  discardSource(sourceId: string): void {
    this.sources.delete(sourceId)
  }

  async startImport(rawInput: StartImportInput, limits?: ImportHardLimits): Promise<ImportJobSnapshot> {
    if (limits?.signal?.aborted) throw new Error('Import was cancelled before it started.')
    const input = startImportSchema.parse(rawInput)
    if (this.closed) throw new Error('The import service is closing.')
    if (this.starting + [...this.jobs.values()].filter((job) => job.snapshot.state === 'running').length >= 2)
      throw new Error('Two imports are already running. Wait or cancel one before starting another.')
    const source = this.sources.get(input.sourceId)
    if (!source || source.expires < Date.now())
      throw new Error(
        'The source preview expired or was already used. Preview the file again before importing.',
      )
    if (
      input.mapping.some((item) => item.source >= source.columns.length) ||
      new Set(input.mapping.map((item) => item.target)).size !== input.mapping.length
    )
      throw new Error('Map valid source columns to unique destination columns.')
    // A grant is single-use, including failed starts, so a repeated click cannot silently duplicate writes.
    this.sources.delete(input.sourceId)
    this.starting++
    const generation = this.generations.get(input.connectionId) ?? 0
    const controller = new AbortController()
    const cancel = () => controller.abort(limits?.signal?.reason)
    limits?.signal?.addEventListener('abort', cancel, { once: true })
    if (limits?.signal?.aborted) cancel()
    let handedOff = false
    let file: FileHandle | undefined, writer: ImportWriter | undefined
    try {
      file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      if ((await identity(file)).key !== source.identity)
        throw new Error('The source file changed after preview. Preview it again before importing.')
      if (controller.signal.aborted) throw new Error('Import cancelled before opening the destination.')
      writer = await this.backend.openImport(
        { ...input, columns: input.mapping.map((item) => item.target) },
        controller.signal,
      )
      if (controller.signal.aborted) throw new Error('Import cancelled before writing rows.')
      const columnMap = new Map(writer.columns.map((column) => [column.name, column]))
      if (input.mapping.some((item) => !columnMap.has(item.target)))
        throw new Error('A mapped destination column no longer exists. Refresh structure and preview again.')
      if (this.closed || (this.generations.get(input.connectionId) ?? 0) !== generation)
        throw new Error('The connection target changed before import started.')
      for (const [id, job] of this.jobs)
        if (this.jobs.size >= 100 && job.snapshot.state !== 'running') this.jobs.delete(id)
      const id = crypto.randomUUID()
      const job: Job = {
        connectionId: input.connectionId,
        controller,
        started: performance.now(),
        done: Promise.resolve(),
        snapshot: {
          id,
          commitModel: writer.commitModel ?? 'transaction',
          state: 'running',
          rowsRead: 0,
          committedRows: 0,
          rolledBackRows: 0,
          uncertainRows: 0,
          skippedRows: 0,
          committedBatches: 0,
          bytesRead: 0,
          fileBytes: source.bytes,
          lastLine: 0,
          durationMs: 0,
          issues: [],
          warnings:
            writer.commitModel === 'append'
              ? [
                  'Each append is acknowledged separately. Cancellation or failure can leave some or all rows applied; no rollback, retry or resume is available.',
                  ...warnings.slice(1),
                  ...(writer.warnings ?? []),
                ]
              : [...warnings, ...(writer.warnings ?? [])],
        },
      }
      this.jobs.set(id, job)
      handedOff = true
      job.done = this.run(job, input, source, file, writer, columnMap, limits).finally(() => limits?.signal?.removeEventListener('abort', cancel))
      file = undefined
      writer = undefined
      return this.getJob(id)
    } finally {
      if (!handedOff) limits?.signal?.removeEventListener('abort', cancel)
      this.starting--
      if (writer) await writer.close()
      if (file) await file.close()
    }
  }

  getJob(id: string): ImportJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This import job is no longer available.')
    return {
      ...job.snapshot,
      issues: job.snapshot.issues.map((issue) => ({ ...issue })),
      warnings: [...job.snapshot.warnings],
      durationMs:
        job.snapshot.state === 'running'
          ? Math.round(performance.now() - job.started)
          : job.snapshot.durationMs,
    }
  }
  cancelJob(id: string): ImportJobSnapshot {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This import job is no longer available.')
    if (job.snapshot.state === 'running') job.controller.abort()
    return this.getJob(id)
  }
  async cancelForConnection(connectionId: string): Promise<void> {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1)
    const jobs = [...this.jobs.values()].filter((job) => job.connectionId === connectionId)
    for (const job of jobs) if (job.snapshot.state === 'running') job.controller.abort()
    await Promise.allSettled(jobs.map((job) => job.done))
  }
  async closeAll(): Promise<void> {
    this.closed = true
    this.sources.clear()
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
  }

  private async run(
    job: Job,
    input: StartImportInput,
    source: Source,
    file: FileHandle,
    writer: ImportWriter,
    columns: Map<string, ColumnInfo>,
    limits?: ImportHardLimits,
  ): Promise<void> {
    let batch: Cell[][] = [],
      batchBytes = 0
    let terminalState: ImportJobSnapshot['state'] = 'failed'
    const check = async () => {
      if (job.controller.signal.aborted)
        throw new Error('Import cancelled. Earlier acknowledged batches remain committed.')
      if (limits && job.snapshot.bytesRead > limits.maxBytes)
        throw new Error('Import reached its configured byte limit before the next batch was written.')
      if ((await identity(file)).key !== source.identity)
        throw new Error(
          'The source file changed during import. Import stopped; earlier acknowledged batches remain committed. Inspect the destination before retrying.',
        )
    }
    const flush = async () => {
      if (!batch.length) return
      await check()
      if (limits && job.snapshot.committedRows + batch.length > limits.maxRows)
        throw new Error('Import reached its configured row limit before the next batch was written.')
      await writer.writeBatch(batch)
      job.snapshot.committedRows += batch.length
      job.snapshot.committedBatches++
      batch = []
      batchBytes = 0
    }
    try {
      for await (const record of parseImport(file, source.options, job.controller.signal, (bytes) => {
        job.snapshot.bytesRead = bytes
        if (limits && bytes > limits.maxBytes)
          throw new Error('Import reached its configured byte limit before the next batch was written.')
      })) {
        if ('columns' in record) {
          if (JSON.stringify(record.columns) !== JSON.stringify(source.columns))
            throw new Error('The source columns changed after preview.')
          continue
        }
        if (job.controller.signal.aborted)
          throw new Error('Import cancelled. Earlier acknowledged batches remain committed.')
        job.snapshot.rowsRead++
        job.snapshot.lastLine = record.line
        let row: Cell[]
        try {
          if (record.issue) throw new Error(record.issue)
          row = input.mapping.map((mapping) =>
            convertImportCell(record.cells[mapping.source]!, mapping, columns.get(mapping.target)!),
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Source validation failed.'
          if (job.snapshot.issues.length < 20) job.snapshot.issues.push({ line: record.line, message })
          if (input.errorPolicy !== 'skip-invalid') throw new Error(`Line ${record.line}: ${message}`)
          job.snapshot.skippedRows++
          continue
        }
        const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
        if (bytes > IMPORT_ROW_BYTES) throw new Error(`Line ${record.line}: mapped row exceeds 8 MiB.`)
        if (batch.length && batchBytes + bytes > IMPORT_ROW_BYTES) await flush()
        batch.push(row)
        batchBytes += bytes
        if (batch.length >= input.batchSize) await flush()
      }
      await flush()
      await check()
      terminalState = 'completed'
    } catch (error) {
      if (error instanceof ImportBatchError) {
        if (error.outcome === 'rolled-back') job.snapshot.rolledBackRows += error.rows
        else job.snapshot.uncertainRows += error.rows
      }
      terminalState = job.controller.signal.aborted && !job.snapshot.uncertainRows ? 'cancelled' : 'failed'
      job.snapshot.error =
        error instanceof Error
          ? error.message.slice(0, 2000)
          : 'Import failed. Inspect committed and uncertain outcomes before retrying.'
    } finally {
      await writer.close().catch(() => undefined)
      await file.close().catch(() => undefined)
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
      job.snapshot.state = terminalState
    }
  }
}
