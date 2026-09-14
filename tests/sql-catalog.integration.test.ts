import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'
import { quoteIdentifier } from '../src/shared/sql'

describe.skipIf(process.env.HARBOR_INTEGRATION !== '1')(
  'PostgreSQL extension-aware catalog discovery',
  () => {
    const database = `harbor_catalog_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const config = { host: '127.0.0.1', port: 15432, user: 'harbor', password: 'harbor_test' }
    const admin = new pg.Client({ ...config, database: 'harbor' })
    const fixture = new pg.Client({ ...config, database })
    const service = new SqlService()
    const profile = profileSchema.parse({
      id: database,
      name: 'PostgreSQL extension catalog fixture',
      engine: 'postgres',
      host: config.host,
      port: config.port,
      username: config.user,
      database,
      readOnly: true,
    })

    beforeAll(async () => {
      await admin.connect()
      await admin.query(`CREATE DATABASE ${quoteIdentifier(database, 'postgres')}`)
      await fixture.connect()
      await fixture.query(`
      CREATE SCHEMA extensions;
      CREATE EXTENSION hstore WITH SCHEMA extensions;
      CREATE TABLE public.user_table (id integer);
      CREATE TABLE public.extension_table (id integer);
      ALTER EXTENSION hstore ADD TABLE public.extension_table;
      CREATE VIEW public.user_view AS SELECT * FROM public.user_table;
      CREATE FUNCTION extensions.user_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION public.extension_dependent() RETURNS integer LANGUAGE sql AS 'SELECT 2';
      ALTER FUNCTION public.extension_dependent() DEPENDS ON EXTENSION hstore;
      CREATE SCHEMA _timescaledb_customer_data;
      CREATE TABLE _timescaledb_customer_data.user_table (id integer);
      CREATE SCHEMA timescaledb_information;
      CREATE VIEW timescaledb_information.chunks AS SELECT 1 AS user_column;
    `)
      expect((await service.connect(profile, { password: config.password })).state).toBe('connected')
    })

    afterAll(async () => {
      await service.closeAll()
      await fixture.end()
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database, 'postgres')}`)
      } finally {
        await admin.end()
      }
    })

    it('hides helper routines while retaining other extension relations and user dependencies', async () => {
      const objects = await service.listObjects({ connectionId: profile.id })
      expect(objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ schema: 'public', name: 'user_table', kind: 'table' }),
          expect.objectContaining({ schema: 'public', name: 'user_view', kind: 'view' }),
          expect.objectContaining({ schema: 'public', name: 'extension_table', kind: 'table' }),
          expect.objectContaining({ schema: 'public', name: 'extension_dependent', kind: 'function' }),
          expect.objectContaining({ schema: 'extensions', name: 'user_function', kind: 'function' }),
        ]),
      )
      expect(objects.filter((object) => object.schema === 'extensions')).toHaveLength(1)
      expect(
        (
          await fixture.query(`SELECT deptype FROM pg_depend WHERE classid='pg_proc'::regclass
        AND objid='public.extension_dependent()'::regprocedure AND refclassid='pg_extension'::regclass`)
        ).rows,
      ).toContainEqual({ deptype: 'x' })
    })

    it('does not treat user names or lookalike information views as installed Timescale objects', async () => {
      const objects = await service.listObjects({ connectionId: profile.id })
      expect(objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ schema: '_timescaledb_customer_data', name: 'user_table' }),
          expect.objectContaining({ schema: 'timescaledb_information', name: 'chunks', kind: 'view' }),
        ]),
      )
      expect(
        await service.listObjects({ connectionId: profile.id, schema: '_timescaledb_customer_data' }),
      ).toHaveLength(1)
      expect(await service.listObjects({ connectionId: profile.id, schema: "public' OR true --" })).toEqual(
        [],
      )
    })
    it('filters extension clutter on the server before the metadata row budget', async () => {
      await fixture.query(`DO $fixture$
        BEGIN
          FOR item IN 1..10001 LOOP
            EXECUTE format('CREATE FUNCTION extensions.helper_%s() RETURNS integer LANGUAGE sql AS %L', item, 'SELECT 1');
            EXECUTE format('ALTER EXTENSION hstore ADD FUNCTION extensions.helper_%s()', item);
          END LOOP;
        END
      $fixture$`)
      const count = await fixture.query(`SELECT count(*)::integer AS count FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='extensions'`)
      expect(count.rows[0].count).toBeGreaterThan(10000)
      expect(await service.listObjects({ connectionId: profile.id, schema: 'extensions' })).toEqual([
        expect.objectContaining({ name: 'user_function', kind: 'function' }),
      ])
    })
  },
)
