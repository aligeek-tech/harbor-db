import type { QueryParameter } from './parameters'
import { parameterValue } from './parameters'

/** Oracle alternative quoting, ordinary quoted strings/identifiers and comments. UTF-16 offsets. */
export function oracleVisible(sql: string): string {
  const visible = sql.split('')
  let index = 0
  while (index < sql.length) {
    const start = index,
      char = sql[index],
      before = sql[index - 1] ?? ' '
    const alternative = /^(?:n)?q'/i.exec(sql.slice(index))
    if (alternative && !/[\w$#]/.test(before)) {
      const opener = sql[index + alternative[0].length],
        closer: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' }
      if (!opener || /\s|'/.test(opener)) throw new Error('Invalid Oracle alternative quote delimiter.')
      const end = sql.indexOf((closer[opener] ?? opener) + "'", index + alternative[0].length + 1)
      if (end < 0) throw new Error('Unterminated Oracle alternative-quoted string.')
      index = end + 2
    } else if (char === "'" || char === '"') {
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index++] === char) {
          if (sql[index] === char) {
            index++
            continue
          }
          closed = true
          break
        }
      }
      if (!closed) throw new Error('Unterminated Oracle quoted string or identifier.')
    } else if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n') index++
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2)
      if (end < 0 || sql.slice(index + 2, end).includes('/*'))
        throw new Error('Unterminated or nested Oracle comment.')
      index = end + 2
    } else {
      index++
      continue
    }
    for (let at = start; at < index; at++) if (visible[at] !== '\n') visible[at] = ' '
  }
  return visible.join('')
}
export function oracleQuote(value: string): string {
  if (!value || value.includes('\0') || new TextEncoder().encode(value).length > 128)
    throw new Error('Oracle identifiers must contain 1 to 128 UTF-8 bytes and no NUL.')
  return '"' + value.replaceAll('"', '""') + '"'
}
export function oracleProgram(visible: string): boolean {
  return (
    /^\s*(?:BEGIN|DECLARE|CALL)\b/i.test(visible) ||
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE)\b/i.test(
      visible,
    )
  )
}
export function oracleSql(sql: string): string {
  let text = sql.trim(),
    visible = oracleVisible(text)
  const slash = [...visible.matchAll(/^\s*\/\s*$/gm)]
  if (slash.length) {
    const last = slash.at(-1)!
    if (slash.length !== 1 || visible.slice(last.index! + last[0].length).trim())
      throw new Error('Run one Oracle SQL or PL/SQL unit at a time.')
    text = text.slice(0, last.index).trimEnd()
    visible = oracleVisible(text)
  }
  if (oracleProgram(visible)) {
    if (!/^\s*CALL\b/i.test(visible) && !/\bEND(?:\s+[A-Za-z_$#][\w$#]*)?\s*;\s*$/i.test(visible))
      throw new Error('Select one complete Oracle PL/SQL block ending in END;.')
    return /^\s*CALL\b/i.test(visible) ? text.replace(/;\s*$/, '') : text
  }
  const semicolons = [...visible.matchAll(/;/g)]
  if (semicolons.length > 1 || (semicolons.length && visible.slice(semicolons[0].index! + 1).trim()))
    throw new Error('Run one Oracle statement at a time, or select one complete PL/SQL block.')
  return semicolons.length ? text.slice(0, semicolons[0].index) + text.slice(semicolons[0].index! + 1) : text
}
export function oracleSafety(sql: string): {
  readOnly: boolean
  destructive: boolean
  controlsTransaction: boolean
  statementCount: number
} {
  const text = oracleSql(sql),
    visible = oracleVisible(text).trim(),
    program = oracleProgram(visible)
  const readOnly =
    !program &&
    /^(SELECT|WITH)\b/i.test(visible) &&
    !/\b(INSERT|UPDATE|DELETE|MERGE|INTO|NEXTVAL|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|FUNCTION|PROCEDURE)\b/i.test(
      visible,
    )
  return {
    readOnly,
    destructive:
      program ||
      /\b(DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(visible) ||
      (/^(DELETE|UPDATE)\b/i.test(visible) && !/\bWHERE\b/i.test(visible)),
    controlsTransaction:
      !program && /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|SET|ALTER\s+(?:SESSION|SYSTEM))\b/i.test(visible),
    statementCount: visible ? 1 : 0,
  }
}
export function oracleConfirmation(
  sql: string,
  profile: { name: string; environment: string },
): string | undefined {
  const safety = oracleSafety(sql)
  return safety.destructive || (profile.environment.toLowerCase() === 'production' && !safety.readOnly)
    ? profile.name
    : undefined
}
export function oracleParameters(
  parameters: QueryParameter[] = [],
): Record<string, string | boolean | null | Uint8Array> {
  const result: Record<string, string | boolean | null | Uint8Array> = Object.create(null)
  let bytes = 0
  for (const parameter of parameters) {
    bytes += new TextEncoder().encode(parameter.value).length
    if (bytes > 4 * 1024 * 1024) throw new Error('Oracle parameter values exceed the 4 MiB request limit.')
    const name = parameter.name.toUpperCase()
    if (!/^[A-Z][A-Z0-9_$#]*$/.test(name) || Object.hasOwn(result, name))
      throw new Error('Use distinct Oracle bind names beginning with a letter.')
    result[name] = parameterValue(parameter)
  }
  return result
}
