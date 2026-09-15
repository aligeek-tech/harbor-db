import { describe, expect, it } from 'vitest'
import { BSON } from 'mongodb'
import { parseMongoJson, validateMongoRead } from '../src/main/engines/mongo'
import { mongoReadSchema, profileSchema } from '../src/shared/contracts'
import { compareCells } from '../src/shared/result-sort'

describe('MongoDB input contracts', () => {
  it('preserves canonical BSON types', () => {
    const document = parseMongoJson(
      '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"n":{"$numberLong":"9223372036854775807"},"date":{"$date":{"$numberLong":"0"}}}',
    ) as BSON.Document
    expect(document._id).toBeInstanceOf(BSON.ObjectId)
    expect(document.n).toBeInstanceOf(BSON.Long)
    expect(document.n.toString()).toBe('9223372036854775807')
    expect(document.date).toBeInstanceOf(Date)
  })
  it.each(['null', '[]', '12', '"text"', '{"$oid":"507f1f77bcf86cd799439011"}', '{'])(
    'rejects non-document input %s',
    (input) => {
      expect(() => parseMongoJson(input)).toThrow()
    },
  )
  it.each(['$out', '$merge', '$where', '$function', '$accumulator', '$changeStream'])(
    'rejects %s even inside nested pipelines',
    (operator) => {
      expect(() => validateMongoRead([{ $facet: { nested: [{ [operator]: 'target' }] } }])).toThrow(
        /not supported/,
      )
    },
  )
  it('accepts safe filters and pipelines and bounds IPC reads', () => {
    expect(() =>
      validateMongoRead([{ $match: { n: { $gte: 2 } } }, { $group: { _id: '$name', n: { $sum: 1 } } }]),
    ).not.toThrow()
    const target = { connectionId: 'mongo', database: 'db', collection: 'items' }
    expect(mongoReadSchema.parse(target).limit).toBe(100)
    expect(mongoReadSchema.safeParse({ ...target, limit: 1001 }).success).toBe(false)
    expect(mongoReadSchema.safeParse({ ...target, surprise: true }).success).toBe(false)
    expect(
      profileSchema.parse({
        id: 'old',
        name: 'Existing SQL',
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
      }).mongo.authSource,
    ).toBe('admin')
  })
})

describe('loaded result ordering', () => {
  it('sorts large integers and decimals without precision loss', () => {
    const values = [
      '9007199254740993',
      '0.0000000000000002',
      '-123456789012345678901',
      '0',
      '9007199254740992',
      '-0.1',
      '1e-16',
    ]
    expect(values.sort((a, b) => compareCells(a, b, true))).toEqual([
      '-123456789012345678901',
      '-0.1',
      '0',
      '1e-16',
      '0.0000000000000002',
      '9007199254740992',
      '9007199254740993',
    ])
    expect(compareCells('1.00', '1e0', true)).toBe(0)
    expect(compareCells('-0', '0', true)).toBe(0)
  })
  it('orders nulls and text consistently', () => {
    expect(compareCells(null, 'a', false)).toBeLessThan(0)
    expect(compareCells('z', 'a', false)).toBeGreaterThan(0)
  })
})
