import { Db2WorkerRuntime } from './db2-worker-runtime'
import type { Db2Request } from './db2-protocol'

const runtime = new Db2WorkerRuntime(
  (message) =>
    new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error('Missing parent IPC channel.'))
        return
      }
      process.send(message, (error) => (error ? reject(error) : resolve()))
    }),
)
process.on('message', (request: Db2Request) => {
  void runtime.handle(request).catch(() => process.exit(1))
})
process.on('disconnect', () => process.exit(0))
