import pg from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'
import { relatedRecordTarget } from '../src/shared/related-records'

const engines = [
  ...(process.env.HARBOR_INTEGRATION === '1' ? (['postgres', 'mariadb'] as const) : []),
  ...(process.env.HARBOR_MYSQL === '1' ? (['mysql'] as const) : []),
]
describe.skipIf(!engines.length)('real ordered foreign-key metadata', () => {
  for (const engine of engines)
    describe(engine, () => {
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
      const schema = `fk_target_${suffix}`
      const child = `fk_child_${suffix}`
      const role = `fk_reader_${suffix}`
      const password = crypto.randomUUID()
      const constraint = `fk_tuple_${suffix}`
      const service = new SqlService()
      const sourceSchema = engine === 'postgres' ? 'public' : 'harbor'
      const port = engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 13307
      const fixtureTls =
        engine === 'mysql'
          ? {
              enabled: true,
              rejectUnauthorized: !!process.env.HARBOR_MYSQL_TLS_CA,
              ca: process.env.HARBOR_MYSQL_TLS_CA
                ? readFileSync(process.env.HARBOR_MYSQL_TLS_CA, 'utf8')
                : '',
            }
          : undefined
      const profile = profileSchema.parse({
        id: `fk-${engine}`,
        name: 'Local foreign-key inspection',
        engine,
        host: '127.0.0.1',
        port,
        username: role,
        database: 'harbor',
        readOnly: true,
        tls: fixtureTls,
      })
      let admin: pg.Client | Connection | undefined
      const quote = (name: string) =>
        engine === 'postgres'
          ? '"' + name.replaceAll('"', '""') + '"'
          : '`' + name.replaceAll('`', '``') + '`'
      const parentName = `${quote(schema)}.${quote('parent')}`
      const childName = `${quote(sourceSchema)}.${quote(child)}`
      async function execute(text: string) {
        if (admin instanceof pg.Client) return admin.query(text)
        return admin!.query(text)
      }
      beforeAll(async () => {
        if (engine === 'postgres') {
          const client = new pg.Client({
            host: '127.0.0.1',
            port,
            user: 'harbor',
            password: 'harbor_test',
            database: 'harbor',
          })
          await client.connect()
          admin = client
          await execute(`CREATE SCHEMA ${quote(schema)}`)
          await execute(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`)
        } else {
          admin = await mariadb.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            password: 'harbor_root',
            database: 'harbor',
            queryTimeout: 0,
            ssl: fixtureTls
              ? { rejectUnauthorized: fixtureTls.rejectUnauthorized, ca: fixtureTls.ca || undefined }
              : undefined,
          })
          await execute(`CREATE DATABASE ${quote(schema)}`)
          await execute(`CREATE USER '${role}'@'%' IDENTIFIED BY '${password}'`)
        }
        await execute(
          `CREATE TABLE ${parentName} (parent_first INTEGER,parent_second VARCHAR(64),label VARCHAR(64),PRIMARY KEY(parent_second,parent_first))`,
        )
        await execute(
          `CREATE TABLE ${childName} (id INTEGER PRIMARY KEY,source_a INTEGER,source_b VARCHAR(64),CONSTRAINT ${quote(constraint)} FOREIGN KEY(source_b,source_a) REFERENCES ${parentName}(parent_second,parent_first) ON UPDATE CASCADE ON DELETE SET NULL)`,
        )
        await execute(`INSERT INTO ${parentName} VALUES (42,'key value','matched parent')`)
        await execute(`INSERT INTO ${childName} VALUES (1,42,'key value'),(2,NULL,NULL)`)
        if (engine === 'postgres') {
          await execute(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`)
          await execute(`GRANT SELECT ON ${parentName},${childName} TO ${quote(role)}`)
        } else {
          await execute(`GRANT SELECT ON ${parentName} TO '${role}'@'%'`)
          await execute(`GRANT SELECT ON ${childName} TO '${role}'@'%'`)
        }
        if (engine === 'mysql') {
          const coldTcp = await service.connect(
            { ...profile, id: profile.id + '-cold-tcp', tls: { ...profile.tls, enabled: false } },
            { password },
          )
          expect(coldTcp.state).toBe('failed')
          expect(coldTcp.error).toMatch(/RSA public key|secure connection/i)
        }
        const status = await service.connect(profile, { password })
        expect(status.state, status.error).toBe('connected')
      })
      afterAll(async () => {
        await service.closeAll()
        if (admin) {
          await execute(`DROP TABLE IF EXISTS ${childName}`)
          await execute(`DROP TABLE IF EXISTS ${parentName}`)
          await execute(`${engine === 'postgres' ? 'DROP SCHEMA' : 'DROP DATABASE'} ${quote(schema)}`)
          await execute(engine === 'postgres' ? `DROP ROLE ${quote(role)}` : `DROP USER '${role}'@'%'`)
          await admin.end()
        }
      })

      it('discovers composite cross-schema keys in declaration order with SELECT-only privileges', async () => {
        const structure = await service.structure({
          connectionId: profile.id,
          schema: sourceSchema,
          table: child,
        })
        expect(structure.foreignKeys).toEqual([
          expect.objectContaining({
            name: constraint,
            columns: ['source_b', 'source_a'],
            referencedDatabase: engine === 'postgres' ? 'harbor' : schema,
            referencedSchema: schema,
            referencedTable: 'parent',
            referencedColumns: ['parent_second', 'parent_first'],
          }),
        ])
        // Some servers omit action rules from REFERENTIAL_CONSTRAINTS for SELECT-only users.
        if (structure.foreignKeys[0].onUpdate) expect(structure.foreignKeys[0].onUpdate).toBe('CASCADE')
        if (structure.foreignKeys[0].onDelete) expect(structure.foreignKeys[0].onDelete).toBe('SET NULL')
        const source = await service.table({
          connectionId: profile.id,
          sessionId: 'source',
          schema: sourceSchema,
          table: child,
          offset: 0,
          limit: 20,
          direction: 'asc',
        })
        const target = relatedRecordTarget(
          structure.foreignKeys[0],
          source.sets[0],
          0,
          engine === 'postgres' ? 'postgres' : 'mariadb',
          'harbor',
        )
        expect(target.reason).toBeUndefined()
        const result = await service.execute({
          connectionId: profile.id,
          sessionId: 'related',
          requestId: crypto.randomUUID(),
          database: target.target!.database,
          sql: target.target!.sql,
          parameters: target.target!.parameters,
          maxRows: 200,
          privateSession: true,
        })
        expect(result.sets[0].rows).toHaveLength(1)
        expect(result.sets[0].rows[0][2]).toBe('matched parent')
        expect(relatedRecordTarget(structure.foreignKeys[0], source.sets[0], 1, 'postgres').reason).toContain(
          'NULL',
        )
      })

      it('reports no outbound relationships on the parent instead of inferring by names', async () => {
        const structure = await service.structure({ connectionId: profile.id, schema, table: 'parent' })
        expect(structure.foreignKeys).toEqual([])
      })

      it('includes authoritative update/delete actions when catalog privileges expose them', async () => {
        const privileged = {
          ...profile,
          id: profile.id + '-catalog',
          username: engine === 'postgres' ? 'harbor' : 'root',
        }
        const status = await service.connect(privileged, {
          password: engine === 'postgres' ? 'harbor_test' : 'harbor_root',
        })
        expect(status.state, status.error).toBe('connected')
        const structure = await service.structure({
          connectionId: privileged.id,
          schema: sourceSchema,
          table: child,
        })
        expect(structure.foreignKeys[0]).toMatchObject({
          name: constraint,
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        })
        await service.disconnect(privileged.id)
      })
    })
})
