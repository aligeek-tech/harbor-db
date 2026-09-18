import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MetadataStore, SCHEMA_VERSION } from '../src/main/persistence/store'
import { profileSchema } from '../src/shared/contracts'
import { reportDefinitionSchema } from '../src/shared/reports'

const paths: string[] = [], stores: MetadataStore[] = []
const open = (path = mkdtempSync(join(tmpdir(), 'harbor-report-metadata-'))) => {
  if (!paths.includes(path)) paths.push(path)
  const store = new MetadataStore(path); stores.push(store); return { store, path }
}
const close = (store: MetadataStore) => { store.close(); stores.splice(stores.indexOf(store), 1) }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
const report = () => reportDefinitionSchema.parse({ id: 'r1', name: 'Exact data report', engine: 'duckdb', sql: 'SELECT :amount', parameterDefinitions: [{ name: 'amount', type: 'decimal', secret: true }], view: { kind: 'bar', categoryColumn: 0, valueColumn: 1, maxPoints: 42 }, filters: [{ column: 0, operator: 'equals', value: '' }], createdAt: 'caller-created', updatedAt: 'caller-updated' })

it('migrates v4 with a recoverable backup, preserves drafts, and starts an empty report library', () => {
  const { store, path } = open(); close(store)
  const old = new DatabaseSync(join(path, 'harbor.sqlite3'))
  old.exec('DROP TABLE reports; PRAGMA user_version=4'); old.close()
  const migrated = open(path).store
  expect(migrated.reports()).toEqual([])
  const backup = readdirSync(path).find((name) => name.includes(`before-v${SCHEMA_VERSION}`))!
  const archived = new DatabaseSync(join(path, backup))
  try { expect(archived.prepare('PRAGMA user_version').get()?.user_version).toBe(4); expect(archived.prepare("SELECT name FROM sqlite_master WHERE name='reports'").all()).toEqual([]) } finally { archived.close() }
})

it('round-trips only strict definitions and ordinal view settings; profile removal keeps reports unbound', () => {
  const { store, path } = open()
  store.saveProfile(profileSchema.parse({ id: 'duck', name: 'Duck', engine: 'duckdb', host: 'localhost', port: 1 }))
  const saved = store.saveReport({ ...report(), connectionId: 'duck' })
  expect(saved.createdAt).not.toBe('caller-created')
  const changed = store.saveReport({ ...saved, name: 'Updated', createdAt: 'forged' })
  expect(changed.createdAt).toBe(saved.createdAt)
  store.deleteProfile('duck')
  const unbound = store.reports()[0]
  expect(unbound.connectionId).toBeUndefined()
  expect(unbound).toMatchObject({ name: 'Updated', sql: 'SELECT :amount', view: { maxPoints: 42, categoryColumn: 0, valueColumn: 1 }, parameterDefinitions: [{ secret: true }] })
  close(store)
  const restored = open(path).store
  expect(restored.reports()).toEqual([unbound])
  restored.deleteReport(unbound.id); expect(restored.reports()).toEqual([])
})

it('refuses runtime values, results and incompatible or missing bindings instead of persisting them', () => {
  const { store } = open()
  store.saveProfile(profileSchema.parse({ id: 'pg', name: 'PG', engine: 'postgres', host: 'localhost', port: 5432 }))
  for (const extra of [{ parameterValues: { amount: 'secret-runtime' } }, { rows: [['secret-result']] }, { password: 'secret' }])
    expect(() => store.saveReport({ ...report(), ...extra })).toThrow()
  expect(() => store.saveReport({ ...report(), connectionId: 'pg' })).toThrow(/compatible DuckDB/)
  expect(() => store.saveReport({ ...report(), connectionId: 'missing' })).toThrow()
  expect(store.reports()).toEqual([])
})
