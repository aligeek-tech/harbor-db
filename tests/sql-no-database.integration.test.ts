import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mariadb, { type Connection } from 'mariadb'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema, type Cell, type QueryResult } from '../src/shared/contracts'

const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const database = `harbor_blank_${suffix}`
const emptyDatabase = `harbor_empty_${suffix}`
const hiddenDatabase = `harbor_hidden_${suffix}`
const username = `blank_${suffix}`
const password = randomUUID()
const profile = profileSchema.parse({
  id: `blank-maria-${suffix}`,
  name: 'MariaDB without a default database',
  engine: 'mariadb',
  host: '127.0.0.1',
  port: 13306,
  username,
  database: '',
  schema: '',
  environment: 'development',
  readOnly: false,
})
const service = new SqlService()
let admin: Connection | undefined

function query(sql: string, sessionId = 'observer') {
  return service.execute({
    connectionId: profile.id,
    sessionId,
    requestId: randomUUID(),
    sql,
    maxRows: 10,
    privateSession: true,
  })
}
function rowObject(result: QueryResult): Record<string, Cell> {
  return Object.fromEntries(
    result.sets[0].columns.map((column, index) => [column.name, result.sets[0].rows[0][index]]),
  )
}

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')('MariaDB without a default database', () => {
  beforeAll(async () => {
    // Local Compose administrator only; these generated databases and account are
    // isolated from the user's profiles, credentials, and existing fixture data.
    admin = await mariadb.createConnection({
      host: '127.0.0.1',
      port: 13306,
      user: 'root',
      password: 'harbor_root',
    })
    for (const name of [database, emptyDatabase, hiddenDatabase])
      await admin.query(`CREATE DATABASE \`${name}\``)
    await admin.query(`CREATE USER '${username}'@'%' IDENTIFIED BY ?`, [password])
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${username}'@'%'`)
    await admin.query(`GRANT SELECT ON \`${emptyDatabase}\`.* TO '${username}'@'%'`)
    await admin.query(
      `CREATE TABLE \`${database}\`.records (id INT PRIMARY KEY, label VARCHAR(100) NOT NULL) ENGINE=InnoDB`,
    )
    await admin.query(`INSERT INTO \`${database}\`.records VALUES (1, 'original')`)
    expect((await service.connect(profile, { password })).state).toBe('connected')
  })
  afterAll(async () => {
    await service.closeAll()
    if (admin) {
      try {
        await admin.query(`DROP USER IF EXISTS '${username}'@'%'`)
        for (const name of [database, emptyDatabase, hiddenDatabase])
          await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
      } finally {
        await admin.end()
      }
    }
  })

  it('lists visible databases and asks for a database instead of reporting a false empty object list', async () => {
    const databases = await service.listDatabases(profile.id)
    expect(databases).toContain(database)
    expect(databases).toContain(emptyDatabase)
    expect(databases).not.toContain(hiddenDatabase)
    expect((await query('SELECT DATABASE()')).sets[0].rows).toEqual([[null]])
    await expect(service.listObjects({ connectionId: profile.id })).rejects.toThrow('Choose a database')
    await expect(service.listObjects({ connectionId: profile.id, schema: '' })).rejects.toThrow(
      'Choose a database',
    )
    expect(await service.listObjects({ connectionId: profile.id, schema: database })).toContainEqual(
      expect.objectContaining({ schema: database, name: 'records', kind: 'table' }),
    )
    expect(await service.listObjects({ connectionId: profile.id, schema: emptyDatabase })).toEqual([])
    expect(await service.listObjects({ connectionId: profile.id, schema: `${database}' OR 1=1 --` })).toEqual(
      [],
    )
    expect((await query('SELECT DATABASE()')).sets[0].rows).toEqual([[null]])
  })

  it('qualifies table reads and edits without issuing USE or changing any tab default database', async () => {
    const input = {
      connectionId: profile.id,
      sessionId: 'table',
      schema: database,
      table: 'records',
      offset: 0,
      limit: 25,
      direction: 'asc' as const,
    }
    const structure = await service.structure(input)
    expect(structure.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true)
    const result = await service.table(input)
    expect(result.sets[0].rows).toEqual([[1, 'original']])
    expect((await query('SELECT DATABASE()', 'table')).sets[0].rows).toEqual([[null]])
    expect(
      await service.applyEdits({
        ...input,
        changes: [{ kind: 'update', original: rowObject(result), values: { label: 'qualified edit' } }],
      }),
    ).toEqual({ affectedRows: 1 })
    expect((await service.table(input)).sets[0].rows).toEqual([[1, 'qualified edit']])
    expect((await query('SELECT DATABASE()', 'table')).sets[0].rows).toEqual([[null]])
    expect((await query('SELECT DATABASE()', 'observer')).sets[0].rows).toEqual([[null]])
    expect((await query('SELECT DATABASE()', 'new-tab')).sets[0].rows).toEqual([[null]])
    await expect(query('SELECT * FROM records', 'unqualified')).rejects.toThrow(/No database selected/i)
  })
})
