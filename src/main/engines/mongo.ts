import type { MongoFileExportInput } from '../../shared/mongo-files'
import { MongoFileWriteError, type MongoFileSession } from './mongo-file-session'
import { createSecureContext } from 'node:tls'
import { BSON, MongoClient, type Document } from 'mongodb'
import { parse as parseLossless, isLosslessNumber } from 'lossless-json'
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
import { mongoConnectionUri, validateMongoProfile } from './mongo-config'
import { MongoIndexTools } from './mongo-indexes'
import type {
  MongoTopology,
  MongoToolTarget,
  MongoIndexPreviewInput,
  MongoIndexExecuteInput,
} from '../../shared/mongo-tools'

const { EJSON } = BSON
const encode = (value: unknown) => EJSON.stringify(value, { relaxed: false })
interface LiveMongoConnection {
  client: MongoClient
  profile: ConnectionProfile
  transport: Transport
  status: ConnectionStatus
  initialized: boolean
  closed: boolean
  topologyAvailable: boolean
  topologyPartial: boolean
  healthGeneration: number
  topology: Omit<MongoTopology, 'status' | 'warnings' | 'readPreference'>
  checking?: Promise<void>
}

function authenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 18) return true
  return 'cause' in error && error.cause !== error && authenticationFailure(error.cause)
}
function connectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    /Mongo(?:Network|ServerSelection|NotConnected|TopologyClosed|PoolCleared|OperationTimeout)/.test(
      error.name,
    ) ||
    ('code' in error && [91, 189, 10107, 11600, 11602, 13435, 13436].includes(Number(error.code))) ||
    ('cause' in error && error.cause !== error && connectionFailure(error.cause))
  )
}
export function parseMongoJson(source: string, array = false): Document | Document[] {
  if (Buffer.byteLength(source) > 1000000) throw new Error('MongoDB input exceeds 1 MB.')
  let exact: unknown
  try {
    exact = parseLossless(source)
  } catch {
    throw new Error('Enter valid MongoDB Extended JSON without duplicate object keys.')
  }
  let nodes = 0
  const inspect = (input: unknown, depth = 0): void => {
    if (++nodes > 50000 || depth > 100)
      throw new Error('MongoDB input nesting or complexity exceeds the local bound.')
    if (isLosslessNumber(input)) {
      const number = Number(input.value)
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
        throw new Error(
          'Use canonical $numberLong or $numberDecimal string values for integers outside the exact numeric range.',
        )
    } else if (input && typeof input === 'object')
      for (const child of Object.values(input)) inspect(child, depth + 1)
  }
  inspect(exact)
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
  private indexTools = new MongoIndexTools((source) => parseMongoJson(source) as Document, validateMongoRead)
  private connections = new Map<string, LiveMongoConnection>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()

  private observe(
    id: string,
    state: ConnectionStatus['state'],
    details: Partial<ConnectionStatus> = {},
  ): ConnectionStatus {
    const previous = this.states.get(id)
    const now = new Date().toISOString()
    const status: ConnectionStatus = {
      ...previous,
      ...details,
      state,
      checkedAt: now,
      changedAt: previous?.state === state ? previous.changedAt || now : now,
    }
    this.states.set(id, status)
    const live = this.connections.get(id)
    if (live) live.status = status
    return status
  }
  private current(live: LiveMongoConnection): boolean {
    return !live.closed && this.connections.get(live.profile.id) === live
  }
  private unhealthy(live: LiveMongoConnection, error?: unknown): void {
    if (!this.current(live) || !live.initialized) return
    if (live.status.state === 'authentication-failed' && !authenticationFailure(error)) return
    live.healthGeneration++
    this.observe(live.profile.id, authenticationFailure(error) ? 'authentication-failed' : 'reconnecting', {
      error: authenticationFailure(error)
        ? 'MongoDB authentication failed. Check credentials and reconnect explicitly.'
        : 'MongoDB connectivity changed. Checking recovery; previous results may be stale. No operation is replayed.',
    })
  }
  private healthy(live: LiveMongoConnection): void {
    if (!this.current(live) || live.status.state === 'authentication-failed') return
    this.observe(live.profile.id, live.topologyPartial ? 'degraded' : 'connected', {
      lastConnectedAt: new Date().toISOString(),
      error: live.topologyPartial
        ? 'MongoDB is reachable, but part of its topology is unavailable. Results may be stale.'
        : undefined,
    })
  }
  private checkRecovery(live: LiveMongoConnection): void {
    if (
      !this.current(live) ||
      !live.initialized ||
      !live.topologyAvailable ||
      live.checking ||
      ['connected', 'authentication-failed'].includes(live.status.state)
    )
      return
    const generation = live.healthGeneration
    // A hello/ready pool is not authentication evidence. Only a new bounded ping
    // using this profile can restore readiness; user operations are never replayed.
    live.checking = live.client
      .db(live.profile.database || 'admin')
      .command({ ping: 1 }, { timeoutMS: Math.min(live.profile.connectTimeout, 5000) })
      .then(() => {
        if (live.healthGeneration === generation) this.healthy(live)
      })
      .catch((error: unknown) => this.unhealthy(live, error))
      .finally(() => {
        live.checking = undefined
      })
  }
  private monitor(live: LiveMongoConnection): void {
    const { client } = live
    client.on('topologyDescriptionChanged', ({ newDescription }) => {
      if (!this.current(live)) return
      const servers = [...newDescription.servers.values()]
      const hasPrimary = servers.some((server) => server.type === 'RSPrimary')
      const hasSecondary = servers.some((server) => server.type === 'RSSecondary')
      const ordinary = servers.some((server) => ['Standalone', 'Mongos'].includes(server.type))
      const readable =
        ordinary ||
        (live.profile.mongo.readPreference === 'primary'
          ? hasPrimary
          : live.profile.mongo.readPreference === 'secondary'
            ? hasSecondary
            : hasPrimary || hasSecondary)
      live.topologyAvailable = newDescription.compatible && newDescription.hasDataBearingServers && readable
      live.topology = {
        type: newDescription.type,
        ...(newDescription.setName ? { setName: newDescription.setName } : {}),
        primary: servers.find((server) => server.type === 'RSPrimary')?.address,
        writable: ordinary || hasPrimary,
        observedAt: new Date().toISOString(),
        servers: servers.slice(0, 100).map((server) => ({
          address: server.address,
          type: server.type,
          reachable: server.type !== 'Unknown',
          ...(server.roundTripTime >= 0 ? { roundTripMs: server.roundTripTime } : {}),
        })),
      }
      live.topologyPartial = [...newDescription.servers.values()].some((server) => server.type === 'Unknown')
      if (!live.initialized) return
      if (!live.topologyAvailable) this.unhealthy(live)
      else {
        if (live.topologyPartial)
          this.observe(live.profile.id, 'degraded', {
            error: 'Part of the MongoDB topology is unavailable. Checking the current connection.',
          })
        this.checkRecovery(live)
      }
    })
    client.on('serverHeartbeatFailed', ({ failure }) => this.unhealthy(live, failure))
    client.on('serverHeartbeatSucceeded', () => {
      if (!this.current(live) || !live.initialized) return
      if (live.status.state === 'connected') this.observe(live.profile.id, 'connected')
      else this.checkRecovery(live)
    })
    client.on('connectionPoolCleared', () => this.unhealthy(live))
    client.on('connectionPoolReady', () => this.checkRecovery(live))
    client.on('topologyClosed', () => {
      if (this.current(live) && live.initialized)
        this.observe(live.profile.id, 'disconnected', {
          error: 'MongoDB monitoring stopped. Reconnect explicitly before continuing.',
        })
    })
  }
  private async operation<T>(live: LiveMongoConnection, action: () => Promise<T>, write = false): Promise<T> {
    if (write && (live.status.state !== 'connected' || !live.topology.writable))
      throw new Error(
        'MongoDB is not ready for writes. Wait for recovery, inspect the data, and retry explicitly.',
      )
    const generation = live.healthGeneration
    try {
      const result = await action()
      if (live.healthGeneration === generation) this.healthy(live)
      return result
    } catch (error) {
      if (authenticationFailure(error) || connectionFailure(error)) {
        this.unhealthy(live, error)
        if (write)
          throw new Error(
            'MongoDB write outcome is uncertain after a connection failure or timeout. Inspect the document before retrying. Harbor did not replay the write.',
          )
      }
      throw error
    }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'mongodb') throw new Error('A MongoDB connection is required.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id)
    this.observe(profile.id, 'connecting', { error: undefined, durationMs: undefined })
    const start = performance.now()
    let transport: Transport | undefined
    let client: MongoClient | undefined
    try {
      validateMongoProfile(profile)
      if (secrets.password && !profile.username)
        throw new Error('A MongoDB username is required when supplying a password.')
      transport = await openTransport(profile, secrets)
      const uri = mongoConnectionUri(profile, transport)
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
        ...(profile.mongo.authMechanism !== 'DEFAULT' ? { authMechanism: profile.mongo.authMechanism } : {}),
        readPreference: profile.mongo.readPreference,
        directConnection: profile.ssh.enabled || profile.mongo.directConnection,
        serverSelectionTimeoutMS: profile.connectTimeout,
        connectTimeoutMS: profile.connectTimeout,
        timeoutMS: profile.queryTimeout,
        maxPoolSize: 5,
        heartbeatFrequencyMS: 2000,
        retryReads: false,
        retryWrites: false,
        enableOverloadRetargeting: false,
        maxAdaptiveRetries: 0,
        promoteValues: false,
        appName: 'Harbor DB',
      })
      const live: LiveMongoConnection = {
        client,
        profile,
        transport,
        status: this.states.get(profile.id)!,
        initialized: false,
        closed: false,
        topologyAvailable: false,
        topologyPartial: false,
        healthGeneration: 0,
        topology: { type: 'Unknown', writable: false, observedAt: new Date().toISOString(), servers: [] },
      }
      if (this.generations.get(profile.id) !== generation) {
        await client.close()
        await transport?.close()
        return this.status(profile.id)
      }
      this.connections.set(profile.id, live)
      this.monitor(live)
      await client.connect()
      await client.db(profile.database || 'admin').command({ ping: 1 })
      if (!this.current(live)) return this.status(profile.id)
      live.initialized = true
      this.observe(profile.id, 'connected', {
        version: 'MongoDB',
        durationMs: performance.now() - start,
        transport: profile.ssh.enabled
          ? 'SSH tunnel'
          : profile.tls.enabled || profile.mongo.srv
            ? 'TLS'
            : 'TCP',
        error: undefined,
      })
      this.healthy(live)
      return this.status(profile.id)
    } catch (error) {
      const live = this.connections.get(profile.id)
      if (live && live.client === client) {
        live.closed = true
        this.connections.delete(profile.id)
      }
      try {
        await client?.close()
      } finally {
        await transport?.close()
      }
      if (this.generations.get(profile.id) === generation)
        this.observe(profile.id, authenticationFailure(error) ? 'authentication-failed' : 'failed', {
          error: authenticationFailure(error)
            ? 'MongoDB authentication failed. Check credentials and reconnect explicitly.'
            : 'MongoDB could not connect. Check the server address, transport, and connection settings.',
        })
      throw error
    }
  }
  status(id: string): ConnectionStatus {
    return { ...(this.states.get(id) || { state: 'disconnected' }) }
  }
  private connection(id: string) {
    const connection = this.connections.get(id)
    if (!connection?.initialized || connection.closed) throw new Error('Connect to MongoDB first.')
    return connection
  }
  async disconnect(id: string): Promise<void> {
    this.indexTools.clear(id)
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.observe(id, 'disconnected', { error: undefined })
    if (!connection) return
    connection.closed = true
    try {
      await connection.client.close()
    } finally {
      await connection.transport.close()
    }
  }
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
  async topology(id: string): Promise<MongoTopology> {
    const live = this.connection(id)
    await this.operation(live, () =>
      live.client.db(live.profile.database || 'admin').command(
        { ping: 1 },
        {
          readPreference: live.profile.mongo.readPreference,
          timeoutMS: Math.min(live.profile.connectTimeout, 5000),
        },
      ),
    )
    return {
      ...live.topology,
      status: live.status,
      readPreference: live.profile.mongo.readPreference,
      warnings: [
        'Topology is observed by the MongoDB driver and confirmed with an authenticated bounded ping. It is not a server administration or reconfiguration control.',
        ...(live.profile.mongo.readPreference !== 'primary'
          ? [
              'Secondary reads can be stale; this read preference does not change write routing or enable transactions.',
            ]
          : []),
        ...(!live.topology.writable
          ? ['No writable primary is currently observed. Document and index changes are blocked.']
          : []),
        ...(live.topologyPartial
          ? [
              'Some discovered members are unavailable. Existing results may be stale; inspect recovery before another write.',
            ]
          : []),
        'Harbor disables read/write and overload retries. Failed user operations are never automatically replayed.',
        'Multi-document transactions, replica-set reconfiguration and managed Atlas administration are not available.',
      ],
    }
  }
  async indexes(input: MongoToolTarget) {
    const live = this.connection(input.connectionId)
    return this.operation(live, () => this.indexTools.catalog(live, input))
  }
  async previewIndex(input: MongoIndexPreviewInput) {
    const live = this.connection(input.connectionId)
    return this.operation(live, () => this.indexTools.preview(live, input))
  }
  async executeIndex(input: MongoIndexExecuteInput) {
    const live = this.connection(input.connectionId)
    return this.operation(live, () => this.indexTools.execute(live, input), true)
  }
  /** Main-only opaque file-transfer session, bound to this native connection and collection UUID. */
  async openFileSession(target: MongoToolTarget, write: boolean): Promise<MongoFileSession> {
    const live = this.connection(target.connectionId)
    if (target.collection.startsWith('system.'))
      throw new Error('System collections are unavailable for file transfers.')
    if (write && live.profile.readOnly) throw new Error('This MongoDB profile is read-only.')
    const collection = live.client.db(target.database).collection(target.collection)
    const fingerprint = async () => {
      if (!this.current(live))
        throw new Error('The MongoDB connection changed. Preview again; no operation was replayed.')
      const rows = await live.client
        .db(target.database)
        .listCollections(
          { name: target.collection },
          {
            nameOnly: false,
            maxTimeMS: live.profile.queryTimeout,
            readPreference: 'primary',
          },
        )
        .toArray()
      if (
        rows.length !== 1 ||
        rows[0].type !== 'collection' ||
        rows[0].options?.timeseries ||
        rows[0].options?.capped ||
        !rows[0].info?.uuid
      )
        throw new Error('Choose one existing ordinary uncapped collection with visible identity metadata.')
      return encode({ uuid: rows[0].info.uuid, options: rows[0].options })
    }
    const original = await this.operation(live, fingerprint)
    const validate = async () => {
      if ((await this.operation(live, fingerprint)) !== original)
        throw new Error(
          'The MongoDB collection identity or options changed. Preview again before continuing.',
        )
    }
    return {
      validate,
      canonical: (source) => encode(parseMongoJson(source)),
      insert: async (source, signal) => {
        if (!write) throw new Error('This file session does not authorize writes.')
        if (signal.aborted || !this.current(live) || live.profile.readOnly)
          throw new MongoFileWriteError('Import stopped before dispatch.', false)
        const document = parseMongoJson(source) as Document
        let dispatched = false
        try {
          await this.operation(
            live,
            async () => {
              dispatched = true
              const result = await collection.insertOne(document, {
                writeConcern: { w: 'majority' },
                timeoutMS: live.profile.queryTimeout,
              })
              if (!result.acknowledged) throw new Error('Write was not acknowledged.')
            },
            true,
          )
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : undefined
          const rejected = [11000, 121, 13, 18, 2, 9, 14, 66, 10334].includes(code ?? -1)
          throw new MongoFileWriteError(
            rejected
              ? `MongoDB rejected this document (code ${code}); earlier acknowledged documents remain committed.`
              : 'MongoDB import stopped. Inspect the target before retrying; no document was replayed.',
            dispatched && !rejected,
          )
        }
      },
      stream: async (input: MongoFileExportInput, signal, onDocument) => {
        await validate()
        const query = parseMongoJson(input.query, input.mode === 'aggregate')
        if (input.mode === 'aggregate' && (query as Document[]).length > 100)
          throw new Error('Aggregation pipelines are limited to100stages.')
        validateMongoRead(query)
        const options = {
          maxTimeMS: live.profile.queryTimeout,
          timeoutMS: live.profile.queryTimeout,
          batchSize: 1,
          signal,
        }
        const cursor =
          input.mode === 'find'
            ? collection.find(query as Document, options).limit(input.maxDocuments + 1)
            : collection.aggregate([...(query as Document[]), { $limit: input.maxDocuments + 1 }], {
                ...options,
                allowDiskUse: false,
              })
        let count = 0
        try {
          for await (const document of cursor) {
            if (signal.aborted || !this.current(live))
              throw new Error('MongoDB export cancelled or connection changed.')
            if (count++ >= input.maxDocuments) return true
            const line = encode(document)
            if (Buffer.byteLength(line) > 1000000)
              throw new Error('Document exceeds the1MB file-transfer bound. Narrow the query projection.')
            await onDocument(line)
          }
          return false
        } finally {
          await cursor.close()
        }
      },
    }
  }
  async databases(id: string): Promise<string[]> {
    const live = this.connection(id)
    return this.operation(live, async () => {
      const result = await live.client
        .db('admin')
        .admin()
        .listDatabases({ nameOnly: true, authorizedDatabases: true })
      return result.databases.map((db) => db.name).sort()
    })
  }
  async collections(input: { connectionId: string; database: string }): Promise<string[]> {
    const live = this.connection(input.connectionId)
    return this.operation(live, async () => {
      const cursor = live.client
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
    })
  }
  async read(input: MongoReadInput): Promise<MongoReadResult> {
    const live = this.connection(input.connectionId)
    return this.operation(live, () => this.readDocuments(input, live))
  }
  private async readDocuments(input: MongoReadInput, live: LiveMongoConnection): Promise<MongoReadResult> {
    const { client, profile } = live
    const query = parseMongoJson(input.query, input.mode === 'aggregate')
    if (input.mode === 'aggregate' && (query as Document[]).length > 100)
      throw new Error('Aggregation pipelines are limited to 100 stages.')
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
    const live = this.connection(input.connectionId)
    return this.operation(live, () => this.writeDocument(input, live), true)
  }
  private async writeDocument(input: MongoWriteInput, live: LiveMongoConnection): Promise<void> {
    const { client, profile } = live
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
