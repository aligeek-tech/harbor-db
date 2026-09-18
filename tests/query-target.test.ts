import { describe, expect, it } from 'vitest'
import { profileSchema } from '../src/shared/contracts'
import { boundQueryTarget, compatibleQueryTarget } from '../src/shared/query-target'

const profiles = ['redis', 'postgres', 'mariadb', 'mongodb'].map((engine) => profileSchema.parse({
  id: engine, engine, name: engine, host: '127.0.0.1', port: 1,
}))
describe('saved query targeting', () => {
  it('does not fall back for unbound, removed or incompatible bindings', () => {
    for (const connectionId of [undefined, 'deleted', 'redis']) {
      expect(boundQueryTarget({ name: 'q', sql: 'SELECT 1', engine: 'postgres', connectionId }, profiles)).toBeUndefined()
    }
    expect(boundQueryTarget({ name: 'q', sql: 'SELECT 1', engine: 'postgres', connectionId: 'postgres' }, profiles)?.id).toBe('postgres')
  })
  it('keeps SQL dialects separate and unknown SQL files away from command/document engines', () => {
    expect(profiles.filter((profile) => compatibleQueryTarget({ name: 'q', sql: 'SELECT 1', engine: 'mariadb' }, profile)).map((p) => p.id)).toEqual(['mariadb'])
    expect(profiles.filter((profile) => compatibleQueryTarget({ name: 'q', sql: 'SELECT 1' }, profile)).map((p) => p.id)).toEqual(['postgres', 'mariadb'])
  })
})
