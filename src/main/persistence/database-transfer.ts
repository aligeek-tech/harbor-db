import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type {
  Cell,
  ColumnInfo,
  ConnectionProfile,
  ResultColumn,
  TableStructure,
} from '../../shared/contracts'
import {
  DATABASE_TRANSFER_ENGINES,
  previewDatabaseTransferSchema,
  startDatabaseTransferSchema,
  type DatabaseTransferPreview,
  type DatabaseTransferJob,
  type PreviewDatabaseTransferInput,
  type StartDatabaseTransferInput,
} from '../../shared/database-transfer'
import { exportConsistency } from '../../shared/transfers'
import { importTargetConfirmation } from '../../shared/imports'
import type { QueryStreamSink, StreamQueryInput } from '../engines/adapter'
import { ImportBatchError, type ImportBackend, type ImportWriter } from './import-writer'
import { convertImportCell } from './transfer-imports'

interface Context extends ImportBackend {
  profile(id: string): ConnectionProfile
  structure(target: PreviewDatabaseTransferInput['target']): Promise<TableStructure>
  streamQuery(input: StreamQueryInput, sink: QueryStreamSink): Promise<void>
}
interface Preview {
  input: PreviewDatabaseTransferInput
  sourceProfile: string
  targetProfile: string
  structure: string
  columns: ResultColumn[]
  response: DatabaseTransferPreview
  expires: number
}
interface Job {
  snapshot: DatabaseTransferJob
  sourceId: string
  targetId: string
  reader: AbortController
  writer: AbortController
  done: Promise<void>
  started: number
}
const boundedStop = new Error('The explicit source scope was reached.')
const warnings = [
  'Preview reads a bounded prefix; starting the transfer reruns the read-only source in a fresh snapshot. It excludes source tab changes that have not been committed.',
  'Destination batches commit independently. Later failure or cancellation cannot undo earlier committed batches. There is no cross-database transaction.',
  'Only explicitly mapped columns are inserted. Omitted columns use destination defaults; generated columns cannot be assigned. Existing rows are never updated or deleted.',
  'Destination triggers and constraints still apply. Preview cannot validate every row. Conflicts stop the transfer; there is no skip, retry, resume, or implicit key remapping.',
  'Values use the selected conversion. Integer and decimal values stay exact; binary mapping preserves bytes. Transfer temporal values to TEXT; native temporal destinations are outside this matrix because precision and time-zone semantics differ.',
]
export class DatabaseTransferService {
  private previews = new Map<string, Preview>()
  private jobs = new Map<string, Job>()
  private generations = new Map<string, number>()
  private closed = false
  private starting = 0
  private reading = new Map<AbortController, string[]>()
  constructor(private context: Context) {}
  private profiles(input: PreviewDatabaseTransferInput): [ConnectionProfile, ConnectionProfile] {
    const source = this.context.profile(input.source.connectionId),
      target = this.context.profile(input.target.connectionId)
    if (![source, target].every((profile) => DATABASE_TRANSFER_ENGINES.includes(profile.engine)))
      throw new Error(
        'The current transfer matrix supports PostgreSQL, SQLite and DuckDB sources and destinations.',
      )
    if (source.id === target.id)
      throw new Error(
        'Choose a different destination connection. Transfer never writes through the source session.',
      )
    if (target.readOnly)
      throw new Error(
        'The destination profile is read-only. Enable writes explicitly before preparing a transfer.',
      )
    return [source, target]
  }
  async preview(raw: PreviewDatabaseTransferInput): Promise<DatabaseTransferPreview> {
    if (this.closed) throw new Error('The transfer service is closing.')
    if (this.reading.size >= 2) throw new Error('Two transfer previews are already running.')
    const input = previewDatabaseTransferSchema.parse(raw),
      [source, target] = this.profiles(input)
    const identities = [JSON.stringify(source), JSON.stringify(target)]
    const generations = [source.id, target.id].map((id) => this.generations.get(id) ?? 0)
    const controller = new AbortController()
    this.reading.set(controller, [source.id, target.id])
    try {
      const file = (profile: ConnectionProfile) =>
        profile.engine === 'sqlite'
          ? profile.sqlite.path
          : profile.engine === 'duckdb' && profile.duckdb.mode !== 'memory'
            ? profile.duckdb.path
            : undefined
      if (file(source) && file(target)) {
        const paths = await Promise.all([realpath(file(source)!), realpath(file(target)!)])
        const identities = await Promise.all(paths.map((path) => stat(path)))
        if (
          paths[0] === paths[1] ||
          (identities[0].dev === identities[1].dev && identities[0].ino === identities[1].ino)
        )
          throw new Error(
            'The source and destination resolve to the same local database file. Choose a separate database.',
          )
      }
      const structure = await this.context.structure(input.target),
        rows: Cell[][] = []
      if (target.engine === 'duckdb' && /\bGENERATED\b/i.test(structure.ddl))
        throw new Error(
          'DuckDB tables with generated columns are outside the current transfer destination matrix; choose a table with explicit stored columns.',
        )
      let columns: ResultColumn[] = [],
        sampleBytes = 0,
        scoped = false
      try {
        await this.context.streamQuery(input.source, {
          signal: controller.signal,
          onColumns: async (value) => {
            if (!value.length || value.length > 200)
              throw new Error('Transfer supports 1–200 source columns.')
            columns = value
          },
          onRow: async (row) => {
            if (rows.length >= 20 || sampleBytes >= 256 * 1024) {
              scoped = true
              controller.abort()
              throw boundedStop
            }
            const display = row.map((cell) =>
              typeof cell === 'string'
                ? cell.slice(0, 512)
                : cell && typeof cell === 'object'
                  ? { type: 'binary' as const, base64: cell.base64.slice(0, 512) }
                  : cell,
            )
            const bytes = Buffer.byteLength(JSON.stringify(display))
            if (sampleBytes + bytes > 256 * 1024) {
              scoped = true
              controller.abort()
              throw boundedStop
            }
            sampleBytes += bytes
            rows.push(display)
          },
        })
      } catch (error) {
        if (!scoped) throw error
      }
      if (!columns.length) throw new Error('The source statement did not return a tabular result.')
      if (
        this.closed ||
        (controller.signal.aborted && !scoped) ||
        [source.id, target.id].some((id, index) => (this.generations.get(id) ?? 0) !== generations[index])
      )
        throw new Error('The transfer preview was cancelled.')
      if (
        JSON.stringify(this.context.profile(source.id)) !== identities[0] ||
        JSON.stringify(this.context.profile(target.id)) !== identities[1]
      )
        throw new Error('A connection profile changed during preview. Preview again.')
      for (const [id, entry] of this.previews) if (entry.expires < Date.now()) this.previews.delete(id)
      while (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!)
      const token = randomUUID(),
        expires = Date.now() + 5 * 60 * 1000
      const response: DatabaseTransferPreview = {
        token,
        expiresAt: new Date(expires).toISOString(),
        sourceName: `${source.name} / ${input.source.database || source.database || 'main'}`,
        targetName: `${target.name} / ${input.target.database || target.database || 'main'} / ${input.target.schema}.${input.target.table}`,
        sourceColumns: columns,
        targetColumns: structure.columns,
        rows,
        warnings: [
          ...warnings,
          'Preview displays at most 20 rows / 256 KiB and clips fields to 512 characters; execution uses original full values.',
        ],
        confirmation: `TRANSFER ${input.target.connectionId}/${input.target.database ?? '(default)'}/${input.target.schema}/${input.target.table}`,
        sourceConsistency: exportConsistency(source.engine),
      }
      this.previews.set(token, {
        input: structuredClone(input),
        sourceProfile: JSON.stringify(source),
        targetProfile: JSON.stringify(target),
        structure: JSON.stringify(structure),
        columns,
        response,
        expires,
      })
      return structuredClone(response)
    } finally {
      this.reading.delete(controller)
    }
  }
  async start(raw: StartDatabaseTransferInput): Promise<DatabaseTransferJob> {
    const input = startDatabaseTransferSchema.parse(raw)
    if (this.closed) throw new Error('The transfer service is closing.')
    if (this.starting + [...this.jobs.values()].filter((job) => job.snapshot.state === 'running').length >= 2)
      throw new Error('Two database transfers are already running.')
    const preview = this.previews.get(input.token)
    this.previews.delete(input.token)
    if (!preview || preview.expires < Date.now())
      throw new Error('This transfer preview expired or was used. Preview again.')
    if (input.confirm !== preview.response.confirmation)
      throw new Error('Type the exact destination confirmation.')
    const [source, target] = this.profiles(preview.input)
    if (JSON.stringify(source) !== preview.sourceProfile || JSON.stringify(target) !== preview.targetProfile)
      throw new Error('A source or destination profile changed. Preview again.')
    if (
      input.mapping.some((map) => map.source >= preview.columns.length) ||
      new Set(input.mapping.map((map) => map.target)).size !== input.mapping.length
    )
      throw new Error('Map valid source columns to distinct destination columns.')
    const reviewedColumns = new Map(preview.response.targetColumns.map((column) => [column.name, column]))
    for (const mapping of input.mapping) {
      const column = reviewedColumns.get(mapping.target)
      if (!column || column.generated || column.identity === 'always')
        throw new Error(
          'Generated or identity-always destination columns cannot be mapped. Omit them to use server generation.',
        )
      if (/^(?:date|time|timestamp|timestamptz|timetz|interval)\b/i.test(column.type))
        throw new Error(
          'Native temporal destination types require a separate precision/time-zone conversion workflow. Use a TEXT destination to preserve the source representation.',
        )
    }
    for (const column of reviewedColumns.values()) {
      if (
        !input.mapping.some((mapping) => mapping.target === column.name) &&
        !column.nullable &&
        column.defaultValue === null &&
        !column.generated &&
        !column.identity &&
        !(target.engine === 'sqlite' && column.primaryKey && /^INTEGER$/i.test(column.type))
      )
        throw new Error('A required destination column is unmapped and has no default.')
    }
    const generations = [source.id, target.id].map((id) => this.generations.get(id) ?? 0)
    this.starting++
    const reader = new AbortController(),
      writerController = new AbortController()
    let writer: ImportWriter | undefined
    try {
      if (JSON.stringify(await this.context.structure(preview.input.target)) !== preview.structure)
        throw new Error('The destination schema changed after preview. Preview again.')
      writer = await this.context.openImport(
        {
          ...preview.input.target,
          confirm: importTargetConfirmation(preview.input.target),
          columns: input.mapping.map((map) => map.target),
        },
        writerController.signal,
      )
      const stableColumn = (column: ColumnInfo) =>
        JSON.stringify([
          column.name,
          column.type,
          column.nullable,
          column.defaultValue,
          column.generated,
          column.identity,
        ])
      if (
        input.mapping.some((mapping) => {
          const current = writer!.columns.find((column) => column.name === mapping.target)
          return !current || stableColumn(current) !== stableColumn(reviewedColumns.get(mapping.target)!)
        })
      )
        throw new Error('The destination columns changed while opening the writer. Preview again.')
      if (writer.commitModel === 'append')
        throw new Error('This transfer matrix requires transactional destination batches.')
      if (
        this.closed ||
        JSON.stringify(this.context.profile(source.id)) !== preview.sourceProfile ||
        JSON.stringify(this.context.profile(target.id)) !== preview.targetProfile ||
        [source.id, target.id].some((id, index) => (this.generations.get(id) ?? 0) !== generations[index])
      )
        throw new Error('A connection changed before transfer started.')
      for (const [id, job] of this.jobs)
        if (this.jobs.size >= 50 && job.snapshot.state !== 'running') this.jobs.delete(id)
      const id = randomUUID(),
        job: Job = {
          sourceId: source.id,
          targetId: target.id,
          reader,
          writer: writerController,
          started: performance.now(),
          done: Promise.resolve(),
          snapshot: {
            id,
            state: 'running',
            sourceName: preview.response.sourceName,
            targetName: preview.response.targetName,
            rowsRead: 0,
            committedRows: 0,
            committedBatches: 0,
            rolledBackRows: 0,
            uncertainRows: 0,
            bufferedRows: 0,
            unwrittenRows: 0,
            maxRows: input.maxRows,
            limitReached: false,
            durationMs: 0,
            warnings: [...warnings],
          },
        }
      this.jobs.set(id, job)
      job.done = this.run(job, input, preview, writer)
      return this.get(id)
    } catch (error) {
      await writer?.close().catch(() => {})
      throw error
    } finally {
      this.starting--
    }
  }
  private async run(
    job: Job,
    input: StartDatabaseTransferInput,
    preview: Preview,
    writer: ImportWriter,
  ): Promise<void> {
    let batch: Cell[][] = [],
      bytes = 0,
      failure: unknown,
      limit = false
    let state: DatabaseTransferJob['state'] = 'running'
    const columns = new Map(writer.columns.map((column) => [column.name, column]))
    const flush = async () => {
      if (!batch.length) return
      if (job.writer.signal.aborted) throw new Error('Transfer cancelled.')
      try {
        await writer.writeBatch(batch)
      } catch (error) {
        failure = error
        throw error
      }
      job.snapshot.committedRows += batch.length
      job.snapshot.committedBatches++
      batch = []
      bytes = 0
      job.snapshot.bufferedRows = 0
    }
    try {
      try {
        await this.context.streamQuery(preview.input.source, {
          signal: job.reader.signal,
          onColumns: async (columns) => {
            if (JSON.stringify(columns) !== JSON.stringify(preview.columns))
              throw new Error('Source columns changed after preview.')
          },
          onRow: async (row) => {
            if (job.writer.signal.aborted) throw new Error('Transfer cancelled.')
            if (job.snapshot.rowsRead >= input.maxRows) {
              limit = true
              job.snapshot.limitReached = true
              job.reader.abort()
              throw boundedStop
            }
            job.snapshot.rowsRead++
            const mapped = input.mapping.map((mapping) => {
              if (row[mapping.source] === undefined) throw new Error('Source row shape changed.')
              const column = columns.get(mapping.target)
              if (!column) throw new Error('A destination column changed.')
              return convertImportCell(row[mapping.source]!, mapping, column)
            })
            const size = Buffer.byteLength(JSON.stringify(mapped))
            if (size > 8 * 1024 * 1024) throw new Error('Mapped row exceeds 8 MiB.')
            if (batch.length && bytes + size > 8 * 1024 * 1024) await flush()
            batch.push(mapped)
            bytes += size
            job.snapshot.bufferedRows = batch.length
            if (batch.length >= input.batchSize) await flush()
          },
        })
      } catch (error) {
        if (!limit) throw error
      }
      await flush()
      if (job.writer.signal.aborted) throw new Error('Transfer cancelled.')
      state = 'completed'
    } catch (error) {
      const cause = failure ?? error
      if (cause instanceof ImportBatchError) {
        if (cause.outcome === 'rolled-back') job.snapshot.rolledBackRows = cause.rows
        else job.snapshot.uncertainRows = cause.rows
      }
      state = job.writer.signal.aborted && !job.snapshot.uncertainRows ? 'cancelled' : 'failed'
      job.snapshot.error = job.snapshot.uncertainRows
        ? 'The destination acknowledgement was lost. Inspect uncertain rows before any manual retry.'
        : job.writer.signal.aborted
          ? 'Transfer stopped. Earlier acknowledged batches remain committed.'
          : 'Transfer failed validation or a database operation. Earlier acknowledged batches remain committed. No retry was attempted.'
    } finally {
      job.reader.abort()
      await writer.close().catch(() => {})
      job.snapshot.bufferedRows = 0
      job.snapshot.unwrittenRows = Math.max(
        0,
        job.snapshot.rowsRead -
          job.snapshot.committedRows -
          job.snapshot.rolledBackRows -
          job.snapshot.uncertainRows,
      )
      job.snapshot.durationMs = Math.round(performance.now() - job.started)
      job.snapshot.state = state
    }
  }
  get(id: string): DatabaseTransferJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This transfer job is unavailable.')
    return structuredClone({
      ...job.snapshot,
      durationMs:
        job.snapshot.state === 'running'
          ? Math.round(performance.now() - job.started)
          : job.snapshot.durationMs,
    })
  }
  cancel(id: string): DatabaseTransferJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This transfer job is unavailable.')
    if (job.snapshot.state === 'running') {
      job.reader.abort()
      job.writer.abort()
    }
    return this.get(id)
  }
  async cancelForConnection(id: string): Promise<void> {
    for (const [controller, ids] of this.reading) if (ids.includes(id)) controller.abort()
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    for (const [token, preview] of this.previews)
      if ([preview.input.source.connectionId, preview.input.target.connectionId].includes(id))
        this.previews.delete(token)
    const jobs = [...this.jobs.values()].filter((job) => job.sourceId === id || job.targetId === id)
    for (const job of jobs)
      if (job.snapshot.state === 'running') {
        job.reader.abort()
        job.writer.abort()
      }
    await Promise.allSettled(jobs.map((job) => job.done))
  }
  async closeAll(): Promise<void> {
    this.closed = true
    this.previews.clear()
    for (const controller of this.reading.keys()) controller.abort()
    for (const job of this.jobs.values()) {
      job.reader.abort()
      job.writer.abort()
    }
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done))
  }
}
