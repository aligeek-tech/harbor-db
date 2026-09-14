import { describe, expect, it } from 'vitest'
import {
  currentStatement,
  qualifiedName,
  quoteIdentifier,
  requiredSqlConfirmation,
  splitStatements,
  sqlSafety,
} from '../src/shared/sql'
import { losslessCell } from '../src/main/engines/sql'

describe('dialect-aware SQL execution scope', () => {
  it('preserves semicolons in strings, quoted identifiers, comments and PostgreSQL function bodies', () => {
    const sql = `-- ; comment\nSELECT ';', "a;b";\n/* outer ; /* nested ; */ */\nCREATE FUNCTION demo() RETURNS text AS $body$ BEGIN RETURN ';'; END; $body$ LANGUAGE plpgsql;\nSELECT 3;`
    const statements = splitStatements(sql)
    expect(statements).toHaveLength(3)
    expect(statements[1].text).toContain("RETURN ';';")
    expect(currentStatement(sql, sql.indexOf('RETURN'))).toEqual(statements[1])
    expect(statements.map((statement) => sql.slice(statement.start, statement.end))).toEqual(
      statements.map((statement) => statement.text),
    )
  })
  it('handles escaped strings, MariaDB backticks, hash comments and whitespace-sensitive dash comments', () => {
    expect(splitStatements("SELECT E'a\\';b'; SELECT 2;")).toHaveLength(2)
    expect(
      splitStatements("SELECT 'it\\'s;still', `a;b`; # ; ignored\nSELECT 1--2; SELECT 3;", 'mariadb'),
    ).toHaveLength(3)
    expect(splitStatements("SELECT 'it''s;still'; SELECT 2;")).toHaveLength(2)
  })
  it('refuses ambiguous or incomplete scope', () => {
    expect(() => splitStatements("SELECT 'unfinished")).toThrow('Unterminated')
    expect(() => splitStatements('SELECT $tag$unfinished')).toThrow('Unterminated')
    expect(() => splitStatements('SELECT 1; /* unfinished')).toThrow('Unterminated')
    expect(() => splitStatements('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;', 'mariadb')).toThrow(
      'ambiguous',
    )
    expect(() => splitStatements('DELIMITER $$\nSELECT 1$$', 'mariadb')).toThrow('ambiguous')
  })
  it('handles whitespace, empty editor, statement boundaries, and a trailing comment', () => {
    expect(currentStatement('', 0)).toBeNull()
    expect(splitStatements('-- comment\n/* more */')).toEqual([])
    expect(currentStatement('SELECT 1; SELECT 2;', 9)?.text.trim()).toBe('SELECT 2;')
    expect(currentStatement('SELECT 1;\n-- last', 17)?.text).toBe('SELECT 1;')
  })
})

describe('SQL safeguards and value fidelity', () => {
  it('quotes identifiers for each dialect without accepting NUL or empty identifiers', () => {
    expect(quoteIdentifier('odd"; DROP TABLE x; --', 'postgres')).toBe('"odd""; DROP TABLE x; --"')
    expect(qualifiedName('a`b', 'c.d', 'mariadb')).toBe('`a``b`.`c.d`')
    expect(() => quoteIdentifier('x\0y', 'postgres')).toThrow('Invalid')
    expect(() => quoteIdentifier('', 'mariadb')).toThrow('Invalid')
  })
  it('rejects CTE writes, executable comments, file writes and transaction escapes in read-only profiles', () => {
    expect(sqlSafety("SELECT 'DROP TABLE users;';", 'postgres').readOnly).toBe(true)
    expect(sqlSafety('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'postgres').readOnly).toBe(
      false,
    )
    expect(sqlSafety('SELECT 1; COMMIT; INSERT INTO t VALUES(1)', 'postgres').readOnly).toBe(false)
    expect(sqlSafety('SELECT 1 /*! INTO OUTFILE "/tmp/evil" */', 'mariadb').readOnly).toBe(false)
    expect(sqlSafety('EXPLAIN ANALYZE DELETE FROM t', 'postgres').readOnly).toBe(false)
    expect(sqlSafety('TRUNCATE "users"', 'postgres').destructive).toBe(true)
    expect(sqlSafety("UPDATE users SET name='x'", 'postgres').destructive).toBe(true)
    expect(sqlSafety('COMMIT', 'postgres').controlsTransaction).toBe(true)
  })
  it('preserves bigint, decimals, binary, null, dates and raw JSON without numeric coercion', () => {
    expect(losslessCell(900719925474099312345n)).toBe('900719925474099312345')
    expect(losslessCell('1000000000000000000.000000001')).toBe('1000000000000000000.000000001')
    expect(losslessCell('{"n":9007199254740993}')).toBe('{"n":9007199254740993}')
    expect(losslessCell(Buffer.from([0, 255, 128]))).toEqual({ type: 'binary', base64: 'AP+A' })
    expect(losslessCell(null)).toBeNull()
    expect(losslessCell('')).toBe('')
    expect(losslessCell(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
    expect(() => losslessCell({ n: 9007199254740992 })).toThrow('lossy')
  })
  it('requires the named database or schema for high-impact confirmation', () => {
    const profile = { name: 'Warehouse', environment: 'production' }
    expect(requiredSqlConfirmation('DROP DATABASE IF EXISTS "my db"', 'postgres', profile)).toBe('my db')
    expect(requiredSqlConfirmation('DROP SCHEMA `odd``name`', 'mariadb', profile)).toBe('odd`name')
    expect(requiredSqlConfirmation('DELETE FROM users', 'postgres', profile)).toBe('Warehouse')
    expect(requiredSqlConfirmation('SELECT 1', 'postgres', profile)).toBeUndefined()
    expect(() => requiredSqlConfirmation('DROP SCHEMA a,b', 'postgres', profile)).toThrow('one')
  })
})
