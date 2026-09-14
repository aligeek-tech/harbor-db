import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { SqlService } from '../src/main/engines/sql'
import { profileSchema } from '../src/shared/contracts'
import { quoteIdentifier } from '../src/shared/sql'

describe.skipIf(process.env.HARBOR_TIMESCALE !== '1')('real TimescaleDB catalog discovery', () => {
  const database = `harbor_catalog_ts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const config = {
    host: '127.0.0.1',
    port: Number(process.env.HARBOR_TIMESCALE_PORT || 15433),
    user: 'harbor',
    password: 'harbor_test',
  }
  const admin = new pg.Client({ ...config, database: 'harbor' })
  const fixture = new pg.Client({ ...config, database })
  const service = new SqlService()
  const reader = `ts_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  let readerCreated = false
  const profile = profileSchema.parse({
    id: database,
    name: 'Timescale catalog fixture',
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
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      CREATE SCHEMA app_data;
      CREATE SCHEMA custom_chunks;
      CREATE SCHEMA _timescaledb_customer_data;
      CREATE TABLE app_data.metrics (time timestamptz NOT NULL, value integer NOT NULL);
      SELECT create_hypertable('app_data.metrics', 'time',
        associated_schema_name => 'custom_chunks', chunk_time_interval => INTERVAL '1 day');
      INSERT INTO app_data.metrics VALUES ('2025-01-01 12:00:00+00', 7), ('2025-01-02 12:00:00+00', 11);
      CREATE MATERIALIZED VIEW app_data.daily WITH (timescaledb.continuous) AS
        SELECT time_bucket(INTERVAL '1 day', time) AS day, sum(value) AS total
        FROM app_data.metrics GROUP BY 1 WITH NO DATA;
      CREATE TABLE app_data.ordinary (id integer);
      CREATE VIEW app_data.user_view AS SELECT * FROM app_data.ordinary;
      CREATE TABLE _timescaledb_customer_data.keep_me (id integer);
      CREATE FUNCTION app_data.user_routine() RETURNS integer LANGUAGE sql AS 'SELECT 3';
      CREATE FUNCTION public.hypertable_size(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1';
      CREATE FUNCTION app_data.extension_dependent() RETURNS integer LANGUAGE sql AS 'SELECT 4';
      ALTER FUNCTION app_data.extension_dependent() DEPENDS ON EXTENSION timescaledb;
    `)
    await fixture.query(`CALL refresh_continuous_aggregate('app_data.daily',
      '2025-01-01'::timestamptz, '2025-01-04'::timestamptz)`)
    await fixture.query(`CREATE ROLE ${quoteIdentifier(reader, 'postgres')} LOGIN PASSWORD 'harbor_test'`)
    readerCreated = true
    await fixture.query(`GRANT USAGE ON SCHEMA app_data TO ${quoteIdentifier(reader, 'postgres')};
      GRANT SELECT ON ALL TABLES IN SCHEMA app_data TO ${quoteIdentifier(reader, 'postgres')}`)
    expect((await service.connect(profile, { password: config.password })).state).toBe('connected')
  })

  afterAll(async () => {
    await service.closeAll()
    await fixture.end()
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database, 'postgres')}`)
      if (readerCreated) await admin.query(`DROP ROLE ${quoteIdentifier(reader, 'postgres')}`)
    } finally {
      await admin.end()
    }
  })

  it('keeps user hypertables, continuous aggregates, ordinary objects and same-name routines', async () => {
    const objects = await service.listObjects({ connectionId: profile.id })
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'app_data', name: 'metrics', kind: 'table' }),
        expect.objectContaining({ schema: 'app_data', name: 'daily', kind: 'view' }),
        expect.objectContaining({ schema: 'app_data', name: 'ordinary', kind: 'table' }),
        expect.objectContaining({ schema: 'app_data', name: 'user_view', kind: 'view' }),
        expect.objectContaining({ schema: 'app_data', name: 'user_routine', kind: 'function' }),
        expect.objectContaining({ schema: 'app_data', name: 'extension_dependent', kind: 'function' }),
        expect.objectContaining({ schema: '_timescaledb_customer_data', name: 'keep_me', kind: 'table' }),
      ]),
    )
    expect(objects.filter((object) => object.name === 'hypertable_size')).toEqual([
      expect.objectContaining({ schema: 'public', name: 'hypertable_size', kind: 'function' }),
    ])
    const data = await service.table({
      connectionId: profile.id,
      sessionId: 'hypertable',
      schema: 'app_data',
      table: 'metrics',
      limit: 20,
      offset: 0,
      sort: 'time',
      direction: 'asc',
    })
    expect(data.sets[0].rows.map((row) => row[1])).toEqual(['7', '11'])
    const aggregate = await service.table({
      connectionId: profile.id,
      sessionId: 'aggregate',
      schema: 'app_data',
      table: 'daily',
      limit: 20,
      offset: 0,
      sort: 'day',
      direction: 'asc',
    })
    expect(aggregate.sets[0].rows.map((row) => row[1])).toEqual(['7', '11'])
  })

  it('excludes extension helpers, owned schemas and real custom-schema chunks before delivery', async () => {
    const rawChunks = await fixture.query(`SELECT chunk_schema,chunk_name
      FROM timescaledb_information.chunks WHERE hypertable_schema='app_data' AND hypertable_name='metrics'`)
    expect(rawChunks.rows.length).toBe(2)
    expect(rawChunks.rows.every((row) => row.chunk_schema === 'custom_chunks')).toBe(true)
    const objects = await service.listObjects({ connectionId: profile.id })
    const internalSchemas = [
      '_timescaledb_catalog',
      '_timescaledb_config',
      '_timescaledb_internal',
      '_timescaledb_functions',
      '_timescaledb_cache',
      'timescaledb_information',
      'timescaledb_experimental',
    ]
    expect(objects.some((object) => internalSchemas.includes(object.schema))).toBe(false)
    expect(
      objects.some((object) => ['create_hypertable', 'drop_chunks', 'time_bucket'].includes(object.name)),
    ).toBe(false)
    expect(objects.some((object) => object.schema === 'custom_chunks')).toBe(false)
    expect(await service.listObjects({ connectionId: profile.id, schema: 'custom_chunks' })).toEqual([])
    expect(await service.listObjects({ connectionId: profile.id, schema: '_timescaledb_internal' })).toEqual(
      [],
    )
    expect(await service.listObjects({ connectionId: profile.id, schema: 'app_data' })).toHaveLength(6)
  })

  it('discovers and reads user hypertables with an ordinary SELECT-only database role', async () => {
    const limited = { ...profile, id: `${profile.id}-reader`, username: reader }
    expect((await service.connect(limited, { password: config.password })).state).toBe('connected')
    const objects = await service.listObjects({ connectionId: limited.id })
    expect(objects).toContainEqual(expect.objectContaining({ schema: 'app_data', name: 'metrics' }))
    expect(objects.some((object) => object.schema === 'custom_chunks')).toBe(false)
    expect(objects.some((object) => object.name === 'create_hypertable')).toBe(false)
    const data = await service.table({
      connectionId: limited.id,
      sessionId: 'reader',
      schema: 'app_data',
      table: 'metrics',
      limit: 20,
      offset: 0,
      sort: 'time',
      direction: 'asc',
    })
    expect(data.sets[0].rows.map((row) => row[1])).toEqual(['7', '11'])
  })
})
