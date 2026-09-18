import { z } from 'zod'

export const firebirdProfileSchema = z
  .object({ mode: z.enum(['server', 'local-file']).default('server'), role: z.string().max(63).default('') })
  .strict()
export function firebirdQuote(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid Firebird identifier.')
  return '"' + value.replaceAll('"', '""') + '"'
}
export function firebirdLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Use a filter without line breaks or NUL.')
  return "'" + value.replaceAll("'", "''") + "'"
}
