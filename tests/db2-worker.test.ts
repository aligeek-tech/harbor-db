import { describe, expect, it, vi } from 'vitest'
import {
  Db2WorkerRuntime,
  type Db2NativeDriver,
  type Db2NativeResult,
} from '../src/main/engines/db2-worker-runtime'
import type { Db2Response } from '../src/main/engines/db2-protocol'

function fixture(type = 'BIGINT', code = -5, rows: unknown[][] = [['9223372036854775807']]) {
  let offset = 0
  const result: Db2NativeResult = {
    getColumnMetadataSync: () => [
      {
        index: 1,
        SQL_DESC_NAME: 'A',
        SQL_DESC_TYPE_NAME: type,
        SQL_DESC_CONSIZE_TYPE: code,
        SQL_DESC_LENGTH: type === 'VARCHAR' ? 1022 : 19,
        SQL_DESC_DISPLAY_SIZE: 20,
      },
    ],
    fetchSync: vi.fn(() => rows[offset++] ?? null),
    getSQLErrorSync: () => null,
    closeSync: vi.fn(),
  }
  const statement = { setAttrSync: vi.fn(() => true), executeSync: vi.fn(() => result), closeSync: vi.fn() }
  const connection = {
    getInfoSync: (id: number): string | number =>
      id === 17 ? 'DB2/LINUXX8664' : id === 18 ? '12.01.0000' : 1208,
    prepareSync: vi.fn(() => statement),
    closeSync: vi.fn(),
  }
  const driver: Db2NativeDriver = { openSync: vi.fn(() => connection) }
  const output: Db2Response[] = []
  const runtime = new Db2WorkerRuntime(
    async (message) => {
      output.push(message)
    },
    () => driver,
  )
  const open = () => runtime.handle({ id: 1, action: 'open', connectionString: 'disposable', timeout: 1500 })
  return { runtime, output, result, statement, connection, driver, open }
}
const query = {
  id: 2,
  action: 'query' as const,
  sql: 'SELECT ID FROM T',
  parameters: [],
  maxRows: 1,
  timeout: 1000,
}
describe('Db2 child protocol using a driver double; not Db2 native acceptance', () => {
  it('caps the aggregate display payload even when the requested row count is higher', async () => {
    const f = fixture()
    const row = Array.from({ length: 128 }, () => Buffer.alloc(511, 65))
    f.result.getColumnMetadataSync = () =>
      row.map((_, index) => ({
        index: index + 1,
        SQL_DESC_NAME: `B${index}`,
        SQL_DESC_TYPE_NAME: 'VARBINARY',
        SQL_DESC_CONSIZE_TYPE: -3,
        SQL_DESC_LENGTH: 511,
        SQL_DESC_DISPLAY_SIZE: 1022,
      }))
    let remaining = 200
    f.result.fetchSync = () => (remaining-- > 0 ? row : null)
    await f.open()
    await f.runtime.handle({ ...query, maxRows: 10000 })
    const set = f.output.at(-1)?.set
    expect(set?.truncated).toBe(true)
    expect(set!.rows.length).toBeGreaterThan(50)
    expect(set!.rows.length).toBeLessThan(120)
    expect(
      set!.rows.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0),
    ).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
  it('sets connection/query deadlines, keeps exact BIGINT and closes handles after bounded lookahead', async () => {
    const f = fixture('BIGINT', -5, [['9223372036854775807'], ['2']])
    await f.open()
    await f.runtime.handle(query)
    expect(f.driver.openSync).toHaveBeenCalledWith('disposable', { connectTimeout: 2 })
    expect(f.statement.setAttrSync).toHaveBeenCalledWith(0, 1)
    expect(f.output.at(-1)?.set).toMatchObject({ rows: [['9223372036854775807']], truncated: true })
    expect(f.result.fetchSync).toHaveBeenCalledTimes(2)
    expect(f.result.closeSync).toHaveBeenCalledOnce()
    expect(f.statement.closeSync).toHaveBeenCalledOnce()
  })
  it('never fetches DECIMAL or raw VARCHAR and never executes mutation SQL', async () => {
    for (const [type, code] of [
      ['DECIMAL', 3],
      ['VARCHAR', 12],
    ] as const) {
      const f = fixture(type, code)
      await f.open()
      await f.runtime.handle(query)
      expect(f.output.at(-1)?.error).toMatch(/lossless projection/)
      expect(f.result.fetchSync).not.toHaveBeenCalled()
    }
    const f = fixture()
    await f.open()
    await f.runtime.handle({ ...query, sql: 'CALL secret_procedure()' })
    expect(f.connection.prepareSync).not.toHaveBeenCalled()
  })
  it('waits for one acknowledgement per column/row and ignores wrong acknowledgements', async () => {
    const f = fixture()
    await f.open()
    const execution = f.runtime.handle({ ...query, stream: true })
    await vi.waitFor(() => expect(f.output.at(-1)?.stream?.columns).toHaveLength(1))
    expect(f.result.fetchSync).not.toHaveBeenCalled()
    await f.runtime.handle({ id: 5, action: 'ack', target: 999 })
    expect(f.result.fetchSync).not.toHaveBeenCalled()
    await f.runtime.handle({ id: 6, action: 'ack', target: 2 })
    await vi.waitFor(() => expect(f.output.at(-1)?.stream?.row).toEqual(['9223372036854775807']))
    expect(f.result.fetchSync).toHaveBeenCalledTimes(1)
    await f.runtime.handle({ id: 7, action: 'ack', target: 2 })
    await execution
    expect(f.output.at(-1)?.set?.rows).toEqual([])
  })
  it('refuses truncated native data and strips native SQL/password text, including errors without SQLSTATE', async () => {
    const f = fixture()
    await f.open()
    f.result.getSQLErrorSync = () => ({ state: '01004', message: 'secret' })
    await f.runtime.handle(query)
    expect(f.output.at(-1)?.error).toMatch(/potentially truncated/)
    for (const error of [
      Object.assign(new Error('PASSWORD=secret; SQL=secret'), { state: '08001' }),
      new Error('transformed secret'),
    ]) {
      f.connection.prepareSync.mockImplementationOnce(() => {
        throw error
      })
      await f.runtime.handle({ ...query, id: 3 })
      expect(f.output.at(-1)?.error).not.toContain('secret')
      expect(f.output.at(-1)?.fatal).toBe(true)
    }
  })
  it('checks actual product, version and database encoding at every physical connection', async () => {
    for (const [product, version, codepage] of [
      ['DB2', '12.01.0000', 1208],
      ['DB2/AS400', '12.01.0000', 1208],
      ['DB2/LINUXX8664', '10.05.0000', 1208],
      ['DB2/LINUXX8664', '12.01.0000', 1252],
    ] as const) {
      const f = fixture()
      f.connection.getInfoSync = (id) => (id === 17 ? product : id === 18 ? version : codepage)
      await f.open()
      expect(f.output.at(-1)?.fatal).toBe(true)
    }
  })
})
