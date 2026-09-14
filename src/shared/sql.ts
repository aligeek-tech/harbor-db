export type SqlDialect = 'postgres' | 'mariadb'
export interface SqlStatement {
  text: string
  start: number
  end: number
}

/** Lexical SQL scanner. Offsets are UTF-16 offsets, matching Monaco's model. */
function scan(sql: string, dialect: SqlDialect): { separators: number[]; visible: string } {
  let visible = ''
  const separators: number[] = []
  for (let i = 0; i < sql.length;) {
    const start = i
    if (
      (sql.startsWith('--', i) && (dialect === 'postgres' || /\s/.test(sql[i + 2] ?? ' '))) ||
      (dialect === 'mariadb' && sql[i] === '#')
    ) {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (dialect === 'postgres' && sql.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) throw new Error('Unterminated SQL comment. Complete it before running a statement.')
    } else if (sql[i] === "'" || sql[i] === '"' || (dialect === 'mariadb' && sql[i] === '`')) {
      const quote = sql[i++]
      const backslash =
        dialect === 'mariadb' || (quote === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(0, start)))
      let closed = false
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) {
            i++
            continue
          }
          closed = true
          break
        }
      }
      if (!closed)
        throw new Error('Unterminated SQL string or identifier. Complete it before running a statement.')
    } else if (dialect === 'postgres' && sql[i] === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
      const match = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i))
      if (match) {
        const end = sql.indexOf(match[0], i + match[0].length)
        if (end < 0) throw new Error('Unterminated PostgreSQL dollar-quoted body.')
        i = end + match[0].length
      } else {
        visible += sql[i++]
        continue
      }
    } else {
      if (sql[i] === ';') separators.push(i)
      visible += sql[i++]
      continue
    }
    visible += sql.slice(start, i).replace(/[^\n]/g, ' ')
  }
  return { separators, visible }
}

export function splitStatements(sql: string, dialect: SqlDialect = 'postgres'): SqlStatement[] {
  const { separators, visible } = scan(sql, dialect)
  if (
    dialect === 'mariadb' &&
    (/^\s*DELIMITER\b/im.test(visible) ||
      (/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(
        visible,
      ) &&
        /\bBEGIN\b/i.test(visible)))
  ) {
    throw new Error(
      'Current-statement scope is ambiguous for MariaDB compound routines. Select the complete routine or use Run script; omit client DELIMITER directives.',
    )
  }
  const result: SqlStatement[] = []
  let start = 0
  for (const separator of [...separators, sql.length]) {
    const end = separator < sql.length ? separator + 1 : separator
    if (
      visible.slice(start, separator).trim() ||
      /['"`$]/.test(sql.slice(start, separator).replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ''))
    ) {
      result.push({ text: sql.slice(start, end), start, end })
    }
    start = end
  }
  return result
}

export function currentStatement(
  sql: string,
  offset: number,
  dialect: SqlDialect = 'postgres',
): SqlStatement | null {
  const statements = splitStatements(sql, dialect)
  const position = Math.max(0, Math.min(sql.length, offset))
  return (
    statements.find((statement) => position >= statement.start && position < statement.end) ??
    statements.find((statement) => statement.start >= position) ??
    statements.at(-1) ??
    null
  )
}

export function quoteIdentifier(identifier: string, dialect: SqlDialect): string {
  if (!identifier || identifier.includes('\0'))
    throw new Error('Invalid empty or NUL-containing SQL identifier.')
  const quote = dialect === 'postgres' ? '"' : '`'
  return quote + identifier.replaceAll(quote, quote + quote) + quote
}

export function qualifiedName(schema: string, table: string, dialect: SqlDialect): string {
  return schema
    ? `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`
    : quoteIdentifier(table, dialect)
}

export function sqlSafety(
  sql: string,
  dialect: SqlDialect,
): { readOnly: boolean; destructive: boolean; controlsTransaction: boolean; statementCount: number } {
  const { visible, separators } = scan(sql, dialect)
  let start = 0
  const chunks = [...separators, sql.length]
    .map((end) => {
      const text = visible.slice(start, end).trim()
      start = end + 1
      return text
    })
    .filter(Boolean)
  const executableComment = dialect === 'mariadb' && /\/\*(?:!|M!)/i.test(sql)
  const readOnly =
    !executableComment &&
    chunks.length > 0 &&
    chunks.every(
      (text) =>
        /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|VALUES|TABLE)\b/i.test(text) &&
        !/\b(INSERT|UPDATE|DELETE|MERGE|CALL|COPY|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|INTO|SET_CONFIG|NEXTVAL|SETVAL|PG_TERMINATE_BACKEND)\b/i.test(
          text,
        ),
    )
  return {
    readOnly,
    statementCount: chunks.length,
    destructive:
      executableComment ||
      /\b(DROP|TRUNCATE)\b/i.test(visible) ||
      chunks.some((text) => /^\s*(DELETE|UPDATE)\b/i.test(text) && !/\bWHERE\b/i.test(text)),
    controlsTransaction: chunks.some((text) =>
      /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET|RESET|DISCARD|USE)\b/i.test(
        text,
      ),
    ),
  }
}

/** The same confirmation token is checked by the UI and privileged adapter. */
export function requiredSqlConfirmation(
  sql: string,
  dialect: SqlDialect,
  profile: { name: string; environment: string },
): string | undefined {
  const { visible } = scan(sql, dialect)
  const drops = [...visible.matchAll(/\bDROP\s+(?:DATABASE|SCHEMA)\b(?:\s+IF\s+EXISTS\b)?/gi)]
  if (drops.length > 1)
    throw new Error('Drop databases or schemas one at a time so each target can be explicitly confirmed.')
  if (drops.length) {
    const match = drops[0]
    const tail = sql.slice(match.index! + match[0].length).trimStart()
    const identifier = /^(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|([^\s;,.]+))/.exec(tail)
    if (!identifier || tail.slice(identifier[0].length).trimStart().startsWith(','))
      throw new Error('Specify exactly one database or schema to drop.')
    return (identifier[1] ?? identifier[2] ?? identifier[3]).replaceAll('""', '"').replaceAll('``', '`')
  }
  const safety = sqlSafety(sql, dialect)
  return safety.destructive || (profile.environment.toLowerCase() === 'production' && !safety.readOnly)
    ? profile.name
    : undefined
}
