import { afterAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'
import type { QueryParameter } from '../src/shared/parameters'

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('real native driver parameter binding', () => {
  const sql = new SqlService()
  afterAll(() => sql.closeAll())
  for (const engine of ['postgres', 'mariadb'] as const) {
    it(`${engine}: exact values, injection resistance, ordered duplicates and private errors`, async () => {
      const profile = profileSchema.parse({ id: `parameters-${engine}`, name: engine, engine, host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : 13306, username: 'harbor', database: 'harbor', readOnly: true })
      await sql.connect(profile, { password: 'harbor_test' })
      const parameters: QueryParameter[] = [
        { name: 'big', type: 'integer', value: '9007199254740993', secret: false },
        { name: 'amount', type: 'decimal', value: '12345678901234567890.123456789', secret: false },
        { name: 'text', type: 'text', value: "'; SELECT 99; --", secret: false },
        { name: 'binary', type: 'binary', value: 'AP+A', secret: false },
      ]
      const base = { connectionId: profile.id, sessionId: 'parameters', requestId: crypto.randomUUID(), maxRows: 1000, privateSession: true }
      const result = await sql.execute({ ...base, parameters, sql: engine === 'postgres'
        ? 'SELECT $1::bigint AS duplicate, $2::numeric(30,9) AS duplicate, $3::text AS text, $4::bytea AS bytes'
        : 'SELECT CAST(? AS SIGNED) AS duplicate, CAST(? AS DECIMAL(30,9)) AS duplicate, ? AS text, ? AS bytes' })
      expect(result.sets[0].rows[0]).toEqual(['9007199254740993', '12345678901234567890.123456789', "'; SELECT 99; --", { type: 'binary', base64: 'AP+A' }])
      expect(result.sets[0].columns.slice(0, 2).map((c) => c.name)).toEqual(['duplicate', 'duplicate'])
      await expect(sql.execute({ ...base, requestId: crypto.randomUUID(), sql: 'SELECT no_such_function(' + (engine === 'postgres' ? '$1' : '?') + ')',
        parameters: [{ name: 'private', type: 'text', value: 'private-in-error', secret: true }] })).rejects.toThrow('Query failed while using a private parameter')
      await expect(sql.execute({ ...base, sql: 'SELECT 1; SELECT 2', parameters })).rejects.toThrow('exactly one statement')
    })
  }
})
