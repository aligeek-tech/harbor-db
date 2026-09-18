import type { ConnectionProfile } from './contracts'

export const db2Limitation =
  'Db2 LUW 11.5/12.1, UTF-8 databases only. An approved ibm_db 4.0.1 native runtime must be provisioned separately. This initial slice provides guarded reads; transactions, writes, LOB/XML and administration are unavailable. Table text is limited to 511 declared bytes. Raw text, decimal and timestamp outputs are refused because this driver can lose precision; inspect them as explicitly cast binary values or use table browsing. Cancellation closes the client process; server completion is unconfirmed.'

/** Db2 uses doubled SQL quotes, standard comments and nested block comments. */
export function db2Visible(sql: string): string {
  let visible = ''
  for (let i = 0; i < sql.length;) {
    const start = i
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) throw new Error('Complete the Db2 comment before running the statement.')
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]
      let closed = false
      while (i < sql.length) {
        if (sql[i++] === quote) {
          if (sql[i] === quote) i++
          else {
            closed = true
            break
          }
        }
      }
      if (!closed) throw new Error('Complete the Db2 string or identifier before running the statement.')
    } else {
      visible += sql[i++]
      continue
    }
    visible += sql.slice(start, i).replace(/[^\n]/g, ' ')
  }
  return visible
}

export function db2Safety(sql: string) {
  const visible = db2Visible(sql)
  const statements = visible.split(';').filter((part) => part.trim())
  const controlsTransaction = /\b(?:SET|COMMIT|ROLLBACK|CONNECT|DISCONNECT|BEGIN|SAVEPOINT|RELEASE)\b/i.test(
    visible,
  )
  const mutation =
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|GRANT|REVOKE|INTO|NEXT\s+VALUE|FINAL\s+TABLE|OLD\s+TABLE|NEW\s+TABLE)\b/i.test(
      visible,
    )
  return {
    readOnly:
      statements.length === 1 &&
      /^\s*(?:SELECT|WITH|VALUES)\b/i.test(visible) &&
      !controlsTransaction &&
      !mutation,
    destructive: mutation,
    controlsTransaction,
    statementCount: statements.length,
  }
}

export function assertDb2Query(sql: string): void {
  if (sql.includes('\0') || sql.length > 1000000)
    throw new Error('Db2 SQL cannot contain NUL or exceed the query size limit.')
  if (!db2Safety(sql).readOnly)
    throw new Error(
      'Db2 currently accepts one guarded SELECT, WITH or VALUES statement. Session controls, data-change table expressions and writes are unavailable. Database grants remain the security boundary.',
    )
}

export function assertDb2Profile(profile: ConnectionProfile): void {
  if (profile.engine !== 'db2') throw new Error('Select the IBM Db2 adapter.')
  if (!profile.database.trim() || !profile.schema.trim() || !profile.username.trim())
    throw new Error('Db2 requires an explicit database, schema and username.')
  if (!profile.readOnly || profile.autoReconnect)
    throw new Error(
      'Db2 requires guarded browsing and explicit reconnect; writes and automatic replay are unavailable.',
    )
  if (profile.managed.provider !== 'none') throw new Error('Managed base-engine presets do not apply to Db2.')
  if (profile.tls.enabled && !profile.tls.rejectUnauthorized)
    throw new Error('Db2 TLS requires certificate and hostname verification.')
  if (profile.tls.cert || profile.tls.keyPath)
    throw new Error(
      'Db2 client certificate authentication is not implemented; use database credentials and a trusted CA.',
    )
}

export function db2Quote(value: string): string {
  if (!value || value.includes('\0') || value.length > 255) throw new Error('Invalid Db2 identifier.')
  return '"' + value.replaceAll('"', '""') + '"'
}

/** Reject connection-string control syntax, including in passwords; never interpolate it. */
export function db2ConnectionValue(value: string): string {
  if (!value || /[;{}\r\n\0]/.test(value))
    throw new Error(
      'Db2 connection values cannot contain semicolons, braces or control characters in this initial driver integration.',
    )
  return value
}
