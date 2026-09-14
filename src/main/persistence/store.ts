import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  importSchema,
  profileSchema,
  savedQuerySchema,
  settingsSchema,
  workspaceSchema,
  type ConnectionProfile,
  type HistoryEntry,
  type SavedQuery,
  type Workspace,
} from '../../shared/contracts'
import type { CredentialRepository, StoredCredential } from './credentials'
import { redactHistory } from './credentials'

export const SCHEMA_VERSION = 2
export const defaultWorkspace = (): Workspace => ({
  tabs: [],
  activeTabId: null,
  expanded: [],
  settings: settingsSchema.parse({}),
})
export class PersistenceRecoveryError extends Error {
  constructor(
    public databasePath: string,
    detail: string,
  ) {
    super(
      `Harbor DB could not open its application metadata at ${databasePath}. ${detail} The original files have been preserved. Restore an application-data backup or choose a new user-data directory; managed databases are unaffected.`,
    )
    this.name = 'PersistenceRecoveryError'
  }
}
type RawRow = Record<string, unknown>

export class MetadataStore implements CredentialRepository {
  readonly path: string
  private db: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'harbor.sqlite3')
    const existed = existsSync(this.path)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.path)
      this.db = db
      chmodSync(this.path, 0o600)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;')
      const integrity = db.prepare('PRAGMA quick_check').get() as RawRow
      if (integrity.quick_check !== 'ok') throw new Error('The SQLite integrity check failed.')
      const version = Number((db.prepare('PRAGMA user_version').get() as RawRow).user_version)
      if (version > SCHEMA_VERSION)
        throw new Error(
          `This metadata uses schema ${version}; this app supports up to ${SCHEMA_VERSION}. Use a newer Harbor DB release.`,
        )
      if (existed && version < SCHEMA_VERSION) {
        const backupPath = `${this.path}.before-v${SCHEMA_VERSION}-${Date.now()}.backup`
        db.prepare('VACUUM INTO ?').run(backupPath)
        chmodSync(backupPath, 0o600)
      }
      this.transaction(() => {
        if (version < 1)
          db!.exec(`
          CREATE TABLE profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE credentials (connection_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, ciphertext BLOB NOT NULL, has_password INTEGER NOT NULL, has_ssh_password INTEGER NOT NULL, has_passphrase INTEGER NOT NULL);
          CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
          CREATE TABLE saved_queries (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE history (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, executed_at TEXT NOT NULL, data TEXT NOT NULL);
        `)
        if (version < 2)
          db!.exec(
            'CREATE INDEX IF NOT EXISTS history_executed ON history(executed_at); CREATE INDEX IF NOT EXISTS history_connection ON history(connection_id);',
          )
        db!.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
      })
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.pruneHistory()
    } catch (error) {
      try {
        db?.close()
      } catch {
        /* Preserve the original error. */
      }
      throw new PersistenceRecoveryError(
        this.path,
        error instanceof Error ? error.message : 'Unknown SQLite error.',
      )
    }
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  profiles(): ConnectionProfile[] {
    return this.db
      .prepare('SELECT data FROM profiles ORDER BY created_at, id')
      .all()
      .map((row) => this.profileWithFlags(profileSchema.parse(JSON.parse(String(row.data)))))
  }
  profile(id: string): ConnectionProfile {
    const row = this.db.prepare('SELECT data FROM profiles WHERE id=?').get(id)
    if (!row) throw new Error('Connection profile no longer exists. Reopen the connection list.')
    return this.profileWithFlags(profileSchema.parse(JSON.parse(String(row.data))))
  }
  hasProfile(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM profiles WHERE id=?').get(id)
  }
  private profileWithFlags(profile: ConnectionProfile): ConnectionProfile {
    const credential = this.getCredential(profile.id)
    return {
      ...profile,
      hasPassword: credential?.hasPassword ?? false,
      hasSshPassword: credential?.hasSshPassword ?? false,
      hasPassphrase: credential?.hasPassphrase ?? false,
    }
  }
  saveProfile(profile: ConnectionProfile): void {
    const clean = profileSchema.parse({
      ...profile,
      hasPassword: false,
      hasSshPassword: false,
      hasPassphrase: false,
    })
    this.db
      .prepare(
        'INSERT INTO profiles(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(clean.id, JSON.stringify(clean), new Date().toISOString())
  }
  deleteProfile(id: string): void {
    this.transaction(() => {
      const workspace = this.workspace()
      workspace.tabs = workspace.tabs.filter((tab) => tab.connectionId !== id)
      workspace.expanded = workspace.expanded.filter((item) => item !== id && !item.startsWith(`${id}:`))
      if (!workspace.tabs.some((tab) => tab.id === workspace.activeTabId))
        workspace.activeTabId = workspace.tabs[0]?.id ?? null
      // Deletion is explicit even during private mode; preserve unrelated ordinary drafts.
      this.db
        .prepare('INSERT INTO workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(JSON.stringify(workspaceSchema.parse(workspace)))
      for (const query of this.queries())
        if (query.connectionId === id) {
          delete query.connectionId
          this.saveQuery(query)
        }
      this.db.prepare('DELETE FROM profiles WHERE id=?').run(id)
    })
  }
  getCredential(id: string): StoredCredential | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE connection_id=?').get(id)
    if (!row) return undefined
    return {
      ciphertext: row.ciphertext as Uint8Array,
      hasPassword: !!row.has_password,
      hasSshPassword: !!row.has_ssh_password,
      hasPassphrase: !!row.has_passphrase,
    }
  }
  writeCredential(id: string, value: StoredCredential): void {
    this.db
      .prepare(
        'INSERT INTO credentials VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET ciphertext=excluded.ciphertext,has_password=excluded.has_password,has_ssh_password=excluded.has_ssh_password,has_passphrase=excluded.has_passphrase',
      )
      .run(
        id,
        value.ciphertext,
        Number(value.hasPassword),
        Number(value.hasSshPassword),
        Number(value.hasPassphrase),
      )
  }
  deleteCredential(id: string): void {
    this.db.prepare('DELETE FROM credentials WHERE connection_id=?').run(id)
  }
  workspace(): Workspace {
    const row = this.db.prepare('SELECT data FROM workspace WHERE id=1').get()
    return row ? workspaceSchema.parse(JSON.parse(String(row.data))) : defaultWorkspace()
  }
  saveWorkspace(input: Workspace): void {
    const workspace = workspaceSchema.parse(input)
    if (workspace.settings.privateSession) {
      // Preserve the last ordinary workspace while remembering non-content preferences.
      const previous = this.workspace()
      workspace.tabs = previous.tabs
      workspace.activeTabId = previous.activeTabId
      workspace.expanded = previous.expanded
    }
    this.db
      .prepare('INSERT INTO workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(JSON.stringify(workspace))
  }
  clearDrafts(): void {
    const workspace = this.workspace()
    workspace.tabs = workspace.tabs.map((tab) => ({ ...tab, sql: '', cursor: 0, scrollTop: 0 }))
    this.db
      .prepare('INSERT INTO workspace VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(JSON.stringify(workspace))
  }
  queries(): SavedQuery[] {
    return this.db
      .prepare('SELECT data FROM saved_queries ORDER BY rowid DESC')
      .all()
      .map((row) => savedQuerySchema.parse(JSON.parse(String(row.data))))
  }
  saveQuery(input: SavedQuery): void {
    const value = savedQuerySchema.parse(input)
    this.db
      .prepare('INSERT INTO saved_queries VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(value.id, JSON.stringify(value))
  }
  deleteQuery(id: string): void {
    this.db.prepare('DELETE FROM saved_queries WHERE id=?').run(id)
  }
  history(): HistoryEntry[] {
    this.pruneHistory()
    return this.db
      .prepare('SELECT data FROM history ORDER BY executed_at DESC LIMIT 500')
      .all()
      .map((row) => JSON.parse(String(row.data)) as HistoryEntry)
  }
  addHistory(entry: Omit<HistoryEntry, 'id'>, privateSession = false): void {
    const settings = this.workspace().settings
    if (
      privateSession ||
      settings.privateSession ||
      !settings.historyEnabled ||
      !this.hasProfile(entry.connectionId) ||
      !this.profile(entry.connectionId).historyEnabled
    )
      return
    const value: HistoryEntry = { ...entry, id: randomUUID(), sql: redactHistory(entry.sql) }
    this.db
      .prepare('INSERT INTO history VALUES(?,?,?,?)')
      .run(value.id, value.connectionId, value.executedAt, JSON.stringify(value))
    this.pruneHistory()
  }
  pruneHistory(): void {
    const days = this.workspace().settings.historyRetentionDays
    this.db
      .prepare('DELETE FROM history WHERE executed_at < ?')
      .run(new Date(Date.now() - days * 86400000).toISOString())
    this.db.exec(
      'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY executed_at DESC LIMIT 5000)',
    )
  }
  clearHistory(): void {
    this.db.exec('DELETE FROM history')
  }
  exportProfiles(): string {
    return JSON.stringify(
      {
        format: 'harbor-db-connections',
        version: 1,
        profiles: this.profiles().map((profile) => ({
          ...profile,
          hasPassword: false,
          hasSshPassword: false,
          hasPassphrase: false,
        })),
      },
      null,
      2,
    )
  }
  previewImport(value: unknown): ConnectionProfile[] {
    const input = importSchema.parse(value)
    const names = new Set(this.profiles().map((profile) => profile.name.toLocaleLowerCase()))
    return input.profiles.map((profile) => {
      let name = profile.name
      let suffix = 1
      while (names.has(name.toLocaleLowerCase())) name = `${profile.name.slice(0, 94)} (imported ${suffix++})`
      names.add(name.toLocaleLowerCase())
      return {
        ...profile,
        id: randomUUID(),
        name,
        autoReconnect: false,
        readOnly: profile.environment.toLowerCase() === 'production' ? true : profile.readOnly,
        hasPassword: false,
        hasSshPassword: false,
        hasPassphrase: false,
      }
    })
  }
  importProfiles(profiles: ConnectionProfile[]): ConnectionProfile[] {
    const imported = this.previewImport({ format: 'harbor-db-connections', version: 1, profiles })
    this.transaction(() => {
      for (const profile of imported) this.saveProfile(profile)
    })
    return imported
  }
  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
  }
}
