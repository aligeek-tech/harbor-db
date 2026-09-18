import cassandra from 'cassandra-driver'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
const path = process.env.HARBOR_CASSANDRA_CREDENTIALS
if (!path) throw new Error('External fixture credential path required')
const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
const password = prior?.password || randomUUID() + randomUUID()
// Save before altering so interruption cannot lose the fixture credential.
if (!prior)
  writeFileSync(path, JSON.stringify({ username: 'cassandra', password }), { mode: 0o600, flag: 'wx' })
chmodSync(path, 0o600)
async function connect(pass) {
  const client = new cassandra.Client({
    contactPoints: ['127.0.0.1:19042'],
    localDataCenter: 'datacenter1',
    authProvider: new cassandra.auth.PlainTextAuthProvider('cassandra', pass),
    policies: {
      retry: new cassandra.policies.retry.FallthroughRetryPolicy(),
      speculativeExecution: new cassandra.policies.speculativeExecution.NoSpeculativeExecutionPolicy(),
    },
    socketOptions: { connectTimeout: 3000, readTimeout: 5000 },
    isMetadataSyncEnabled: false,
  })
  try {
    await client.connect()
    return client
  } catch {
    await client.shutdown()
    return null
  }
}
let client = await connect(password)
if (!client) {
  client = await connect('cassandra')
  if (!client) throw new Error('Fixture not ready or fixture credentials differ')
  await client.execute(`ALTER ROLE cassandra WITH PASSWORD = '${password}'`)
}
await client.shutdown()
console.log('Cassandra fixture credential bootstrap complete; secret not printed.')
