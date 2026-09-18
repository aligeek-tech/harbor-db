import net from 'node:net'
// Test-only native v4 proxy: the complete request is forwarded once, and only
// its matching response stream is withheld. No fake database result is used.
export async function cqlFixtureProxy() {
  const sockets = new Set<net.Socket>()
  let mode: 'forward' | 'hold' | 'drop' = 'forward',
    match = ''
  let hits = 0,
    acknowledge: (() => void) | undefined
  let observed = Promise.resolve()
  const server = net.createServer((peer) => {
    const upstream = net.connect({ host: '127.0.0.1', port: 19042 })
    sockets.add(peer)
    sockets.add(upstream)
    const pending = new Map<number, string>(),
      prepared = new Map<string, string>()
    let requests = Buffer.alloc(0),
      responses = Buffer.alloc(0)
    const close = () => {
      peer.destroy()
      upstream.destroy()
      sockets.delete(peer)
      sockets.delete(upstream)
    }
    peer.on('error', close)
    upstream.on('error', close)
    peer.on('close', close)
    upstream.on('close', close)
    peer.on('data', (chunk) => {
      requests = Buffer.concat([requests, chunk])
      while (requests.length >= 9) {
        const size = requests.readUInt32BE(5) + 9
        if (size > 8 * 1024 * 1024) {
          close()
          return
        }
        if (requests.length < size) return
        const frame = requests.subarray(0, size),
          opcode = frame[4],
          stream = frame.readInt16BE(2),
          body = frame.subarray(9)
        requests = requests.subarray(size)
        if (opcode === 0x09 || opcode === 0x07)
          pending.set(stream, body.subarray(4, 4 + body.readUInt32BE(0)).toString())
        else if (opcode === 0x0a)
          pending.set(stream, prepared.get(body.subarray(2, 2 + body.readUInt16BE(0)).toString('hex')) || '')
        upstream.write(frame)
      }
    })
    upstream.on('data', (chunk) => {
      responses = Buffer.concat([responses, chunk])
      while (responses.length >= 9) {
        const size = responses.readUInt32BE(5) + 9
        if (size > 8 * 1024 * 1024) {
          close()
          return
        }
        if (responses.length < size) return
        const frame = responses.subarray(0, size),
          stream = frame.readInt16BE(2),
          query = pending.get(stream) || '',
          body = frame.subarray(9)
        responses = responses.subarray(size)
        const isPrepared = frame[4] === 0x08 && body.length >= 6 && body.readUInt32BE(0) === 4
        if (isPrepared) prepared.set(body.subarray(6, 6 + body.readUInt16BE(4)).toString('hex'), query)
        pending.delete(stream)
        if (!isPrepared && mode !== 'forward' && query.startsWith(match)) {
          hits++
          acknowledge?.()
          if (mode === 'drop') close()
        } else peer.write(frame)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    arm(next: 'hold' | 'drop', prefix: string) {
      mode = next
      match = prefix
      hits = 0
      observed = new Promise((resolve) => {
        acknowledge = resolve
      })
    },
    get hits() {
      return hits
    },
    wait() {
      return observed
    },
    forward() {
      mode = 'forward'
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
