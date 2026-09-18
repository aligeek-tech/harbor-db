import { z } from 'zod'

export const warehouseProfileSchema = z
  .object({
    warehouse: z.string().max(255).default(''),
    role: z.string().max(255).default(''),
    snowflakeTokenType: z.enum(['OAUTH', 'PROGRAMMATIC_ACCESS_TOKEN', 'KEYPAIR_JWT']).default('OAUTH'),
  })
  .strict()
export const isCloudWarehouse = (engine: string) =>
  ['bigquery', 'snowflake', 'databricks', 'athena'].includes(engine)
export function warehouseTableDraft(
  engine: 'bigquery' | 'snowflake' | 'databricks',
  database: string,
  schema: string,
  table: string,
) {
  const parts = [database, schema, table]
  if (parts.some((part) => !part || /[\r\n\0]/.test(part)))
    throw new Error('Select an explicit valid catalog, schema and table.')
  const quoted =
    engine === 'bigquery'
      ? '`' + parts.join('.').replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`'
      : parts
          .map((part) =>
            engine === 'snowflake'
              ? '"' + part.replaceAll('"', '""') + '"'
              : '`' + part.replaceAll('`', '``') + '`',
          )
          .join('.')
  return `SELECT * FROM ${quoted} LIMIT 200;`
}
