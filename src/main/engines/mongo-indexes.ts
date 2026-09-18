import { createHash, randomUUID } from 'node:crypto'
import { BSON, type MongoClient, type Document } from 'mongodb'
import type { ConnectionProfile } from '../../shared/contracts'
import {
  mongoToolTargetSchema,
  mongoIndexPreviewSchema,
  mongoIndexExecuteSchema,
  mongoIndexConfirmation,
  type MongoToolTarget,
  type MongoIndexCatalog,
  type MongoIndexPreviewInput,
  type MongoIndexPreview,
  type MongoIndexExecuteInput,
  type MongoIndexResult,
} from '../../shared/mongo-tools'

interface IndexConnection {
  client: MongoClient
  profile: ConnectionProfile
  closed: boolean
}
const encode = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false })
function target(input: MongoToolTarget): MongoToolTarget {
  const value = mongoToolTargetSchema.parse(input)
  if (
    ['admin', 'config', 'local'].includes(value.database) ||
    value.collection.startsWith('system.') ||
    /\0/.test(value.database + value.collection)
  )
    throw new Error(
      'Index administration is limited to an explicit application collection, not internal databases or system collections.',
    )
  return value
}
export class MongoIndexTools {
  private reviews = new Map<
    string,
    {
      live: IndexConnection
      input: MongoIndexPreviewInput
      fingerprint: string
      expires: number
      options?: Document
    }
  >()
  constructor(
    private parseFilter: (source: string) => Document,
    private validateFilter: (input: unknown) => void,
  ) {}
  clear(connectionId: string): void {
    for (const [token, review] of this.reviews)
      if (review.live.profile.id === connectionId) this.reviews.delete(token)
  }
  async catalog(live: IndexConnection, input: MongoToolTarget): Promise<MongoIndexCatalog> {
    const selected = mongoToolTargetSchema.parse(input)
    const db = live.client.db(selected.database)
    const meta = await db
      .listCollections(
        { name: selected.collection },
        { nameOnly: false, maxTimeMS: live.profile.queryTimeout, readPreference: 'primary' },
      )
      .toArray()
    if (meta.length !== 1 || meta[0].type !== 'collection')
      throw new Error(
        'Choose one existing ordinary MongoDB collection. Views and time-series index administration are not supported.',
      )
    const collectionJson = encode(meta[0])
    const indexes: MongoIndexCatalog['indexes'] = []
    let bytes = Buffer.byteLength(collectionJson)
    const cursor = db
      .collection(selected.collection)
      .listIndexes({ maxTimeMS: live.profile.queryTimeout, readPreference: 'primary' })
    try {
      for await (const index of cursor) {
        const definitionJson = encode(index)
        bytes += Buffer.byteLength(definitionJson)
        if (indexes.length >= 1000 || bytes > 4 * 1024 * 1024)
          throw new Error('Index metadata exceeds the bounded 1000-index / 4 MiB inspector limit.')
        indexes.push({
          name: String(index.name),
          keys: Object.entries(index.key).map(([field, direction]) => ({
            field,
            direction: String(direction),
          })),
          unique: !!index.unique,
          sparse: !!index.sparse,
          hidden: !!index.hidden,
          ...(index.expireAfterSeconds === undefined
            ? {}
            : { expireAfterSeconds: String(index.expireAfterSeconds) }),
          definitionJson,
        })
      }
    } finally {
      await cursor.close()
    }
    indexes.sort((a, b) => a.name.localeCompare(b.name))
    return {
      database: selected.database,
      collection: selected.collection,
      collectionJson,
      indexes,
      warnings: [
        'Catalog definitions are read from the primary. Index changes are not transactional; a dropped index must be rebuilt to restore it.',
        'Atlas Search/vector indexes use a different API and are not managed here.',
      ],
    }
  }
  private fingerprint(catalog: MongoIndexCatalog): string {
    return createHash('sha256')
      .update(catalog.collectionJson)
      .update(JSON.stringify(catalog.indexes.map(({ name, definitionJson }) => [name, definitionJson])))
      .digest('hex')
  }
  async preview(live: IndexConnection, raw: MongoIndexPreviewInput): Promise<MongoIndexPreview> {
    const input = mongoIndexPreviewSchema.parse(raw)
    const selected = target({
      connectionId: input.connectionId,
      database: input.database,
      collection: input.collection,
    })
    const catalog = await this.catalog(live, selected)
    const name = input.operation === 'create' ? input.spec.name : input.name
    const existing = catalog.indexes.find((index) => index.name === name)
    if (input.operation === 'create' ? existing : !existing)
      throw new Error(
        input.operation === 'create'
          ? 'This index name already exists. Existing indexes are never overwritten by create.'
          : 'The selected index no longer exists. Reload the catalog.',
      )
    const options: Document = {}
    const warnings = [
      ...catalog.warnings,
      'The collection identity and index definitions are checked again immediately before execution. MongoDB has no atomic compare-and-swap operation for index DDL; concurrent administrators can still race that check.',
      'The driver does not retry this operation. Timeout or connection loss can leave an uncertain outcome; inspect the catalog before deciding what to do next.',
    ]
    const owner = `db.getSiblingDB(${JSON.stringify(selected.database)}).getCollection(${JSON.stringify(selected.collection)})`
    let command: string
    if (input.operation === 'create') {
      Object.assign(options, {
        name: input.spec.name,
        unique: input.spec.unique,
        sparse: input.spec.sparse,
        hidden: input.spec.hidden,
      })
      if (input.spec.expireAfterSeconds !== undefined) {
        options.expireAfterSeconds = input.spec.expireAfterSeconds
        warnings.push(
          'TTL WARNING: this index enables automatic server deletion of expired documents, including existing data. Hiding the index or later enabling Harbor read-only mode does not stop TTL deletion.',
        )
      }
      if (input.spec.partialFilter) {
        options.partialFilterExpression = this.parseFilter(input.spec.partialFilter)
        this.validateFilter(options.partialFilterExpression)
      }
      if (input.spec.unique)
        warnings.push(
          'Unique index creation scans existing data and fails if duplicate keys exist; successful creation rejects future duplicate writes.',
        )
      warnings.push(
        'An index build scans collection data and consumes server resources; server replication/commit-quorum rules apply.',
      )
      command = `${owner}.createIndex(${JSON.stringify(Object.fromEntries(input.spec.keys.map((key) => [key.field, key.direction])))}, EJSON.parse(${JSON.stringify(encode(options))}));`
    } else {
      command = `${owner}.dropIndex(${JSON.stringify(name)});`
      warnings.push(
        `Dropping this index can change query performance${existing?.unique ? ' and remove a uniqueness constraint' : ''}${existing?.expireAfterSeconds !== undefined ? ' and disable this TTL policy' : ''}.`,
      )
    }
    for (const [token, review] of this.reviews)
      if (review.expires < Date.now() || review.live.closed) this.reviews.delete(token)
    if (this.reviews.size >= 20)
      throw new Error(
        'Close or wait for an existing index review to expire before preparing more than 20 reviews.',
      )
    const token = randomUUID(),
      expires = Date.now() + 120000
    this.reviews.set(token, { live, input, fingerprint: this.fingerprint(catalog), expires, options })
    return {
      token,
      expiresAt: new Date(expires).toISOString(),
      target: selected,
      operation: input.operation,
      name,
      command,
      confirmation: mongoIndexConfirmation(input, live.profile),
      warnings,
    }
  }
  async execute(live: IndexConnection, raw: MongoIndexExecuteInput): Promise<MongoIndexResult> {
    const input = mongoIndexExecuteSchema.parse(raw)
    const review = this.reviews.get(input.token)
    if (
      !review ||
      review.live !== live ||
      input.connectionId !== live.profile.id ||
      review.expires <= Date.now() ||
      live.closed
    )
      throw new Error('This index review expired or belongs to another connection. Prepare it again.')
    if (live.profile.readOnly)
      throw new Error(
        'This MongoDB connection is read-only. Index administration requires explicitly enabled writes.',
      )
    if (input.confirm !== mongoIndexConfirmation(review.input, live.profile))
      throw new Error('The exact index target confirmation does not match.')
    this.reviews.delete(input.token)
    const selected = target({
      connectionId: input.connectionId,
      database: review.input.database,
      collection: review.input.collection,
    })
    const catalog = await this.catalog(live, selected)
    if (this.fingerprint(catalog) !== review.fingerprint)
      throw new Error(
        'The collection or index catalog changed after review. No DDL was submitted; inspect and prepare a new review.',
      )
    const collection = live.client
      .db(selected.database)
      .collection(selected.collection, {
        writeConcern: { w: 'majority', wtimeoutMS: live.profile.queryTimeout },
      })
    const name = review.input.operation === 'create' ? review.input.spec.name : review.input.name
    try {
      if (review.input.operation === 'create')
        await collection.createIndex(
          Object.fromEntries(review.input.spec.keys.map((key) => [key.field, key.direction])),
          { ...review.options, name, maxTimeMS: live.profile.queryTimeout },
        )
      else await collection.dropIndex(name, { maxTimeMS: live.profile.queryTimeout })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : undefined
      if ([13, 18, 27, 67, 68, 85, 86, 11000].includes(code || 0))
        throw new Error(
          code === 11000
            ? 'Index creation failed because existing values violate uniqueness. No automatic retry occurred.'
            : `MongoDB rejected the index operation (code ${code}). Check permissions and the current catalog; no retry occurred.`,
          { cause: error },
        )
      throw new Error(
        'Index operation outcome is uncertain after a server error, timeout or connection failure. Inspect the current catalog before preparing another operation; Harbor did not replay it.',
        { cause: error },
      )
    }
    return {
      operation: review.input.operation,
      name,
      acknowledged: true,
      warnings: [
        'MongoDB acknowledged this index operation. It is not part of a transaction and has no automatic undo. Reload the index catalog to inspect the current definitions.',
      ],
    }
  }
}
