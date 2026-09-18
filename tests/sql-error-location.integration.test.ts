import { afterAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('real PostgreSQL error locations', () => {
  const service = new SqlService()
  const profile = profileSchema.parse({
    id: 'postgres-error-location',
    name: 'Error location',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'harbor',
    database: 'harbor',
    readOnly: false,
  })
  afterAll(() => service.closeAll())
  it('returns only a UTF-16 position and clears it on the next operation', async () => {
    expect((await service.connect(profile, { password: 'harbor_test' })).state).toBe('connected')
    const input = {
      connectionId: profile.id,
      sessionId: 'error',
      requestId: crypto.randomUUID(),
      maxRows: 10,
      privateSession: true,
    }
    const sql = "SELECT '🙂' AS first, FROM missing"
    await expect(service.execute({ ...input, sql })).rejects.toThrow('syntax error')
    expect(service.getSessionState(input).errorLocation).toEqual({ position: sql.indexOf('FROM') + 1 })
    await service.execute({ ...input, requestId: crypto.randomUUID(), sql: 'SELECT 1' })
    expect(service.getSessionState(input).errorLocation).toBeUndefined()
  })
})
