import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'

const caFile = process.env.HARBOR_MYSQL_TLS_CA
const enabled = process.env.HARBOR_MANAGED_POLICY === '1' && !!caFile
const service = new SqlService()

describe.skipIf(!enabled)('managed policy hooks against local MySQL TLS (not cloud acceptance)', () => {
  afterAll(() => service.closeAll())
  it('verifies trusted TLS and expires only fresh physical sessions while preserving authenticated sessions', async () => {
    const now = Date.now()
    const profile = profileSchema.parse({
      id: 'managed-native',
      name: 'Local policy fixture',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 13307,
      database: 'harbor',
      username: 'harbor',
      readOnly: true,
      tls: { enabled: true, rejectUnauthorized: true, ca: readFileSync(caFile!, 'utf8') },
      managed: {
        provider: 'cloudsql-mysql',
        authentication: 'temporary-password',
        expiresAt: new Date(now + 60000).toISOString(),
      },
    })
    expect(await service.connect(profile, { password: 'harbor_test' })).toMatchObject({ state: 'connected' })
    const query = (sessionId: string) =>
      service.execute({
        connectionId: profile.id,
        sessionId,
        requestId: crypto.randomUUID(),
        sql: 'SELECT 42 AS answer',
        maxRows: 1,
        privateSession: true,
      })
    expect((await query('existing')).sets[0].rows).toEqual([['42']])
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120000)
    try {
      expect((await query('existing')).sets[0].rows).toEqual([['42']])
      await expect(query('fresh')).rejects.toThrow(/expired/)
      await service.disconnect(profile.id)
      expect(await service.connect(profile, { password: 'harbor_test' })).toMatchObject({
        state: 'failed',
        error: expect.stringMatching(/expired/),
      })
    } finally {
      clock.mockRestore()
      await service.disconnect(profile.id)
    }
    expect(
      await service.connect(
        {
          ...profile,
          id: 'bad-ca',
          managed: { ...profile.managed, authentication: 'password' },
          tls: { ...profile.tls, ca: '' },
        },
        { password: 'harbor_test' },
      ),
    ).toMatchObject({ state: 'failed' })
    expect(
      await service.connect(
        { ...profile, id: 'weak-tls', tls: { ...profile.tls, rejectUnauthorized: false } },
        { password: 'harbor_test' },
      ),
    ).toMatchObject({ state: 'failed', error: expect.stringMatching(/certificate and hostname/) })
  })
})
