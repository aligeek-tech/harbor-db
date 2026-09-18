import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import oracledb from 'oracledb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { oracleExactProjection } from '../src/main/engines/oracle-values'
import { OracleService } from '../src/main/engines/oracle'
import { profileSchema } from '../src/shared/contracts'
import { oracleQuote } from '../src/shared/oracle'

const enabled = process.env.HARBOR_ORACLE === '1'
const service = new OracleService(),
  id = 'oracle-' + randomUUID(),
  suffix = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(),
  table = 'HARBOR_' + suffix,
  parent = 'HP_' + suffix,
  procedure = 'PROC_' + suffix
const profile = profileSchema.parse({
    id,
    name: 'Disposable Oracle',
    engine: 'oracle',
    host: '127.0.0.1',
    port: 25421,
    username: 'HARBOR_VERIFY',
    database: 'FREEPDB1',
    schema: 'HARBOR_VERIFY',
    readOnly: false,
    queryTimeout: 15000,
  }),
  schema = profile.schema
let password = '',
  admin: oracledb.Connection
const execute = (
  sql: string,
  sessionId = 'query',
  extra: Partial<Parameters<typeof service.execute>[0]> = {},
) =>
  service.execute({
    connectionId: id,
    sessionId,
    requestId: randomUUID(),
    sql,
    maxRows: 100,
    privateSession: true,
    ...extra,
  })
const q = oracleQuote
const tz = (expression: string) => oracleExactProjection(expression, 'TIMESTAMP(9) WITH TIME ZONE')
describe.skipIf(!enabled)('real Oracle Thin adapter against isolated Free 23.26 fixture', () => {
  beforeAll(async () => {
    const path = process.env.HARBOR_ORACLE_FIXTURE_ENV
    if (!path) throw new Error('Set the external disposable Oracle fixture env-file path.')
    password = /^ORACLE_TEST_PASSWORD=(.+)$/m.exec(await readFile(path, 'utf8'))?.[1] ?? ''
    if (!password) throw new Error('Disposable Oracle test credential missing.')
    admin = await oracledb.getConnection({
      user: profile.username,
      password,
      connectString: '127.0.0.1:25421/FREEPDB1',
    })
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toMatch(/^Oracle 23\./)
    expect(oracledb.thin).toBe(true)
    await admin.execute(
      `CREATE TABLE ${q(parent)} (A NUMBER(20) NOT NULL,B NUMBER(20) NOT NULL,CONSTRAINT ${q('PK_' + suffix)} PRIMARY KEY (A,B))`,
    )
    await admin.execute(
      `CREATE TABLE ${q(table)} (ID NUMBER(20) PRIMARY KEY,AMOUNT NUMBER(38,9),LABEL VARCHAR2(200),PAYLOAD BLOB,NOTE CLOB,CREATED TIMESTAMP(9) WITH TIME ZONE,PA NUMBER(20),PB NUMBER(20),CONSTRAINT ${q('FK_' + suffix)} FOREIGN KEY (PA,PB) REFERENCES ${q(parent)} (A,B))`,
    )
    await admin.execute(
      `INSERT INTO ${q(table)} (ID,AMOUNT,LABEL,PAYLOAD,NOTE,CREATED) VALUES(9007199254740993,12345678901234567890.123456789,NULL,HEXTORAW('00FF80'),TO_CLOB('hello'),TO_TIMESTAMP_TZ('2026-09-18T12:34:56.123456789+03:30','YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM'))`,
      {},
      { autoCommit: true },
    )
  }, 60000)
  afterAll(async () => {
    await service.closeAll()
    if (admin) {
      for (const [kind, name] of [
        ['PROCEDURE', procedure],
        ['TABLE', table],
        ['TABLE', parent],
      ])
        try {
          await admin.execute(`DROP ${kind} ${q(name)}${kind === 'TABLE' ? ' PURGE' : ''}`)
        } catch {
          /* A failed setup may not have created this object. */
        }
      await admin.close()
    }
  }, 30000)
  it('preserves NUMBER precision, timestamp nanoseconds/offset, BLOB/CLOB, null and duplicate column labels', async () => {
    const result = await execute(
      `SELECT ID,AMOUNT,LABEL,PAYLOAD,NOTE,${tz('CREATED')} AS CREATED FROM ${q(table)} WHERE ID=9007199254740993`,
    )
    expect(result.sets[0].rows[0]).toEqual([
      '9007199254740993',
      '12345678901234567890.123456789',
      null,
      { type: 'binary', base64: 'AP+A' },
      'hello',
      '2026-09-18T12:34:56.123456789+03:30 [+03:30]',
    ])
    const duplicate = await execute('SELECT 1 AS X,2 AS X FROM DUAL')
    expect(duplicate.sets[0].columns.map((column) => column.name)).toEqual(['X', 'X'])
    expect(duplicate.sets[0].rows).toEqual([['1', '2']])
  })
  it('rejects raw timestamp results instead of silently losing nanoseconds or timezone', async () => {
    await expect(execute(`SELECT CREATED FROM ${q(table)}`)).rejects.toThrow(
      'cannot fetch raw DATE/TIMESTAMP',
    )
  })
  it('executes exact native binds without exposing private conversion values', async () => {
    expect(
      (
        await execute(`SELECT :n AS N,${tz(':t')} AS T FROM DUAL`, 'parameters', {
          parameters: [
            { name: 'n', type: 'integer', secret: true, value: '9007199254740993' },
            { name: 't', type: 'timestamp', secret: false, value: '2026-09-18T00:00:00.123456789Z' },
          ],
        })
      ).sets[0].rows[0],
    ).toEqual(['9007199254740993', '2026-09-18T00:00:00.123456789+00:00 [+00:00]'])
    await expect(
      execute('SELECT TO_NUMBER(:value) FROM DUAL', 'badbind', {
        parameters: [{ name: 'value', type: 'text', secret: true, value: 'DO_NOT_EXPOSE_ORACLE_VALUE' }],
      }),
    ).rejects.not.toThrow('DO_NOT_EXPOSE')
  })
  it('browses the service, owner catalog, composite FK, indexes and server DDL', async () => {
    expect(await service.listDatabases(id)).toEqual(['FREEPDB1'])
    expect(
      (await service.listObjects({ connectionId: id })).some(
        (object) => object.name === table && object.schema === schema,
      ),
    ).toBe(true)
    const structure = await service.structure({ connectionId: id, schema, table })
    expect(structure.columns.find((column) => column.name === 'ID')?.primaryKeyPosition).toBe(1)
    expect(structure.ddl).toContain('CREATE TABLE')
    expect(structure.foreignKeys).toMatchObject([
      {
        columns: ['PA', 'PB'],
        referencedSchema: schema,
        referencedTable: parent,
        referencedColumns: ['A', 'B'],
      },
    ])
    expect(structure.indexes.length).toBeGreaterThan(0)
    const result = await service.table({
      connectionId: id,
      sessionId: 'table',
      schema,
      table,
      offset: 0,
      limit: 10,
      direction: 'asc',
      filters: {
        match: 'all',
        conditions: [{ column: 'ID', operator: 'equals', value: '9007199254740993' }],
      },
    })
    expect(result.sets[0].rows).toHaveLength(1)
    expect(
      (await service.inspectObject({ connectionId: id, schema, name: table, kind: 'table' })).definition
        ?.source,
    ).toBe('server')
  })
  it('isolates transactions on physical tab sessions and rolls back tab close', async () => {
    await service.transaction({ connectionId: id, sessionId: 'tx', action: 'begin' })
    await execute(`INSERT INTO ${q(table)} (ID,LABEL) VALUES(101,'uncommitted')`, 'tx')
    expect((await execute(`SELECT COUNT(*) FROM ${q(table)} WHERE ID=101`, 'other')).sets[0].rows).toEqual([
      ['0'],
    ])
    await expect(execute(`CREATE TABLE ${q('BLOCKED_' + suffix)} (ID NUMBER)`, 'tx')).rejects.toThrow(
      'Finish the open',
    )
    await service.closeSession({ connectionId: id, sessionId: 'tx' })
    expect((await execute(`SELECT COUNT(*) FROM ${q(table)} WHERE ID=101`)).sets[0].rows).toEqual([['0']])
    await service.transaction({ connectionId: id, sessionId: 'committed', action: 'begin' })
    await execute(`INSERT INTO ${q(table)} (ID) VALUES(102)`, 'committed')
    await service.transaction({ connectionId: id, sessionId: 'committed', action: 'commit' })
    expect((await execute(`SELECT COUNT(*) FROM ${q(table)} WHERE ID=102`)).sets[0].rows).toEqual([['1']])
  })
  it('requires reviewed complete PL/SQL and supports program DDL, calls and server source', async () => {
    await expect(execute('BEGIN NULL; END;')).rejects.toThrow('connection name')
    await execute(
      `CREATE OR REPLACE PROCEDURE ${q(procedure)} AS BEGIN INSERT INTO ${q(table)} (ID,LABEL) VALUES(103,q'[semi;colon]'); END;`,
      'plsql',
      { confirm: profile.name },
    )
    await execute(`BEGIN ${q(procedure)}; END;`, 'plsql', { confirm: profile.name })
    expect((await execute(`SELECT LABEL FROM ${q(table)} WHERE ID=103`)).sets[0].rows).toEqual([
      ['semi;colon'],
    ])
    expect(
      (await service.inspectObject({ connectionId: id, schema, name: procedure, kind: 'function' }))
        .definition?.text,
    ).toContain('PROCEDURE')
  })
  it('enforces profile read-only and one service, with real snapshot reads', async () => {
    const readonly = { ...profile, id: id + '-ro', readOnly: true }
    expect((await service.connect(readonly, { password })).state).toBe('connected')
    await expect(
      service.execute({
        connectionId: readonly.id,
        sessionId: 'readonly',
        requestId: randomUUID(),
        sql: `DELETE FROM ${q(table)}`,
        maxRows: 10,
        privateSession: false,
        confirm: readonly.name,
      }),
    ).rejects.toThrow('read-only')
    expect(
      (
        await service.execute({
          connectionId: readonly.id,
          sessionId: 'readonly',
          requestId: randomUUID(),
          sql: 'SELECT 1 FROM DUAL',
          maxRows: 10,
          privateSession: false,
        })
      ).sets[0].rows,
    ).toEqual([['1']])
    await expect(execute('SELECT 1 FROM DUAL', 'mismatch', { database: 'OTHER_SERVICE' })).rejects.toThrow(
      'another service',
    )
  })
  it('bounds loaded rows, streams all rows with backpressure and excludes uncommitted tab writes', async () => {
    expect(
      (await execute('SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL<=1000', 'limited', { maxRows: 5 }))
        .sets[0],
    ).toMatchObject({ truncated: true, rows: [['1'], ['2'], ['3'], ['4'], ['5']] })
    let count = 0
    await service.streamQuery(
      { connectionId: id, sql: 'SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL<=2000' },
      {
        signal: new AbortController().signal,
        onColumns: async (columns) => {
          expect(columns[0].name).toBe('N')
        },
        onRow: async (row) => {
          count++
          expect(row[0]).toBe(String(count))
          if (count % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
        },
      },
    )
    expect(count).toBe(2000)
    await service.transaction({ connectionId: id, sessionId: 'snapshot', action: 'begin' })
    await execute(`INSERT INTO ${q(table)} (ID) VALUES(104)`, 'snapshot')
    let seen: unknown
    await service.streamQuery(
      { connectionId: id, sessionId: 'snapshot', sql: `SELECT COUNT(*) FROM ${q(table)} WHERE ID=104` },
      {
        signal: new AbortController().signal,
        onColumns: async () => {},
        onRow: async (row) => {
          seen = row[0]
        },
      },
    )
    expect(seen).toBe('0')
    await service.transaction({ connectionId: id, sessionId: 'snapshot', action: 'rollback' })
  })
  it('imports exact scalar and binary mappings per batch and rolls back a failed batch', async () => {
    const writer = await service.openImport(
      { connectionId: id, schema, table, columns: ['ID', 'AMOUNT', 'PAYLOAD', 'CREATED'] },
      new AbortController().signal,
    )
    try {
      await writer.writeBatch([
        ['201', '1.123456789', { type: 'binary', base64: 'AP+A' }, '2026-09-18T12:34:56.123456789Z'],
      ])
      await expect(
        writer.writeBatch([
          ['202', '1', null, null],
          ['201', '2', null, null],
        ]),
      ).rejects.toMatchObject({ outcome: 'rolled-back', rows: 2 })
      await expect(writer.writeBatch([['203', '1.1234567891', null, null]])).rejects.toMatchObject({
        outcome: 'rolled-back',
      })
    } finally {
      await writer.close()
    }
    expect(
      (await execute(`SELECT ID,AMOUNT,PAYLOAD FROM ${q(table)} WHERE ID BETWEEN 201 AND 203 ORDER BY ID`))
        .sets[0].rows,
    ).toEqual([['201', '1.123456789', { type: 'binary', base64: 'AP+A' }]])
  })
  it('cancels the exact native running session, then preserves its ability to execute a fresh explicit query', async () => {
    const requestId = randomUUID(),
      pending = execute('BEGIN DBMS_SESSION.SLEEP(30); END;', 'cancel', {
        requestId,
        confirm: profile.name,
      }).catch((error) => error)
    for (
      let index = 0;
      index < 100 && !service.getSessionState({ connectionId: id, sessionId: 'cancel' }).running;
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      (await service.cancel({ connectionId: id, sessionId: 'cancel', requestId: 'wrong' })).requested,
    ).toBe(false)
    expect((await service.cancel({ connectionId: id, sessionId: 'cancel', requestId })).requested).toBe(true)
    expect(await pending).toBeInstanceOf(Error)
    expect((await execute('SELECT 1 FROM DUAL', 'cancel')).sets[0].rows).toEqual([['1']])
    expect((await service.cancel({ connectionId: id, sessionId: 'cancel' })).requested).toBe(false)
  }, 15000)
  it('rejects unsupported JSON and oversized LOB projections without final success', async () => {
    await expect(execute(`SELECT JSON('{"n":9007199254740993}') FROM DUAL`)).rejects.toThrow(
      'unsupported type',
    )
    await expect(
      execute(`SELECT XMLSERIALIZE(CONTENT XMLELEMENT("x",RPAD('x',4000,'x')) AS CLOB) FROM DUAL`),
    ).resolves.toMatchObject({ transaction: 'idle' })
  })
  it('retains BC years and named timezone-region identity instead of converting them to JavaScript dates', async () => {
    const result = await execute(
      `SELECT ${oracleExactProjection("TO_DATE('0001-01-01 BC','YYYY-MM-DD BC')", 'DATE')} AS ANCIENT,${tz("TO_TIMESTAMP_TZ('2026-07-01 12:00:00 Europe/London','YYYY-MM-DD HH24:MI:SS TZR')")} AS REGIONAL FROM DUAL`,
    )
    expect(result.sets[0].rows[0]).toEqual([
      '-0001-01-01T00:00:00',
      '2026-07-01T12:00:00.000000000+01:00 [EUROPE/LONDON]',
    ])
  })
  it('streams Unicode CLOB pieces without replacement and rejects a genuinely oversized server LOB', async () => {
    const text = 'a'.repeat(65535) + '😀'.repeat(10000)
    await admin.execute(
      `INSERT INTO ${q(table)} (ID,NOTE) VALUES(301,:note)`,
      { note: { val: text, type: oracledb.CLOB } },
      { autoCommit: true },
    )
    expect(
      (await execute(`SELECT NOTE FROM ${q(table)} WHERE ID=301`)).sets[0].rows[0]?.[0] === text,
      'Unicode CLOB is byte-for-byte exact',
    ).toBe(true)
    await admin.execute(
      `INSERT INTO ${q(table)} (ID,NOTE) VALUES(302,:note)`,
      { note: { val: 'x'.repeat(9 * 1024 * 1024), type: oracledb.CLOB } },
      { autoCommit: true },
    )
    await expect(execute(`SELECT NOTE FROM ${q(table)} WHERE ID=302`)).rejects.toThrow('8 MiB')
  }, 30000)
  it('reports stored-unit compilation warnings instead of claiming successful compilation', async () => {
    await expect(
      execute(
        `CREATE OR REPLACE PROCEDURE ${q(procedure)} AS BEGIN nonexistent_harbor_symbol; END;`,
        'compile-warning',
        { confirm: profile.name },
      ),
    ).rejects.toThrow('compilation errors')
    expect(
      (
        await execute('SELECT STATUS FROM USER_OBJECTS WHERE OBJECT_NAME=:name', 'compiled-status', {
          parameters: [{ name: 'name', type: 'text', secret: false, value: procedure }],
        })
      ).sets[0].rows,
    ).toEqual([['INVALID']])
  })
})
