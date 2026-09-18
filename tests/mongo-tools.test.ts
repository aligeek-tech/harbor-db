import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { parseConnectionUrl } from '../src/shared/connection-uri'
import { mongoConnectionUri, validateMongoProfile } from '../src/main/engines/mongo-config'
import {
  mongoIndexPreviewSchema,
  mongoIndexSpecSchema,
  mongoIndexConfirmation,
} from '../src/shared/mongo-tools'
import { parseMongoPipeline, renderMongoPipeline } from '../src/shared/mongo-pipeline'
import { parseMongoJson } from '../src/main/engines/mongo'

const profile = () =>
  profileSchema.parse({
    id: 'mongo-unit',
    name: 'Mongo fixture',
    engine: 'mongodb',
    host: 'localhost',
    port: 27017,
  })
describe('MongoDB explicit topology configuration', () => {
  it('preserves seed order, SCRAM, preference, credentials and required TLS from a URI', () => {
    const parsed = parseConnectionUrl(
      'mongodb://alice:p%40ss@one.example:27018,two.example:27019/app?replicaSet=rs&authSource=admin&authMechanism=SCRAM-SHA-256&readPreference=secondaryPreferred&tls=true&retryWrites=false',
    )
    expect(parsed.profile.mongo).toEqual({
      srv: false,
      seeds: [{ host: 'two.example', port: 27019 }],
      replicaSet: 'rs',
      authSource: 'admin',
      authMechanism: 'SCRAM-SHA-256',
      readPreference: 'secondaryPreferred',
      directConnection: false,
    })
    expect(parsed.password).toBe('p@ss')
    expect(parsed.profile.tls?.rejectUnauthorized).toBe(true)
    expect(JSON.stringify(parsed.profile)).not.toContain('p@ss')
  })
  it('keeps SRV defaults and rejects unsupported options and ambiguous topology', () => {
    const parsed = parseConnectionUrl('mongodb+srv://alice:pass@cluster.example/app')
    expect(parsed.profile.mongo).toMatchObject({
      srv: true,
      authSource: 'admin',
      seeds: [],
      authMechanism: 'DEFAULT',
      readPreference: 'primary',
    })
    for (const uri of [
      'mongodb://one,two/?directConnection=true',
      'mongodb+srv://cluster.example/?tls=false',
      'mongodb+srv://cluster.example:1234/',
      'mongodb://one/?retryWrites=true',
      'mongodb://one/?readPreference=invalid',
      'mongodb://one/?authMechanism=MONGODB-X509',
      'mongodb://one,one/',
      'mongodb://one/?appName=ignored',
    ])
      expect(() => parseConnectionUrl(uri)).toThrow()
  })
  it('formats IPv6 seeds and rejects unsafe discovery through one SSH tunnel', () => {
    const input = profile()
    input.host = '::1'
    input.mongo.seeds = [{ host: 'example.test', port: 27018 }]
    expect(mongoConnectionUri(input, { host: '::1', port: 27017 })).toBe(
      'mongodb://[::1]:27017,example.test:27018/',
    )
    input.ssh.enabled = true
    expect(() => validateMongoProfile(input)).toThrow(/SSH/)
    input.ssh.enabled = false
    input.mongo.directConnection = true
    expect(() => validateMongoProfile(input)).toThrow(/direct/)
  })
})
describe('MongoDB index review inputs', () => {
  it('preserves compound order and requires explicit TTL confirmation', () => {
    const spec = mongoIndexSpecSchema.parse({
      name: 'expires',
      keys: [{ field: 'expiresAt', direction: 1 }],
      expireAfterSeconds: 0,
    })
    const input = mongoIndexPreviewSchema.parse({
      connectionId: 'a',
      database: 'app',
      collection: 'events',
      operation: 'create',
      spec,
    })
    expect(mongoIndexConfirmation(input, { name: 'Production cluster', environment: 'production' })).toBe(
      'CREATE TTL INDEX app.events/expires on Production cluster',
    )
    expect(
      mongoIndexSpecSchema
        .parse({
          name: 'compound',
          keys: [
            { field: 'z', direction: -1 },
            { field: 'a', direction: 1 },
          ],
        })
        .keys.map((key) => key.field),
    ).toEqual(['z', 'a'])
  })
  it('rejects dangerous or invalid index specifications before submission', () => {
    const cases = [
      { name: '_id_', keys: [{ field: 'x', direction: 1 }] },
      { name: 'x', keys: [{ field: 'x', direction: 'hashed' }], unique: true },
      {
        name: 'x',
        keys: [
          { field: 'x', direction: 1 },
          { field: 'x', direction: -1 },
        ],
      },
      {
        name: 'x',
        keys: [
          { field: 'x', direction: 1 },
          { field: 'y', direction: 1 },
        ],
        expireAfterSeconds: 60,
      },
      { name: 'x', keys: [{ field: 'x', direction: 1 }], sparse: true, partialFilter: '{}' },
    ]
    for (const value of cases) expect(mongoIndexSpecSchema.safeParse(value).success).toBe(false)
    expect(
      mongoIndexPreviewSchema.safeParse({
        connectionId: 'a',
        database: 'app',
        collection: 'events',
        operation: 'drop',
        name: '*',
      }).success,
    ).toBe(false)
  })
})
describe('MongoDB aggregation builder', () => {
  it('rejects unsafe plain integer input before native BSON conversion', () => {
    expect(() => parseMongoJson('{"id":9223372036854775807}')).toThrow(/numberLong/)
    expect(() => parseMongoJson('{"id":1e100}')).toThrow(/numberLong/)
    expect(() => parseMongoJson('{"id":1,"id":2}')).toThrow(/duplicate/)
    expect(() => parseMongoJson('{"id":{"$numberLong":"9223372036854775807"}}')).not.toThrow()
  })
  it('keeps exact numeric text and Extended JSON while ordering and omitting disabled stages', () => {
    const stages = parseMongoPipeline(
      '[{"$match":{"id":9223372036854775807,"price":{"$numberDecimal":"1.234567890123456789"}}},{"$limit":10}]',
    )
    expect(stages[0].body).toContain('9223372036854775807')
    stages[1].enabled = false
    const rendered = renderMongoPipeline(stages)
    expect(rendered).toContain('9223372036854775807')
    expect(rendered).toContain('1.234567890123456789')
    expect(rendered).not.toContain('$limit')
  })
  it('rejects writes, server JavaScript, duplicate keys and excessive stage counts', () => {
    for (const source of [
      '[{"$out":"other"}]',
      '[{"$match":{"$where":"code"}}]',
      '[{"$facet":{"inner":[{"$merge":"other"}]}}]',
      '[{"$match":{},"$limit":1}]',
      '[{"$match":{"x":1,"x":2}}]',
      JSON.stringify(Array.from({ length: 101 }, () => ({ $limit: 1 }))),
    ])
      expect(() => parseMongoPipeline(source)).toThrow()
    expect(() => renderMongoPipeline([{ operator: '$function', body: '{}', enabled: true }])).toThrow(
      /unavailable/,
    )
  })
})
