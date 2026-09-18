import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { QueryStreamSink } from './adapter'
import type { Db2Request, Db2Response } from './db2-protocol'

export const DB2_INTERRUPTED =
  'Db2 client process closed. Server completion is unconfirmed; reconnect explicitly. No statement was replayed.'
type Command = Db2Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never
interface Pending {
  id: number
  resolve: (response: Db2Response) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sink?: QueryStreamSink
  streaming: boolean
}

/** One physical native session per process; parent never executes native blocking code. */
export class Db2Process {
  private readonly child: ChildProcess
  private pending?: Pending
  private sequence = 0
  private exited: Promise<void>
  dead = false

  constructor(
    worker?: URL,
    private readonly onFailure: () => void = () => {},
  ) {
    const url =
      worker ??
      new URL(
        import.meta.url.endsWith('.ts') ? '../../../out/main/db2-worker.js' : './db2-worker.js',
        import.meta.url,
      )
    const path = fileURLToPath(url).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', DB2CODEPAGE: '1208' }
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'])
      if (process.env[key]) env[key] = process.env[key]
    this.child = fork(path, [], {
      env,
      execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    })
    this.exited = new Promise((resolve) => this.child.once('exit', () => resolve()))
    this.child.once('error', () =>
      this.fail(new Error('Db2 child process could not start. Verify its packaged runtime.')),
    )
    this.child.once('exit', () => {
      if (!this.dead) this.fail(new Error(DB2_INTERRUPTED))
    })
    this.child.on('message', (response: Db2Response) => {
      void this.receive(response).catch(() =>
        this.fail(
          new Error('Db2 export consumer failed; client process closed. Partial output was not finalized.'),
        ),
      )
    })
  }
  request(command: Command, timeout: number, sink?: QueryStreamSink): Promise<Db2Response> {
    if (this.dead) return Promise.reject(new Error(DB2_INTERRUPTED))
    if (this.pending) return Promise.reject(new Error('The Db2 session is busy.'))
    if (sink?.signal.aborted) return Promise.reject(new Error('Db2 export cancelled before execution.'))
    const id = ++this.sequence
    return new Promise<Db2Response>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Db2 operation deadline reached. ${DB2_INTERRUPTED}`)),
        timeout,
      )
      this.pending = { id, resolve, reject, timer, sink, streaming: false }
      this.child.send({ ...command, id }, (error) => {
        if (error) this.fail(new Error(DB2_INTERRUPTED))
      })
    })
  }
  private async receive(response: Db2Response): Promise<void> {
    const pending = this.pending
    if (!pending || pending.id !== response.id || this.dead) return
    if (response.stream) {
      if (!pending.sink || pending.streaming) {
        this.fail(new Error('Db2 worker violated stream backpressure.'))
        return
      }
      pending.streaming = true
      try {
        if (pending.sink.signal.aborted) throw new Error('Export cancelled.')
        if (response.stream.columns) await pending.sink.onColumns(response.stream.columns)
        if (response.stream.row) await pending.sink.onRow(response.stream.row)
        if (pending.sink.signal.aborted) throw new Error('Export cancelled.')
        if (this.pending === pending && !this.dead)
          this.child.send({ action: 'ack', id: ++this.sequence, target: pending.id }, (error) => {
            if (error) this.fail(new Error(DB2_INTERRUPTED))
          })
      } finally {
        pending.streaming = false
      }
      return
    }
    if (pending.streaming) {
      this.fail(new Error('Db2 worker completed before its stream consumer.'))
      return
    }
    clearTimeout(pending.timer)
    this.pending = undefined
    if (response.error) {
      pending.reject(new Error(response.error))
      if (response.fatal) this.fail(new Error(DB2_INTERRUPTED))
    } else pending.resolve(response)
  }
  private fail(error: Error): void {
    if (this.dead) return
    this.dead = true
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.child.kill('SIGKILL')
    this.onFailure()
  }
  cancel(): void {
    this.fail(new Error(DB2_INTERRUPTED))
  }
  async close(): Promise<void> {
    if (!this.dead && !this.pending) await this.request({ action: 'close' }, 1000).catch(() => {})
    if (!this.dead) this.fail(new Error(DB2_INTERRUPTED))
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500)
        timer.unref()
      }),
    ])
  }
}
