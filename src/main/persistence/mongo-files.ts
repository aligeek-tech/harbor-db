import { randomUUID } from 'node:crypto'
import { open, realpath, link, unlink, type FileHandle } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { MongoService } from '../engines/mongo'
import { MongoFileWriteError, type MongoFileSession } from '../engines/mongo-file-session'
import { mongoToolTargetSchema, type MongoToolTarget } from '../../shared/mongo-tools'
import {
  MONGO_FILE_WARNINGS,
  mongoFileConfirmation,
  mongoFileImportSchema,
  mongoFileExportSchema,
  type MongoFilePreview,
  type MongoFileJob,
  type MongoFileImportInput,
  type MongoFileExportInput,
} from '../../shared/mongo-files'

class FileInputError extends Error {}
const stop = (signal: AbortSignal) => {
  if (signal.aborted)
    throw new FileInputError('Job cancelled. Previously acknowledged documents remain committed.')
}
const fingerprint = async (file: FileHandle) => {
  const info = await file.stat({ bigint: true })
  if (!info.isFile()) throw new FileInputError('Choose an ordinary local file.')
  return {
    key: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    bytes: Number(info.size),
  }
}
async function* lines(
  file: FileHandle,
  signal: AbortSignal,
): AsyncGenerator<{ source: string; line: number; bytes: number }> {
  const buffer = Buffer.alloc(65536),
    decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = Buffer.alloc(0),
    position = 0,
    line = 0
  const decode = (value: Buffer) => {
    try {
      return decoder.decode(value)
    } catch {
      throw new FileInputError('The file is not valid UTF-8. No encoding conversion was performed.')
    }
  }
  while (true) {
    stop(signal)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
    position += bytesRead
    if (!bytesRead) break
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
    let newline: number
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > 1000000) throw new FileInputError('A document line exceeds the 1 MB bound.')
      const part = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      line++
      const source = decode(part).replace(/\r$/, '')
      if (!source.trim())
        throw new FileInputError('Blank lines are not documents. Use one Extended JSON document per line.')
      yield { source, line, bytes: newline + 1 }
    }
    if (pending.length > 1000000) throw new FileInputError('A document line exceeds the 1 MB bound.')
  }
  if (pending.length) {
    line++
    const source = decode(pending).replace(/\r$/, '')
    if (!source.trim()) throw new FileInputError('Blank lines are not documents.')
    yield { source, line, bytes: pending.length }
  }
}
interface Preview {
  target: MongoToolTarget
  path: string
  fingerprint: string
  session: MongoFileSession
  expires: number
  generation: number
}
interface Job {
  snapshot: MongoFileJob
  controller: AbortController
  started: number
  done: Promise<void>
  finalizing: boolean
}
function publicError(error: unknown): string {
  if (error instanceof FileInputError || error instanceof MongoFileWriteError) return error.message
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (['ENOSPC', 'EACCES', 'EPERM', 'EEXIST', 'ENOENT'].includes(code))
    return `Local file operation failed (${code}). Existing files were not replaced.`
  return 'MongoDB file job stopped because validation, target identity, permissions, or transport failed. Inspect the target and acknowledged count before starting a new job. No operation was replayed.'
}
export class MongoFileService {
  private previews = new Map<string, Preview>()
  private jobs = new Map<string, Job>()
  private generations = new Map<string, number>()
  private closed = false
  private starting = 0
  constructor(private readonly mongo: Pick<MongoService, 'openFileSession'>) {}
  private available() {
    if (this.closed) throw new FileInputError('MongoDB file jobs are closing.')
    if (this.starting + [...this.jobs.values()].filter((job) => job.snapshot.state === 'running').length >= 2)
      throw new FileInputError('Two MongoDB file jobs are already running.')
  }
  private targetCurrent(target: MongoToolTarget, generation: number) {
    if (this.closed || (this.generations.get(target.connectionId) ?? 0) !== generation)
      throw new FileInputError('The target changed or disconnected. Choose and preview the file again.')
  }
  async previewImport(raw: MongoToolTarget, sourcePath: string): Promise<MongoFilePreview> {
    this.available()
    const target = mongoToolTargetSchema.parse(raw),
      generation = this.generations.get(target.connectionId) ?? 0
    for (const [token, preview] of this.previews)
      if (preview.expires < Date.now()) this.previews.delete(token)
    if (this.previews.size >= 20)
      throw new FileInputError('Close or finish an earlier preview before selecting another file.')
    const session = await this.mongo.openFileSession(target, true),
      path = await realpath(sourcePath),
      file = await open(path, 'r')
    try {
      const before = await fingerprint(file),
        documents: string[] = []
      let bytes = 0,
        previewTruncated = false
      for await (const item of lines(file, new AbortController().signal)) {
        const canonical = session.canonical(item.source)
        if (documents.length >= 20 || bytes + Buffer.byteLength(canonical) > 32768) {
          previewTruncated = true
          break
        }
        documents.push(canonical)
        bytes += Buffer.byteLength(canonical)
      }
      if (!documents.length && !previewTruncated)
        throw new FileInputError('The selected file contains no documents.')
      if ((await fingerprint(file)).key !== before.key)
        throw new FileInputError('The file changed during preview. Choose it again.')
      this.targetCurrent(target, generation)
      const token = randomUUID(),
        expires = Date.now() + 600000
      if (this.previews.size >= 20)
        throw new FileInputError('Close or finish an earlier preview before selecting another file.')
      this.previews.set(token, { target, path, fingerprint: before.key, session, expires, generation })
      return {
        token,
        target,
        name: basename(path),
        bytes: before.bytes,
        documents,
        previewTruncated,
        confirmation: mongoFileConfirmation(target),
        expiresAt: new Date(expires).toISOString(),
        warnings: [...MONGO_FILE_WARNINGS],
      }
    } finally {
      await file.close()
    }
  }
  private job(kind: 'import' | 'export', target: MongoToolTarget): Job {
    for (const [id, value] of this.jobs)
      if (this.jobs.size >= 100 && value.snapshot.state !== 'running') this.jobs.delete(id)
    const job: Job = {
      snapshot: {
        id: randomUUID(),
        kind,
        target,
        state: 'running',
        documentsRead: 0,
        acknowledgedDocuments: 0,
        uncertainDocuments: 0,
        bytes: 0,
        lastLine: 0,
        limited: false,
        durationMs: 0,
        warnings:
          kind === 'import'
            ? [...MONGO_FILE_WARNINGS]
            : [
                'A fresh cursor reruns the reviewed read query. This is not a database snapshot or backup; concurrent writes may change the observed data. The explicit document cap is reported separately from full completion.',
              ],
      },
      controller: new AbortController(),
      started: performance.now(),
      done: Promise.resolve(),
      finalizing: false,
    }
    this.jobs.set(job.snapshot.id, job)
    return job
  }
  async startImport(raw: MongoFileImportInput): Promise<MongoFileJob> {
    this.available()
    const input = mongoFileImportSchema.parse(raw),
      preview = this.previews.get(input.token)
    if (!preview || preview.expires < Date.now())
      throw new FileInputError('The file preview expired. Choose it again.')
    if (input.confirm !== mongoFileConfirmation(preview.target))
      throw new FileInputError('Type the exact import target before inserting documents.')
    this.previews.delete(input.token)
    this.starting++
    let file: FileHandle | undefined
    try {
      this.targetCurrent(preview.target, preview.generation)
      await preview.session.validate()
      file = await open(preview.path, 'r')
      if ((await fingerprint(file)).key !== preview.fingerprint)
        throw new FileInputError('The selected file changed. Choose and preview it again.')
      this.targetCurrent(preview.target, preview.generation)
      const job = this.job('import', preview.target)
      job.done = this.runImport(job, input, preview, file)
      file = undefined
      return this.getJob(job.snapshot.id)
    } finally {
      this.starting--
      await file?.close()
    }
  }
  private async runImport(job: Job, input: MongoFileImportInput, preview: Preview, file: FileHandle) {
    try {
      for await (const item of lines(file, job.controller.signal)) {
        if (job.snapshot.documentsRead >= input.maxDocuments) {
          job.snapshot.limited = true
          break
        }
        job.snapshot.lastLine = item.line
        const canonical = preview.session.canonical(item.source)
        job.snapshot.documentsRead++
        job.snapshot.bytes += item.bytes
        if ((job.snapshot.documentsRead - 1) % 50 === 0) {
          if ((await fingerprint(file)).key !== preview.fingerprint)
            throw new FileInputError(
              'The source file changed during import. Prior acknowledgments remain committed.',
            )
          await preview.session.validate()
        }
        stop(job.controller.signal)
        try {
          await preview.session.insert(canonical, job.controller.signal)
        } catch (error) {
          if (error instanceof MongoFileWriteError && error.uncertain) job.snapshot.uncertainDocuments++
          throw error
        }
        job.snapshot.acknowledgedDocuments++
      }
      if ((await fingerprint(file)).key !== preview.fingerprint)
        throw new FileInputError('The source file changed during import. Review the acknowledged writes.')
      stop(job.controller.signal)
      job.snapshot.state = 'completed'
    } catch (error) {
      this.fail(job, error)
    } finally {
      await file.close().catch((error: unknown) => {
        if (job.snapshot.state === 'completed') this.fail(job, error)
      })
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
    }
  }
  async startExport(raw: MongoFileExportInput, destination: string): Promise<MongoFileJob> {
    this.available()
    const input = mongoFileExportSchema.parse(raw),
      target = mongoToolTargetSchema.parse({
        connectionId: input.connectionId,
        database: input.database,
        collection: input.collection,
      })
    const generation = this.generations.get(target.connectionId) ?? 0
    this.starting++
    let file: FileHandle | undefined, partialPath: string | undefined
    try {
      const session = await this.mongo.openFileSession(target, false),
        outputPath = resolve(destination)
      // Exclusive final link below protects a destination created concurrently.
      try {
        const existing = await open(outputPath, 'r')
        await existing.close()
        throw new FileInputError('The destination exists. Choose a new filename.')
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      }
      partialPath = outputPath + '.harbor-' + randomUUID() + '.partial'
      file = await open(partialPath, 'wx', 0o600)
      this.targetCurrent(target, generation)
      const job = this.job('export', target)
      job.snapshot.partialPath = partialPath
      job.done = this.runExport(job, input, session, file, partialPath, outputPath)
      file = undefined
      partialPath = undefined
      return this.getJob(job.snapshot.id)
    } finally {
      this.starting--
      await file?.close()
      if (partialPath) await unlink(partialPath).catch(() => {})
    }
  }
  private async runExport(
    job: Job,
    input: MongoFileExportInput,
    session: MongoFileSession,
    file: FileHandle,
    partialPath: string,
    outputPath: string,
  ) {
    let closed = false
    try {
      job.snapshot.limited = await session.stream(input, job.controller.signal, async (source) => {
        stop(job.controller.signal)
        const value = Buffer.from(source + '\n')
        let offset = 0
        while (offset < value.length) {
          stop(job.controller.signal)
          const wrote = await file.write(value, offset, value.length - offset)
          if (!wrote.bytesWritten) throw new FileInputError('The output file stopped accepting data.')
          offset += wrote.bytesWritten
          job.snapshot.bytes += wrote.bytesWritten
        }
        job.snapshot.documentsRead++
      })
      stop(job.controller.signal)
      await file.sync()
      await file.close()
      closed = true
      stop(job.controller.signal)
      job.finalizing = true
      await link(partialPath, outputPath)
      job.snapshot.outputPath = outputPath
      job.snapshot.state = 'completed'
      try {
        await unlink(partialPath)
        delete job.snapshot.partialPath
      } catch {
        job.snapshot.warnings.push(
          'Export completed. The redundant partial file could not be removed; its path is shown for manual cleanup.',
        )
      }
    } catch (error) {
      this.fail(job, error)
    } finally {
      if (!closed) await file.close().catch(() => {})
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
    }
  }
  private fail(job: Job, error: unknown) {
    job.snapshot.state =
      job.controller.signal.aborted && !job.snapshot.uncertainDocuments ? 'cancelled' : 'failed'
    job.snapshot.error = publicError(error)
  }
  getJob(id: string): MongoFileJob {
    const job = this.jobs.get(id)
    if (!job) throw new FileInputError('This MongoDB file job is no longer available.')
    return structuredClone({
      ...job.snapshot,
      durationMs:
        job.snapshot.state === 'running'
          ? Math.round(performance.now() - job.started)
          : job.snapshot.durationMs,
    })
  }
  async cancelJob(id: string): Promise<MongoFileJob> {
    const job = this.jobs.get(id)
    if (!job) throw new FileInputError('This MongoDB file job is no longer available.')
    if (!job.finalizing) job.controller.abort()
    await job.done
    return this.getJob(id)
  }
  async cancelForConnection(connectionId: string): Promise<void> {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1)
    for (const [id, preview] of this.previews)
      if (preview.target.connectionId === connectionId) this.previews.delete(id)
    const jobs = [...this.jobs.values()].filter((job) => job.snapshot.target.connectionId === connectionId)
    for (const job of jobs) if (!job.finalizing) job.controller.abort()
    await Promise.allSettled(jobs.map((job) => job.done))
  }
  async closeAll(): Promise<void> {
    this.closed = true
    this.previews.clear()
    for (const job of this.jobs.values()) if (!job.finalizing) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
  }
}
