import { createSecureContext } from 'node:tls'
import { BSON, MongoClient, type Document } from 'mongodb'
import type {
  ConnectionProfile,
  ConnectionStatus,
  Secrets,
  MongoReadInput,
  MongoReadResult,
  MongoWriteInput,
  Cell,
} from '../../shared/contracts'
import { openTransport, type Transport } from './transport'

const { EJSON } = BSON
const encode = (value: unknown) => EJSON.stringify(value, { relaxed: false })
export function parseMongoJson(source: string, array = false): Document | Document[] {
  let value: unknown
  try {
    value = EJSON.parse(source, { relaxed: false })
  } catch {
    throw new Error('Enter valid MongoDB Extended JSON.')
  }
  if (
    array
      ? !Array.isArray(value)
      : !value ||
        Array.isArray(value) ||
        typeof value !== 'object' ||
        Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(array ? 'An aggregation pipeline must be a JSON array.' : 'Enter a JSON document object.')
  return value as Document | Document[]
}
export function validateMongoRead(value: unknown, depth = 0): void {
  if (depth > 100) throw new Error('Query nesting exceeds 100 levels.')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['$out', '$merge', '$where', '$function', '$accumulator', '$changeStream'].includes(key))
      throw new Error(`${key} is not supported in read-only document queries.`)
    validateMongoRead(child, depth + 1)
  }
}

export class MongoService {
  private connections = new Map<
    string,
    { client: MongoClient; profile: ConnectionProfile; transport: Transport; status: ConnectionStatus }
  >()
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'mongodb') throw new Error('A MongoDB connection is required.')
    await this.disconnect(profile.id)
    if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(profile.host))
      throw new Error('Enter a single hostname or IP address without a URL or credentials.')
    if (profile.mongo.srv && (profile.mongo.directConnection || profile.ssh.enabled))
      throw new Error('SRV discovery cannot be combined with a direct connection or SSH tunnel.')
    if (profile.ssh.enabled && profile.mongo.replicaSet)
      throw new Error('Replica-set discovery through a single SSH tunnel is not supported.')
    if (secrets.password && !profile.username)
      throw new Error('A MongoDB username is required when supplying a password.')
    const start = performance.now()
    const transport = await openTransport(profile, secrets)
    const host = transport.host.includes(':') ? `[${transport.host}]` : transport.host
    const uri = profile.mongo.srv ? `mongodb+srv://${host}/` : `mongodb://${host}:${transport.port}/`
    let client: MongoClient | undefined
    try {
      const tls = transport.tls
        ? {
            secureContext: createSecureContext(transport.tls),
            rejectUnauthorized: transport.tls.rejectUnauthorized,
            ...(profile.ssh.enabled
              ? {
                  servername: transport.tls.servername,
                  checkServerIdentity: transport.tls.checkServerIdentity,
                }
              : {}),
          }
        : {}
      client = new MongoClient(uri, {
        ...tls,
        tls: profile.tls.enabled || profile.mongo.srv,
        ...(profile.username
          ? {
              auth: { username: profile.username, password: secrets.password || '' },
              authSource: profile.mongo.authSource,
            }
          : {}),
        ...(profile.mongo.replicaSet ? { replicaSet: profile.mongo.replicaSet } : {}),
        directConnection: profile.ssh.enabled || profile.mongo.directConnection,
        serverSelectionTimeoutMS: profile.connectTimeout,
        connectTimeoutMS: profile.connectTimeout,
        timeoutMS: profile.queryTimeout,
        maxPoolSize: 5,
        retryWrites: false,
        promoteValues: false,
        appName: 'Harbor DB',
      })
      await client.connect()
      await client.db(profile.database || 'admin').command({ ping: 1 })
      const status: ConnectionStatus = {
        state: 'connected',
        version: 'MongoDB',
        durationMs: performance.now() - start,
        transport: profile.ssh.enabled
          ? 'SSH tunnel'
          : profile.tls.enabled || profile.mongo.srv
            ? 'TLS'
            : 'TCP',
      }
      this.connections.set(profile.id, { client, profile, transport, status })
      return status
    } catch (error) {
      try {
        await client?.close()
      } finally {
        await transport.close()
      }
      throw error
    }
  }
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || { state: 'disconnected' }
  }
  private connection(id: string) {
    const connection = this.connections.get(id)
    if (!connection) throw new Error('Connect to MongoDB first.')
    return connection
  }
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    try {
      await connection.client.close()
    } finally {
      await connection.transport.close()
    }
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
  async databases(id: string): Promise<string[]> {
    const { client } = this.connection(id)
    const result = await client
      .db('admin')
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true })
    return result.databases.map((db) => db.name).sort()
  }
  async collections(input: { connectionId: string; database: string }): Promise<string[]> {
    const { client } = this.connection(input.connectionId)
    const cursor = client
      .db(input.database)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
    const names: string[] = []
    try {
      for await (const item of cursor) {
        names.push(item.name)
        if (names.length > 10000) throw new Error('More than 10,000 collections; narrow the database.')
      }
    } finally {
      await cursor.close()
    }
    return names.sort()
  }
  async read(input: MongoReadInput): Promise<MongoReadResult> {
    const { client, profile } = this.connection(input.connectionId)
    const query = parseMongoJson(input.query, input.mode === 'aggregate')
    validateMongoRead(query)
    const collection = client.db(input.database).collection(input.collection)
    const sort = input.sort
      ? { [input.sort]: input.direction === 'asc' ? (1 as const) : (-1 as const) }
      : undefined
    const cursor =
      input.mode === 'find'
        ? collection
            .find(query as Document, { maxTimeMS: profile.queryTimeout, ...(sort ? { sort } : {}) })
            .skip(input.offset)
            .limit(input.limit + 1)
        : collection.aggregate(
            [
              ...(query as Document[]),
              ...(sort ? [{ $sort: sort }] : []),
              { $skip: input.offset },
              { $limit: input.limit + 1 },
            ],
            { maxTimeMS: profile.queryTimeout, allowDiskUse: false },
          )
    const start = performance.now()
    const documents: string[] = []
    const values: Document[] = []
    let bytes = 0,
      hasMore = false,
      truncated = false
    try {
      for await (const doc of cursor) {
        if (documents.length >= input.limit) {
          hasMore = true
          break
        }
        const serialized = encode(doc)
        bytes += Buffer.byteLength(serialized)
        if (bytes > 4 * 1024 * 1024) {
          truncated = true
          break
        }
        documents.push(serialized)
        values.push(doc)
      }
    } finally {
      await cursor.close()
    }
    const names = [...new Set(values.flatMap((doc) => Object.keys(doc)))].slice(0, 200)
    const cell = (value: unknown): Cell => {
      if (value == null) return null
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
      if (value instanceof BSON.ObjectId || value instanceof BSON.Long || value instanceof BSON.Decimal128)
        return value.toString()
      if (value instanceof BSON.Int32 || value instanceof BSON.Double) return value.value
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
      return encode(value)
    }
    const valueType = (value: unknown): string => {
      if (value == null) return 'null'
      if (value instanceof Date) return 'Date'
      if (Array.isArray(value)) return 'Array'
      if (typeof value === 'object' && '_bsontype' in value) return String(value._bsontype)
      return typeof value
    }
    return {
      documents,
      durationMs: performance.now() - start,
      hasMore,
      truncated,
      set: {
        columns: names.map((name) => ({
          name,
          type:
            [...new Set(values.filter((doc) => doc[name] != null).map((doc) => valueType(doc[name])))].join(
              ' | ',
            ) || 'null',
          key: name === '_id',
        })),
        rows: values.map((doc) => names.map((name) => cell(doc[name]))),
        affectedRows: 0,
        command: input.mode,
        truncated,
      },
    }
  }
  async write(input: MongoWriteInput): Promise<void> {
    const { client, profile } = this.connection(input.connectionId)
    if (profile.readOnly)
      throw new Error(
        'This MongoDB connection is read-only. Enable writes deliberately in connection settings.',
      )
    if (input.collection.startsWith('system.'))
      throw new Error('Editing MongoDB system collections is not supported.')
    const collection = client.db(input.database).collection(input.collection)
    if (input.action === 'insert') {
      if (!input.document) throw new Error('A document is required.')
      await collection.insertOne(parseMongoJson(input.document) as Document)
      return
    }
    if (!input.original) throw new Error('The original document is required for conflict detection.')
    const original = parseMongoJson(input.original) as Document
    if (!Object.hasOwn(original, '_id')) throw new Error('The original document must contain _id.')
    const filter = { _id: original._id, $expr: { $eq: ['$$ROOT', { $literal: original }] } }
    if (input.action === 'delete') {
      const result = await collection.deleteOne(filter, { collation: { locale: 'simple' } })
      if (Number(result.deletedCount) !== 1)
        throw new Error('Conflict: the document changed or was deleted. Reload before retrying.')
    } else {
      if (!input.document) throw new Error('A replacement document is required.')
      const replacement = parseMongoJson(input.document) as Document
      if (encode(replacement._id) !== encode(original._id))
        throw new Error('The document _id cannot be changed.')
      const result = await collection.replaceOne(filter, replacement, { collation: { locale: 'simple' } })
      if (Number(result.matchedCount) !== 1)
        throw new Error('Conflict: the document changed or was deleted. Reload before retrying.')
    }
  }
}
