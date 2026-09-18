import type { Engine } from '@shared/contracts'
import athena from '../assets/database-logos/athena.svg'
import bigquery from '../assets/database-logos/bigquery.svg'
import cassandra from '../assets/database-logos/cassandra.svg'
import clickhouse from '../assets/database-logos/clickhouse.svg'
import cockroachdb from '../assets/database-logos/cockroachdb.svg'
import couchdb from '../assets/database-logos/couchdb.svg'
import databricks from '../assets/database-logos/databricks.svg'
import db2 from '../assets/database-logos/db2.svg'
import duckdb from '../assets/database-logos/duckdb.svg'
import dynamodb from '../assets/database-logos/dynamodb.svg'
import elasticsearch from '../assets/database-logos/elasticsearch.svg'
import firebird from '../assets/database-logos/firebird.svg'
import hana from '../assets/database-logos/hana.svg'
import influxdb from '../assets/database-logos/influxdb.svg'
import mariadb from '../assets/database-logos/mariadb.svg'
import milvus from '../assets/database-logos/milvus.svg'
import mongodb from '../assets/database-logos/mongodb.svg'
import mssql from '../assets/database-logos/mssql.svg'
import mysql from '../assets/database-logos/mysql.svg'
import neo4j from '../assets/database-logos/neo4j.svg'
import opensearch from '../assets/database-logos/opensearch.svg'
import oracle from '../assets/database-logos/oracle.svg'
import pinecone from '../assets/database-logos/pinecone.svg'
import postgres from '../assets/database-logos/postgres.svg'
import qdrant from '../assets/database-logos/qdrant.svg'
import questdb from '../assets/database-logos/questdb.svg'
import redis from '../assets/database-logos/redis.svg'
import redshift from '../assets/database-logos/redshift.svg'
import snowflake from '../assets/database-logos/snowflake.svg'
import sqlite from '../assets/database-logos/sqlite.svg'
import tidb from '../assets/database-logos/tidb.svg'
import trino from '../assets/database-logos/trino.svg'
import valkey from '../assets/database-logos/valkey.svg'
import vitess from '../assets/database-logos/vitess.svg'
import weaviate from '../assets/database-logos/weaviate.svg'
import yugabytedb from '../assets/database-logos/yugabytedb.svg'

/** Explicit, offline product artwork; new engines must supply their own SVG. */
export const engineLogos: Record<Engine, string> = {
  athena,
  bigquery,
  cassandra,
  clickhouse,
  cockroachdb,
  couchdb,
  databricks,
  db2,
  duckdb,
  dynamodb,
  elasticsearch,
  firebird,
  hana,
  influxdb,
  mariadb,
  milvus,
  mongodb,
  mssql,
  mysql,
  neo4j,
  opensearch,
  oracle,
  pinecone,
  postgres,
  qdrant,
  questdb,
  redis,
  redshift,
  snowflake,
  sqlite,
  tidb,
  trino,
  valkey,
  vitess,
  weaviate,
  yugabytedb,
}
