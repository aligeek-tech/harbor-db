import process from 'node:process'
// Child-process protocol fixture only. This is not a Db2 server or native driver.
let active
process.on('message', (message) => {
  if (message.action === 'open' || message.action === 'close')
    process.send({ id: message.id, version: 'protocol fixture' })
  else if (message.action === 'ack' && active?.id === message.target) {
    if (active.rows++ === 0) process.send({ id: active.id, stream: { row: ['one'] } })
    else {
      process.send({
        id: active.id,
        set: { columns: [], rows: [], affectedRows: 0, command: 'SELECT', truncated: false },
      })
      active = undefined
    }
  } else if (message.action === 'query') {
    if (message.sql === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
    else if (message.stream) {
      active = { id: message.id, rows: 0 }
      process.send({ id: message.id, stream: { columns: [{ name: 'A', type: 'fixture' }] } })
      if (message.sql === 'break-protocol') process.send({ id: message.id, stream: { row: ['unsolicited'] } })
    } else
      process.send({
        id: message.id,
        set: { columns: [], rows: [], affectedRows: 0, command: 'SELECT', truncated: false },
      })
  }
})
process.on('disconnect', () => process.exit())
