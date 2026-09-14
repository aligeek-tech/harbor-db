import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { profileSchema } from '../src/shared/contracts'
import {
  CredentialService,
  redactHistory,
  type SecureStorageProvider,
} from '../src/main/persistence/credentials'
import {
  defaultWorkspace,
  MetadataStore,
  PersistenceRecoveryError,
  SCHEMA_VERSION,
} from '../src/main/persistence/store'
import { exportLoadedData } from '../src/main/persistence/export'

const temporary: string[] = []
const openStores: MetadataStore[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'harbor-test-'))
  temporary.push(path)
  return path
}
const openStore = (path = directory()) => {
  const store = new MetadataStore(path)
  openStores.push(store)
  return store
}
const close = (store: MetadataStore) => {
  store.close()
  openStores.splice(openStores.indexOf(store), 1)
}
afterEach(() => {
  for (const store of openStores.splice(0)) store.close()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const profile = (overrides = {}) =>
  profileSchema.parse({
    id: 'alpha',
    name: 'Local PostgreSQL',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'harbor',
    ...overrides,
  })

function protectedProvider() {
  // OS storage is replaced only in unit tests; fresh random key, authenticated ciphertext.
  const key = randomBytes(32)
  let locked = false
  const provider: SecureStorageProvider = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => {
      if (locked) throw new Error('locked')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString: (value) => {
      if (locked) throw new Error('locked')
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString()
    },
  }
  return {
    provider,
    lock: () => {
      locked = true
    },
    unlock: () => {
      locked = false
    },
  }
}

describe('SQLite metadata and restoration', () => {
  it('preserves profiles, exact drafts, settings and secrets across reopen without starting connections', () => {
    const path = directory()
    let store = openStore(path)
    store.saveProfile(profile())
    const workspace = defaultWorkspace()
    workspace.tabs = [
      {
        id: 'tab-1',
        connectionId: 'alpha',
        kind: 'query',
        title: 'Analysis',
        sql: 'select 9007199254740993;',
        cursor: 17,
        scrollTop: 36,
      },
    ]
    workspace.activeTabId = 'tab-1'
    workspace.settings.theme = 'dark'
    store.saveWorkspace(workspace)
    const { provider } = protectedProvider()
    const credentials = new CredentialService(provider, store, 'linux')
    const prepared = credentials.prepare('alpha', { password: 'never-plaintext-123' }, true)
    store.writeCredential('alpha', prepared.credential!)
    close(store)
    expect(readFileSync(join(path, 'harbor.sqlite3')).includes(Buffer.from('never-plaintext-123'))).toBe(
      false,
    )
    store = openStore(path)
    expect(store.profiles()[0]).toMatchObject({ id: 'alpha', hasPassword: true })
    expect(store.workspace()).toEqual(workspace)
    expect(new CredentialService(provider, store, 'linux').resolve('alpha')).toEqual({
      password: 'never-plaintext-123',
    })
    expect(store.exportProfiles()).not.toContain('never-plaintext')
    expect(store.exportProfiles()).toContain('"hasPassword": false')
  })
  it('rolls back a failed metadata and credential transaction', () => {
    const store = openStore()
    expect(() =>
      store.transaction(() => {
        store.saveProfile(profile())
        throw new Error('simulated write failure')
      }),
    ).toThrow('simulated write failure')
    expect(store.profiles()).toEqual([])
  })
  it('migrates a prior schema transactionally with a recoverable backup', () => {
    const path = directory()
    const initial = openStore(path)
    initial.saveProfile(profile())
    close(initial)
    const db = new DatabaseSync(join(path, 'harbor.sqlite3'))
    db.exec('DROP INDEX history_executed; DROP INDEX history_connection; PRAGMA user_version=1;')
    db.close()
    const upgraded = openStore(path)
    expect(upgraded.profiles()[0]?.id).toBe('alpha')
    expect(readdirSync(path).some((name) => name.includes(`before-v${SCHEMA_VERSION}`))).toBe(true)
  })
  it('preserves corrupt metadata and refuses silent reset', () => {
    const path = directory()
    const bytes = Buffer.from('intentionally damaged metadata')
    writeFileSync(join(path, 'harbor.sqlite3'), bytes)
    expect(() => new MetadataStore(path)).toThrow(PersistenceRecoveryError)
    expect(readFileSync(join(path, 'harbor.sqlite3'))).toEqual(bytes)
  })
  it('preserves an ordinary workspace when private mode is active and suppresses history', () => {
    const store = openStore()
    store.saveProfile(profile())
    const workspace = defaultWorkspace()
    workspace.tabs = [{ id: 'tab-1', connectionId: 'alpha', kind: 'query', title: 'Query', sql: 'select 1' }]
    store.saveWorkspace(workspace)
    workspace.settings.privateSession = true
    workspace.tabs[0]!.sql = 'select private_value'
    store.saveWorkspace(workspace)
    store.addHistory({
      connectionId: 'alpha',
      sql: 'select private_value',
      executedAt: new Date().toISOString(),
      durationMs: 1,
      rowCount: 1,
      success: true,
    })
    expect(store.workspace().tabs[0]?.sql).toBe('select 1')
    expect(store.history()).toEqual([])
    store.clearDrafts()
    expect(store.workspace().tabs[0]?.sql).toBe('')
  })
  it('deletes related secrets, tabs and history while retaining saved query text unassociated', () => {
    const store = openStore()
    store.saveProfile(profile())
    const workspace = defaultWorkspace()
    workspace.tabs = [{ id: 'tab-1', connectionId: 'alpha', kind: 'query', title: 'Query', sql: 'select 1' }]
    workspace.activeTabId = 'tab-1'
    store.saveWorkspace(workspace)
    store.writeCredential('alpha', {
      ciphertext: new Uint8Array([1]),
      hasPassword: true,
      hasSshPassword: false,
      hasPassphrase: false,
    })
    store.saveQuery({
      id: 'query-1',
      name: 'saved',
      sql: 'select 1',
      connectionId: 'alpha',
      engine: 'postgres',
      folder: '',
      tags: [],
      updatedAt: new Date().toISOString(),
    })
    store.addHistory({
      connectionId: 'alpha',
      sql: 'select 1',
      executedAt: new Date().toISOString(),
      durationMs: 1,
      rowCount: 1,
      success: true,
    })
    store.deleteProfile('alpha')
    expect(store.profiles()).toEqual([])
    expect(store.workspace().tabs).toEqual([])
    expect(store.workspace().activeTabId).toBeNull()
    expect(store.getCredential('alpha')).toBeUndefined()
    expect(store.history()).toEqual([])
    expect(store.queries()[0]).toMatchObject({ sql: 'select 1' })
    expect(store.queries()[0]?.connectionId).toBeUndefined()
  })
  it('imports strict versioned metadata with new IDs and explicit duplicate names', () => {
    const store = openStore()
    store.saveProfile(profile())
    const input = { format: 'harbor-db-connections', version: 1, profiles: [profile(), profile()] }
    const preview = store.previewImport(input)
    expect(new Set(preview.map((item) => item.id)).size).toBe(2)
    expect(preview.map((item) => item.name)).toEqual([
      'Local PostgreSQL (imported 1)',
      'Local PostgreSQL (imported 2)',
    ])
    expect(store.profiles()).toHaveLength(1)
    store.importProfiles(preview)
    expect(store.profiles()).toHaveLength(3)
    expect(() => store.previewImport({ ...input, version: 2 })).toThrow()
    expect(() =>
      store.previewImport({ ...input, profiles: [{ ...profile(), password: 'secret' }] }),
    ).toThrow()
  })
  it('removes deleted-profile tabs in private mode while preserving unrelated ordinary drafts', () => {
    const store = openStore()
    store.saveProfile(profile())
    store.saveProfile(profile({ id: 'beta', name: 'Other connection' }))
    const workspace = defaultWorkspace()
    workspace.tabs = [
      { id: 'a', connectionId: 'alpha', kind: 'query', title: 'Deleted', sql: 'select 1' },
      { id: 'b', connectionId: 'beta', kind: 'query', title: 'Preserved', sql: 'select ordinary_draft' },
    ]
    workspace.activeTabId = 'a'
    store.saveWorkspace(workspace)
    workspace.settings.privateSession = true
    workspace.tabs[1]!.sql = 'private text'
    store.saveWorkspace(workspace)
    store.deleteProfile('alpha')
    expect(store.workspace().tabs).toEqual([
      { id: 'b', connectionId: 'beta', kind: 'query', title: 'Preserved', sql: 'select ordinary_draft' },
    ])
    expect(store.workspace().activeTabId).toBe('b')
    expect(store.workspace().settings.privateSession).toBe(true)
  })
})

describe('credential storage security', () => {
  it.each(['basic_text', 'unknown', 'plaintext', ''])(
    'refuses Linux backend %j and allows session-only credentials',
    (backend) => {
      const store = openStore()
      store.saveProfile(profile())
      const { provider } = protectedProvider()
      provider.getSelectedStorageBackend = () => backend
      const service = new CredentialService(provider, store, 'linux')
      expect(service.status().available).toBe(false)
      const prepared = service.prepare('alpha', { password: 'temporary' }, true)
      expect(prepared.credential).toBeUndefined()
      service.rememberSession('alpha', prepared.session)
      expect(service.resolve('alpha')).toEqual({ password: 'temporary' })
      service.clearSession('alpha')
      expect(service.resolve('alpha')).toEqual({})
    },
  )
  it('preserves encrypted credentials when the keyring locks and supports supplying a temporary replacement', () => {
    const store = openStore()
    store.saveProfile(profile())
    const fake = protectedProvider()
    const service = new CredentialService(fake.provider, store, 'linux')
    const prepared = service.prepare('alpha', { password: 'remembered' }, true)
    store.writeCredential('alpha', prepared.credential!)
    const before = store.getCredential('alpha')!.ciphertext
    fake.lock()
    expect(() => service.resolve('alpha')).toThrow('preserved')
    expect(service.status()).toMatchObject({ available: false, reason: expect.stringContaining('unlocked') })
    expect(service.prepare('alpha', { password: 'new' }, true).credential?.ciphertext).toEqual(before)
    expect(service.resolve('alpha', { password: 'temporary' })).toEqual({ password: 'temporary' })
    service.clearSession('alpha')
    fake.unlock()
    expect(service.resolve('alpha')).toEqual({ password: 'remembered' })
    expect(service.status().available).toBe(true)
  })
  it('reports encryption lock failures while retaining session-only input, then recovers on explicit retry', () => {
    const store = openStore()
    store.saveProfile(profile())
    const fake = protectedProvider()
    const service = new CredentialService(fake.provider, store, 'linux')
    fake.lock()
    const prepared = service.prepare('alpha', { password: 'session-only' }, true)
    expect(prepared.credential).toBeUndefined()
    expect(prepared.session).toEqual({ password: 'session-only' })
    expect(service.status()).toMatchObject({
      available: false,
      reason: expect.stringContaining('could not encrypt'),
    })
    fake.unlock()
    expect(service.prepare('alpha', { password: 'session-only' }, true).credential).toBeDefined()
    expect(service.status().available).toBe(true)
  })
  it('redacts authentication and password-bearing command history and driver errors', () => {
    for (const query of [
      'AUTH secret',
      'HELLO 3 AUTH default password',
      'ACL SETUSER bob >secret',
      "ALTER ROLE bob PASSWORD 'secret'",
      'CONFIG SET requirepass secret',
      "select 'postgres://user:secret@localhost/db'",
    ])
      expect(redactHistory(query)).toBe('[Credential-bearing command omitted]')
    expect(redactHistory('SELECT * FROM users')).toBe('SELECT * FROM users')
    const store = openStore()
    const service = new CredentialService(protectedProvider().provider, store, 'linux')
    service.rememberSession('alpha', { password: 'very-secret' })
    expect(
      service.sanitize(
        new Error('Failed redis://bob:very-secret@localhost because very-secret was rejected'),
      ),
    ).not.toContain('very-secret')
  })
})

describe('bounded result exports', () => {
  it('exports ordered JSON without losing duplicate column names, exact integers, binary or NULL', async () => {
    const path = join(directory(), 'results.json')
    const data = {
      format: 'json' as const,
      columns: [
        { name: 'id', type: 'int8' },
        { name: 'id', type: 'text' },
      ],
      rows: [
        ['9007199254740993', null],
        [{ type: 'binary' as const, base64: 'AP8=' }, '東京'],
      ],
      spreadsheetSafe: true,
      scope: 'loaded results',
    }
    await exportLoadedData(path, data)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      columns: data.columns,
      rows: data.rows,
      scope: 'loaded results',
    })
  })
  it('uses explicit NULL and formula-safe quoted Unicode CSV', async () => {
    const path = join(directory(), 'results.csv')
    await exportLoadedData(path, {
      format: 'csv',
      columns: [{ name: 'value', type: 'text' }],
      rows: [[null], [''], ['=SUM(A1)'], ['東京, "value"']],
      spreadsheetSafe: true,
      scope: 'loaded results',
    })
    expect(readFileSync(path, 'utf8')).toBe('"value"\r\n\\N\r\n""\r\n"\'=SUM(A1)"\r\n"東京, ""value"""\r\n')
  })
})
