import type { QueryParameter } from './parameters'
import { parameterValue } from './parameters'

/** ClickHouse has its own escaping and native {name:Type} parameter grammar. */
export function clickhouseQuote(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid ClickHouse identifier.')
  return '`' + value.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
}
export function clickhouseLiteral(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0') + "'"
}
export function clickhouseVisible(sql: string): string {
  let index = 0
  // Index against UTF-16 code units so removing a final delimiter preserves source offsets.
  const masked = sql.split('')
  while (index < sql.length) {
    const start = index,
      char = sql[index],
      next = sql[index + 1]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index] === '\\') {
          index += 2
          continue
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index++
          closed = true
          break
        }
        index++
      }
      if (!closed) throw new Error('Unterminated ClickHouse quoted value or identifier.')
    } else if ((char === '-' && next === '-') || char === '#') {
      while (index < sql.length && sql[index] !== '\n') index++
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end < 0 || sql.slice(index + 2, end).includes('/*'))
        throw new Error('Unterminated or nested ClickHouse comment.')
      index = end + 2
    } else {
      index++
      continue
    }
    for (let offset = start; offset < Math.min(index, sql.length); offset++) masked[offset] = ' '
  }
  return masked.join('')
}
export function clickhouseReadQuery(sql: string): string {
  const visible = clickhouseVisible(sql).trim().replace(/;\s*$/, '')
  if (!/^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXISTS|EXPLAIN)\b/i.test(visible))
    throw new Error(
      'ClickHouse query tabs accept read-only analytical statements. Use the explicit append import workflow for data ingestion.',
    )
  if (
    visible.includes(';') ||
    /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|SET|USE|SYSTEM|BACKUP|RESTORE|GRANT|REVOKE|INTO|FORMAT|SETTINGS|DELIMITER|GO)\b/i.test(
      visible
        .replace(/\b[A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)+/g, 'identifier')
        .replace(/^SHOW\s+CREATE\b/i, 'SHOW DEFINITION'),
    ) ||
    /\bWITH\s+TOTALS\b/i.test(visible)
  )
    throw new Error(
      'Use one read-only ClickHouse statement without FORMAT, SETTINGS, totals, or session commands.',
    )
  const source = sql.trim(),
    sourceVisible = clickhouseVisible(source)
  const delimiter = sourceVisible.lastIndexOf(';')
  return delimiter < 0 ? source : source.slice(0, delimiter) + source.slice(delimiter + 1)
}
export function clickhouseParameters(parameters: QueryParameter[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  if (parameters.reduce((sum, parameter) => sum + parameter.value.length, 0) > 4 * 1024 * 1024)
    throw new Error('ClickHouse parameters exceed the 4 MiB text limit.')
  for (const parameter of parameters) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name) || Object.hasOwn(result, parameter.name))
      throw new Error('ClickHouse parameter names must be distinct identifiers.')
    const value = parameterValue(parameter)
    if (value instanceof Uint8Array)
      throw new Error('Bind binary data as base64 text and use base64Decode({name:String}) explicitly.')
    result[parameter.name] = value
  }
  return result
}
