import { requiredSqlConfirmation, sqlSafety } from './sql'

export function mssqlQuote(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid SQL Server identifier.')
  return '[' + value.replaceAll(']', ']]') + ']'
}
/** Preserve offsets while removing T-SQL literals/comments/quoted identifiers. */
export function mssqlVisible(sql: string): string {
  let visible = ''
  for (let index = 0; index < sql.length;) {
    const start = index
    if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n') index++
    } else if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) {
          depth++
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth--
          index += 2
        } else index++
      }
      if (depth) throw new Error('Unterminated T-SQL comment.')
    } else if (["'", '"', '['].includes(sql[index])) {
      const end = sql[index] === '[' ? ']' : sql[index]
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index++] === end) {
          if (sql[index] === end) index++
          else {
            closed = true
            break
          }
        }
      }
      if (!closed) throw new Error('Unterminated T-SQL string or identifier.')
    } else {
      visible += sql[index++]
      continue
    }
    visible += sql.slice(start, index).replace(/[^\n]/g, ' ')
  }
  return visible
}
export function mssqlSafety(sql: string): ReturnType<typeof sqlSafety> {
  const visible = mssqlVisible(sql)
  if (/^\s*GO(?:\s+\d+)?\s*$/im.test(visible))
    throw new Error('GO is a client batch separator. Run each batch separately without GO.')
  const safety = sqlSafety(visible, 'postgres')
  if (
    /\b(EXEC|EXECUTE|DENY|BACKUP|RESTORE|DBCC|OPENROWSET|OPENDATASOURCE|OPENQUERY)\b|\bNEXT\s+VALUE\s+FOR\b/i.test(
      visible,
    )
  )
    safety.readOnly = false
  if (!/^(SELECT|WITH)\b/i.test(visible.trim())) safety.readOnly = false
  return safety
}
export function mssqlConfirmation(
  sql: string,
  profile: { name: string; environment: string },
): string | undefined {
  const visible = mssqlVisible(sql)
  const drops = [...visible.matchAll(/\bDROP\s+(?:DATABASE|SCHEMA)\b(?:\s+IF\s+EXISTS\b)?/gi)]
  if (drops.length > 1) throw new Error('Drop databases or schemas one at a time.')
  if (drops.length) {
    const tail = sql.slice(drops[0].index! + drops[0][0].length).trim()
    const identifier = /^(?:\[((?:[^\]]|\]\])+)\]|"((?:[^"]|"")+)"|([^\s;,.]+))/.exec(tail)
    if (!identifier || tail.slice(identifier[0].length).trimStart().startsWith(','))
      throw new Error('Specify exactly one database or schema to drop.')
    return (identifier[1] ?? identifier[2] ?? identifier[3]).replaceAll(']]', ']').replaceAll('""', '"')
  }
  const safety = mssqlSafety(sql)
  return safety.destructive || (profile.environment.toLowerCase() === 'production' && !safety.readOnly)
    ? profile.name
    : requiredSqlConfirmation(visible, 'postgres', profile)
}
