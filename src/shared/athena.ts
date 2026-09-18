import { z } from 'zod'

export const athenaProfileSchema = z
  .object({
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
      .default('us-east-1'),
    catalog: z.string().min(1).max(256).default('AwsDataCatalog'),
    workgroup: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,128}$/)
      .default('primary'),
    outputLocation: z.string().max(1024).default(''),
    expectedBucketOwner: z
      .string()
      .regex(/^(?:\d{12})?$/)
      .default(''),
    maximumScannedBytes: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .default('100000000'),
  })
  .strict()

export const athenaCredentialSchema = z
  .object({
    accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
    secretAccessKey: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[^\r\n\0]+$/),
    sessionToken: z
      .string()
      .min(1)
      .max(8000)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
  })
  .strict()

export function athenaTableDraft(catalog: string, database: string, table: string): string {
  const parts = [catalog, database, table]
  if (parts.some((part) => !part || /[\r\n\0]/.test(part)))
    throw new Error('Select explicit Athena catalog, database and table names.')
  return (
    'SELECT * FROM ' + parts.map((part) => '"' + part.replaceAll('"', '""') + '"').join('.') + ' LIMIT 200;'
  )
}
