import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db2Service } from '../src/main/engines/db2'
import { profileSchema, tableInputSchema } from '../src/shared/contracts'

// Requires an administrator-provisioned disposable LUW fixture from docs/db2-runtime.md.
// This suite never installs/accepts a CLI license or creates a privileged container.
describe.skipIf(process.env.HARBOR_DB2 !== '1')('native Db2 LUW fixture', () => {
  let service: Db2Service
  const profile = profileSchema.parse({
    id: 'db2-native',
    name: 'Db2 native fixture',
    engine: 'db2',
    host: process.env.HARBOR_DB2_HOST ?? '127.0.0.1',
    port: Number(process.env.HARBOR_DB2_PORT ?? 15000),
    database: process.env.HARBOR_DB2_DATABASE ?? 'HARBOR',
    schema: process.env.HARBOR_DB2_SCHEMA ?? 'HARBOR_B_DB2',
    username: process.env.HARBOR_DB2_USER ?? 'harbor_reader',
    queryTimeout: 10000,
    tls: {
      enabled: process.env.HARBOR_DB2_TLS === '1',
      rejectUnauthorized: true,
      ca: process.env.HARBOR_DB2_CA ?? '',
    },
  })
  beforeEach(async () => {
    if (!process.env.HARBOR_DB2_PASSWORD)
      throw new Error('Supply the explicitly authorized disposable Db2 credential.')
    service = new Db2Service()
    expect(await service.connect(profile, { password: process.env.HARBOR_DB2_PASSWORD })).toMatchObject({
      state: 'connected',
      version: expect.stringMatching(/^DB2\//),
    })
  })
  afterEach(async () => {
    await service?.closeAll()
  })
  it('reads the real product catalog, native primary key and exact projected types', async () => {
    expect(await service.listDatabases(profile.id)).toEqual([profile.database])
    expect(await service.listObjects({ connectionId: profile.id })).toContainEqual(
      expect.objectContaining({ name: 'TYPED_VALUES', schema: profile.schema, kind: 'table' }),
    )
    const input = tableInputSchema.parse({
      connectionId: profile.id,
      sessionId: 'table',
      schema: profile.schema,
      table: 'TYPED_VALUES',
    })
    expect((await service.structure(input)).columns[0]).toMatchObject({
      name: 'ID',
      primaryKey: true,
      type: 'BIGINT',
    })
    const result = await service.table(input)
    expect(result.sets[0].rows[0]).toEqual([
      '9223372036854775807',
      '9007199254740993.12345678',
      '2026-09-18-12.13.14.123456789012',
      'سلام\0🙂',
      { type: 'binary', base64: 'AP8=' },
      null,
    ])
  })
  it('preserves duplicate names and bound integer values while refusing unsafe raw decimal/text output', async () => {
    const base = {
      connectionId: profile.id,
      sessionId: 'query',
      requestId: 'q',
      maxRows: 10,
      privateSession: false,
    }
    const result = await service.execute({
      ...base,
      sql: 'SELECT CAST(? AS BIGINT) AS DUPLICATE, CAST(? AS BIGINT) AS DUPLICATE FROM SYSIBM.SYSDUMMY1',
      parameters: [
        { name: 'a', type: 'integer', value: '9223372036854775807', secret: false },
        { name: 'b', type: 'integer', value: '-9223372036854775808', secret: false },
      ],
    })
    expect(result.sets[0].columns.map((column) => column.name)).toEqual(['DUPLICATE', 'DUPLICATE'])
    expect(result.sets[0].rows).toEqual([['9223372036854775807', '-9223372036854775808']])
    for (const sql of [
      'SELECT CAST(1 AS DECIMAL(31,8)) FROM SYSIBM.SYSDUMMY1',
      "SELECT 'raw text' FROM SYSIBM.SYSDUMMY1",
    ])
      await expect(service.execute({ ...base, sql })).rejects.toThrow(/lossless projection/)
    await expect(
      service.execute({
        ...base,
        sql: 'CALL SYSPROC.ADMIN_CMD(?)',
        parameters: [{ name: 'private', type: 'text', value: 'not-to-be-logged', secret: true }],
      }),
    ).rejects.toThrow(/guarded/)
  })
  it('streams all real rows with awaited backpressure and closes on abort', async () => {
    const controller = new AbortController(),
      rows: unknown[][] = []
    let active = 0,
      peak = 0
    await service.streamQuery(
      {
        connectionId: profile.id,
        sql: 'SELECT 1 AS N FROM SYSIBM.SYSDUMMY1 UNION ALL SELECT 2 FROM SYSIBM.SYSDUMMY1',
      },
      {
        signal: controller.signal,
        onColumns: async (columns) => {
          expect(columns).toHaveLength(1)
        },
        onRow: async (row) => {
          peak = Math.max(peak, ++active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          rows.push(row)
          active--
        },
      },
    )
    expect(rows).toEqual([[1], [2]])
    expect(peak).toBe(1)
    const abort = new AbortController()
    await expect(
      service.streamQuery(
        { connectionId: profile.id, sql: 'SELECT 1 AS N FROM SYSIBM.SYSDUMMY1' },
        {
          signal: abort.signal,
          onColumns: async () => {},
          onRow: async () => {
            abort.abort()
          },
        },
      ),
    ).rejects.toThrow(/unconfirmed|cancel|consumer/i)
  })
})
