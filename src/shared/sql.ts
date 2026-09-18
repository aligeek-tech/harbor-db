import { db2Visible, db2Safety } from './db2'
import { oracleVisible, oracleProgram, oracleSafety, oracleConfirmation, oracleQuote } from './oracle'
import { mssqlVisible, mssqlSafety, mssqlConfirmation, mssqlQuote } from './mssql'
export type SqlDialect = 'postgres' | 'mariadb' | 'mysql' | 'sqlite' | 'duckdb' | 'mssql' | 'clickhouse' | 'oracle' | 'trino' | 'bigquery' | 'snowflake' | 'databricks' | 'athena' | 'firebird' | 'hana' | 'db2'
export function sqlDialect(engine: string): SqlDialect {
  if(engine==='db2')return 'db2'
  if (['cockroachdb', 'yugabytedb', 'redshift'].includes(engine)) return 'postgres'
  if (['tidb', 'vitess'].includes(engine)) return 'mysql'
  if (
    engine === 'postgres' ||
    engine === 'mariadb' ||
    engine === 'mysql' ||
    engine === 'sqlite' ||
    engine === 'duckdb' ||
    engine === 'mssql' || engine === 'clickhouse' || engine === 'oracle' || engine === 'trino' || engine === 'bigquery' || engine === 'snowflake' || engine === 'databricks' || engine === 'athena' || engine === 'firebird' || engine === 'hana'
  )
    return engine
  throw new Error('This engine does not use the SQL editor.')
}
export interface SqlStatement {
  text: string
  start: number
  end: number
}

/** Lexical SQL scanner. Offsets are UTF-16 offsets, matching Monaco's model. */
function scan(sql: string, dialect: SqlDialect): { separators: number[]; visible: string } {
  if (dialect === 'db2') { const visible = db2Visible(sql); return { visible, separators: [...visible.matchAll(/;/g)].map((match) => match.index!) } }
  if (dialect === 'oracle') {
    const visible=oracleVisible(sql)
    return {visible,separators:[...visible.matchAll(/;/g)].map(match=>match.index!)}
  }
  if (dialect === 'mssql') {
    mssqlSafety(sql)
    const visible = mssqlVisible(sql)
    return { visible, separators: [...visible.matchAll(/;/g)].map((match) => match.index!) }
  }
  if (dialect === 'mysql' || dialect === 'clickhouse') dialect = 'mariadb'
  if (dialect === 'bigquery' || dialect === 'databricks') dialect = 'mariadb'
  if (dialect === 'snowflake') dialect = 'postgres'
  if (dialect === 'duckdb') dialect = 'postgres'
  let visible = ''
  const separators: number[] = []
  for (let i = 0; i < sql.length;) {
    const start = i
    if (
      (sql.startsWith('--', i) && (dialect !== 'mariadb' || /\s/.test(sql[i + 2] ?? ' '))) ||
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
    } else if (
      sql[i] === "'" ||
      sql[i] === '"' ||
      (['mariadb', 'sqlite'].includes(dialect) && sql[i] === '`') ||
      (dialect === 'sqlite' && sql[i] === '[')
    ) {
      const open = sql[i++]
      const quote = open === '[' ? ']' : open
      const backslash =
        dialect === 'mariadb' ||
        (dialect === 'postgres' && quote === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(0, start)))
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
  if(dialect==='oracle'&&oracleProgram(visible))throw new Error('Current-statement scope is ambiguous for Oracle PL/SQL. Select the complete block or use Run script.')
  if (dialect === 'mssql' && /\b(?:BEGIN|PROCEDURE|PROC|TRIGGER|FUNCTION)\b/i.test(visible))
    throw new Error(
      'Current-statement scope is ambiguous for T-SQL blocks. Select the complete block or use Run script; omit client GO directives.',
    )
  if (
    (dialect === 'mariadb' || dialect === 'mysql') &&
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
  if (dialect === 'oracle') return oracleQuote(identifier)
  if (dialect === 'mssql') return mssqlQuote(identifier)
  if (!identifier || identifier.includes('\0'))
    throw new Error('Invalid empty or NUL-containing SQL identifier.')
  const quote = dialect === 'mariadb' || dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'bigquery' || dialect === 'databricks' ? '`' : '"'
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
  if (dialect === 'db2') return db2Safety(sql)
  if (dialect === 'oracle') return oracleSafety(sql)
  if (dialect === 'mssql') return mssqlSafety(sql)
  const { visible, separators } = scan(sql, dialect)
  let start = 0
  const chunks = [...separators, sql.length]
    .map((end) => {
      const text = visible.slice(start, end).trim()
      start = end + 1
      return text
    })
    .filter(Boolean)
  const executableComment = (dialect === 'mariadb' || dialect === 'mysql') && /\/\*(?:!|M!)/i.test(sql)
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
  if (dialect === 'oracle') return oracleConfirmation(sql,profile)
  if (dialect === 'mssql') return mssqlConfirmation(sql, profile)
  if (['bigquery', 'snowflake', 'databricks', 'athena'].includes(dialect)) return profile.name
  if (['trino', 'hana'].includes(dialect) && !sqlSafety(sql, dialect).readOnly) return profile.name
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
