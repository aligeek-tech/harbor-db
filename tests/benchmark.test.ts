import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { RedisService } from '../src/main/engines/redis'
import { profileSchema } from '../src/shared/contracts'

test.skipIf(process.env.HARBOR_BENCHMARK !== '1')(
  'bounded pages against the seeded 100,000-row tables and 100,000-key Redis database',
  async () => {
    const sql = new SqlService()
    const redis = new RedisService()
    const observations: Record<string, unknown>[] = []
    try {
      for (const engine of ['postgres', 'mariadb'] as const) {
        const profile = profileSchema.parse({
          id: `benchmark-${engine}`,
          name: 'Local benchmark',
          engine,
          host: '127.0.0.1',
          port: engine === 'postgres' ? 15432 : 13306,
          username: 'harbor',
          database: 'harbor',
          schema: engine === 'postgres' ? 'public' : 'harbor',
          readOnly: true,
        })
        await sql.connect(profile, { password: 'harbor_test' })
        const start = performance.now()
        const result = await sql.table({
          connectionId: profile.id,
          sessionId: 'benchmark-page',
          schema: profile.schema,
          table: 'orders',
          offset: 0,
          limit: 200,
          direction: 'asc',
        })
        expect(result.sets[0].rows).toHaveLength(200)
        observations.push({
          engine,
          seededRows: 100000,
          loadedRows: result.sets[0].rows.length,
          elapsedMs: Number((performance.now() - start).toFixed(2)),
          ipcBytes: Buffer.byteLength(JSON.stringify(result)),
        })
      }
      const profile = profileSchema.parse({
        id: 'benchmark-redis',
        name: 'Local Redis benchmark',
        engine: 'redis',
        host: '127.0.0.1',
        port: 16379,
        readOnly: true,
      })
      await redis.connect(profile, { password: 'harbor_test' })
      const start = performance.now()
      const page = await redis.scan({
        connectionId: profile.id,
        cursor: '0',
        pattern: 'harbor:benchmark:*',
        count: 200,
      })
      expect(page.keys.length).toBeGreaterThan(0)
      observations.push({
        engine: 'redis',
        seededKeys: 100000,
        countHint: 200,
        returnedKeys: page.keys.length,
        elapsedMs: Number((performance.now() - start).toFixed(2)),
        ipcBytes: Buffer.byteLength(JSON.stringify(page)),
        complete: page.cursor === '0',
      })
      await writeFile(
        join(tmpdir(), 'harbor-benchmark.json'),
        JSON.stringify(
          { node: process.version, platform: process.platform, arch: process.arch, observations },
          null,
          2,
        ),
      )
    } finally {
      await sql.closeAll()
      await redis.closeAll()
    }
  },
)
