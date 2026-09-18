import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileSchema, savedQuerySchema } from '../src/shared/contracts'
import {
  MAX_HANDOFF_BYTES,
  parsePortableWorkspace,
  portableProfile,
  importedProfile,
  portableWorkspaceSchema,
} from '../src/shared/portable-workspace'
import { workspaceSnapshot } from '../src/shared/workspaces'
import { MetadataStore, defaultWorkspace } from '../src/main/persistence/store'
import { PortableWorkspaceService } from '../src/main/persistence/portable-workspace'

const stores: MetadataStore[] = [],
  directories: string[] = []
function store() {
  const path = mkdtempSync(join(tmpdir(), 'harbor-handoff-'))
  directories.push(path)
  const value = new MetadataStore(path)
  stores.push(value)
  return value
}
afterEach(() => {
  stores.splice(0).forEach((value) => value.close())
  directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }))
})
function fixture() {
  const source = store(),
    destination = store()
  const profile = profileSchema.parse({
    id: 'source',
    name: 'Example',
    engine: 'sqlite',
    host: '127.0.0.1',
    port: 1,
    sqlite: { path: '/machine/database.sqlite', mode: 'create' },
    notes: 'DO_NOT_EXPORT_NOTES',
    tls: {
      enabled: true,
      rejectUnauthorized: false,
      ca: '/machine/ca.pem',
      cert: '/machine/client.pem',
      keyPath: '/machine/tls.key',
    },
    ssh: {
      enabled: true,
      host: 'jump.example',
      port: 22,
      username: 'example',
      privateKeyPath: '/machine/id_private',
      hostKey: 'fingerprint',
    },
  })
  source.saveProfile(profile)
  source.writeCredential(profile.id, {
    ciphertext: new Uint8Array([9, 8, 7]),
    hasPassword: true,
    hasSshPassword: true,
    hasPassphrase: true,
  })
  source.saveQuery(
    savedQuerySchema.parse({
      id: 'saved',
      name: 'Example query',
      engine: 'sqlite',
      sql: "SELECT 'review literal';",
      connectionId: profile.id,
      tags: ['audit'],
      folder: 'Reports',
      updatedAt: '2026-09-18',
    }),
  )
  const workspace = defaultWorkspace()
  workspace.tabs = [
    {
      id: 'tab',
      connectionId: profile.id,
      savedQueryId: 'saved',
      kind: 'query',
      title: 'Draft',
      pinned: true,
      sql: "SELECT 'review draft';",
      parameterDefinitions: [{ name: 'credential', secret: true, type: 'text' }],
    },
  ]
  workspace.activeTabId = 'tab'
  workspace.recentlyClosed = [{ ...workspace.tabs[0], id: 'closed' }]
  source.saveWorkspace(workspace)
  const existing = {
    ...profile,
    id: 'existing',
    sqlite: { ...profile.sqlite, path: '/destination/keep.sqlite', mode: 'open' as const },
    readOnly: false,
  }
  destination.saveProfile(existing)
  destination.writeCredential(existing.id, {
    ciphertext: new Uint8Array([1, 2, 3]),
    hasPassword: true,
    hasSshPassword: false,
    hasPassphrase: false,
  })
  const exportService = new PortableWorkspaceService(source)
  const service = new PortableWorkspaceService(destination)
  return { source, destination, profile, existing, exportService, service }
}

describe('portable workspace archive', () => {
  it('retains explicit nonsecret engine scope while stripping local Firebird paths', () => {
    const profile = profileSchema.parse({ id:'scope', name:'Scope', engine:'dynamodb', host:'dynamodb.eu-west-1.amazonaws.com', port:443,
      dynamo:{region:'eu-west-1',accountId:'123456789012',local:false},
      athena:{region:'eu-west-1',catalog:'catalog',workgroup:'reviewed',outputLocation:'s3://synthetic/results/',expectedBucketOwner:'123456789012',maximumScannedBytes:'10000000'},
      warehouse:{warehouse:'COMPUTE',role:'ANALYST',snowflakeTokenType:'OAUTH'},
      bigQuery:{location:'EU',maximumBytesBilled:'1000000'},trino:{auth:'bearer',timeZone:'UTC'},
      managed:{provider:'cloudsql-mysql',authentication:'temporary-password',expiresAt:'2026-09-18T12:00:00Z'},
    })
    const imported = importedProfile(portableProfile(profile),'copy','Copy')
    for(const field of ['dynamo','athena','warehouse','bigQuery','trino','managed','redshift','firebird'] as const)
      expect(imported[field]).toEqual(profile[field])
    expect(imported.autoReconnect).toBe(false)
    expect(imported.hasPassword).toBe(false)
    expect(portableProfile({...profile,engine:'firebird',database:'/Users/private/database.fdb'}).database).toBe('')
    expect(portableProfile({...profile,engine:'firebird',database:'C:\\private\\database.fdb'}).database).toBe('')
    expect(portableProfile({...profile,engine:'firebird',database:'approved_alias'}).database).toBe('approved_alias')
  })
  it('uses a strict allowlist and opt-in text without transferring credentials or machine-specific paths', () => {
    const { source, exportService } = fixture()
    const text = exportService.export({ includeQueries: false, includeDrafts: false })
    for (const forbidden of [
      'DO_NOT_EXPORT_NOTES',
      '/machine/',
      'ciphertext',
      'hasPassword',
      'privateKeyPath',
      'keyPath',
      'review literal',
      'review draft',
    ])
      expect(text).not.toContain(forbidden)
    const archive = parsePortableWorkspace(text)
    expect(archive.profiles[0].tls.rejectUnauthorized).toBe(true)
    expect(archive.workspaces).toEqual([])
    const explicit = parsePortableWorkspace(
      exportService.export({ includeQueries: true, includeDrafts: true }),
    )
    expect(explicit.queries[0].sql).toBe("SELECT 'review literal';")
    expect(explicit.workspaces[0].tabs[0].parameterDefinitions?.[0].secret).toBe(true)
    expect(source.getCredential('source')?.ciphertext).toEqual(new Uint8Array([9, 8, 7]))
    expect(() => portableWorkspaceSchema.parse({ ...archive, password: 'injected' })).toThrow()
    expect(() =>
      portableWorkspaceSchema.parse({
        ...archive,
        profiles: [{ ...archive.profiles[0], sqlite: { path: '/injected' } }],
      }),
    ).toThrow()
  })
  it('copies with new IDs, resolves names, remaps references, and leaves current tabs and existing credentials unchanged', () => {
    const { destination, existing, exportService, service } = fixture()
    const before = destination.workspace()
    const preview = service.preview(exportService.export({ includeQueries: true, includeDrafts: true }))
    expect(preview.conflicts.profileIds).toEqual(['source'])
    expect(preview.conflicts.workspaceIds).toEqual(['default'])
    const result = service.import({
      token: preview.token,
      profiles: [{ sourceId: 'source', action: 'copy' }],
      queryMode: 'copy',
      workspaceIds: ['default'],
      settings: 'keep',
    })
    expect(result).toMatchObject({ profiles: 1, queries: 1, workspaces: 1, skippedTabs: 0 })
    const copy = destination.profiles().find((profile) => profile.id !== existing.id)!
    expect(copy.id).not.toBe('source')
    expect(copy).toMatchObject({
      name: 'Example (imported 1)',
      readOnly: true,
      autoReconnect: false,
      hasPassword: false,
      notes: '',
      sqlite: { path: '', mode: 'open' },
      tls: { ca: '', cert: '', keyPath: '', rejectUnauthorized: true },
      ssh: { privateKeyPath: '' },
    })
    expect(destination.getCredential(existing.id)?.ciphertext).toEqual(new Uint8Array([1, 2, 3]))
    expect(destination.profile(existing.id).sqlite.path).toBe('/destination/keep.sqlite')
    const workspace = destination.workspace()
    expect(workspace.tabs).toEqual(before.tabs)
    expect(workspace.id).toBe(before.id)
    expect(workspace.archivedWorkspaces[0]).toMatchObject({
      name: 'Default workspace (imported 1)',
      tabs: [{ connectionId: copy.id, savedQueryId: destination.queries()[0].id, pinned: true }],
    })
    expect(workspace.archivedWorkspaces[0].tabs[0].id).not.toBe('tab')
    expect(() =>
      service.import({
        token: preview.token,
        profiles: [{ sourceId: 'source', action: 'copy' }],
        queryMode: 'skip',
        workspaceIds: [],
        settings: 'keep',
      }),
    ).toThrow('expired')
  })
  it('binds only an explicitly selected same-engine profile and supports skipping connection-owned tabs and query conflicts', () => {
    const { destination, existing, exportService, service } = fixture()
    const content = exportService.export({ includeQueries: true, includeDrafts: true })
    let preview = service.preview(content)
    destination.saveQuery(
      savedQuerySchema.parse({
        id: 'existing-query',
        name: 'Example query',
        engine: 'sqlite',
        sql: 'SELECT keep',
        updatedAt: '2026-09-18',
      }),
    )
    service.import({
      token: preview.token,
      profiles: [{ sourceId: 'source', action: 'bind', existingId: existing.id }],
      queryMode: 'skip-conflicts',
      workspaceIds: ['default'],
      settings: 'keep',
    })
    expect(destination.profiles()).toHaveLength(1)
    expect(destination.queries()).toHaveLength(1)
    expect(destination.workspace().archivedWorkspaces[0].tabs[0]).toMatchObject({ connectionId: existing.id })
    expect(destination.workspace().archivedWorkspaces[0].tabs[0].savedQueryId).toBeUndefined()
    preview = service.preview(content)
    const skipped = service.import({
      token: preview.token,
      profiles: [{ sourceId: 'source', action: 'skip' }],
      queryMode: 'copy',
      workspaceIds: ['default'],
      settings: 'keep',
    })
    expect(skipped.skippedTabs).toBe(2)
    expect(destination.queries().find((query) => query.id !== 'existing-query')?.connectionId).toBeUndefined()
    expect(destination.workspace().archivedWorkspaces[1].tabs).toEqual([])
  })
  it('pins preview bytes and rejects mismatched bindings, expired tokens, duplicate decisions and oversized files before writes', () => {
    const { destination, exportService } = fixture()
    let now = Date.now()
    const service = new PortableWorkspaceService(destination, () => now)
    const preview = service.preview(exportService.export({ includeQueries: true, includeDrafts: true }))
    preview.archive.profiles[0].name = 'renderer tamper'
    const decisions = {
      token: preview.token,
      profiles: [{ sourceId: 'source', action: 'copy' as const }],
      queryMode: 'skip' as const,
      workspaceIds: ['default'],
      settings: 'keep' as const,
    }
    expect(() =>
      service.import({ ...decisions, profiles: [...decisions.profiles, ...decisions.profiles] }),
    ).toThrow('every connection')
    destination.saveProfile(
      profileSchema.parse({
        id: 'wrong-engine',
        name: 'Other',
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
      }),
    )
    expect(() =>
      service.import({
        ...decisions,
        profiles: [{ sourceId: 'source', action: 'bind', existingId: 'wrong-engine' }],
      }),
    ).toThrow('same database engine')
    service.import(decisions)
    expect(destination.profiles().some((profile) => profile.name === 'renderer tamper')).toBe(false)
    const expiring = service.preview(exportService.export({ includeQueries: false, includeDrafts: false }))
    now += 5 * 60000 + 1
    expect(() => service.import({ ...decisions, token: expiring.token, workspaceIds: [] })).toThrow('expired')
    expect(() => parsePortableWorkspace(' '.repeat(MAX_HANDOFF_BYTES + 1))).toThrow('32 MiB')
  })
  it('enforces private mode, workspace bounds, and atomic rollback on a failed merge', () => {
    const { source, destination, exportService, service } = fixture()
    const content = exportService.export({ includeQueries: true, includeDrafts: true })
    const preview = service.preview(content)
    const decisions = {
      token: preview.token,
      profiles: [{ sourceId: 'source', action: 'copy' as const }],
      queryMode: 'copy' as const,
      workspaceIds: ['default'],
      settings: 'keep' as const,
    }
    const privateWorkspace = {
      ...destination.workspace(),
      settings: { ...destination.workspace().settings, privateSession: true },
    }
    destination.saveWorkspace(privateWorkspace)
    expect(() => service.import(decisions)).toThrow('private')
    source.saveWorkspace({
      ...source.workspace(),
      settings: { ...source.workspace().settings, privateSession: true },
    })
    expect(() => exportService.export({ includeQueries: false, includeDrafts: true })).toThrow('private')
    destination.saveWorkspace({
      ...destination.workspace(),
      settings: { ...destination.workspace().settings, privateSession: false },
    })
    const workspace = destination.workspace()
    workspace.archivedWorkspaces = Array.from({ length: 19 }, (_, index) => ({
      ...workspaceSnapshot(workspace),
      id: `archive-${index}`,
    }))
    destination.saveWorkspace(workspace)
    expect(() => service.import(decisions)).toThrow('20-workspace')
    const beforeProfiles = destination.profiles(),
      beforeQueries = destination.queries()
    const originalSave = destination.saveQuery.bind(destination)
    destination.saveQuery = () => {
      throw new Error('simulated disk failure')
    }
    expect(() => service.import({ ...decisions, workspaceIds: [] })).toThrow('simulated disk failure')
    destination.saveQuery = originalSave
    expect(destination.profiles()).toEqual(beforeProfiles)
    expect(destination.queries()).toEqual(beforeQueries)
  })
  it('rejects unknown versions, duplicate identities and untrusted secret fields', () => {
    const { profile, exportService } = fixture()
    const archive = parsePortableWorkspace(
      exportService.export({ includeQueries: false, includeDrafts: false }),
    )
    expect(() => portableWorkspaceSchema.parse({ ...archive, version: 2 })).toThrow()
    expect(() =>
      portableWorkspaceSchema.parse({
        ...archive,
        profiles: [portableProfile(profile), portableProfile(profile)],
      }),
    ).toThrow('Duplicate')
    expect(() =>
      portableWorkspaceSchema.parse({
        ...archive,
        profiles: [{ ...archive.profiles[0], hasPassword: true }],
      }),
    ).toThrow()
  })
})
