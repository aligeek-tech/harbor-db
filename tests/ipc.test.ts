import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const callbacks = vi.hoisted(() => new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  dialog: {},
  ipcMain: {
    handle: (name: string, callback: (event: unknown, input?: unknown) => Promise<unknown>) =>
      callbacks.set(name, callback),
    removeHandler: (name: string) => callbacks.delete(name),
  },
}))
import { ipcSchemas, isTrustedSender, registerIpc } from '../src/main/ipc'
import { profileSchema } from '../src/shared/contracts'
import { MetadataStore } from '../src/main/persistence/store'
import { CredentialService } from '../src/main/persistence/credentials'
import type { SqlService } from '../src/main/engines/sql'
import type { RedisService } from '../src/main/engines/redis'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  callbacks.clear()
})
function boundary() {
  const directory = mkdtempSync(join(tmpdir(), 'harbor-ipc-test-'))
  const store = new MetadataStore(directory)
  const credentials = new CredentialService(
    {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('unavailable')
      },
      decryptString: () => {
        throw new Error('unavailable')
      },
      getSelectedStorageBackend: () => 'basic_text',
    },
    store,
    'linux',
  )
  const driver = {
    connect: vi.fn().mockResolvedValue({ state: 'connected' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockReturnValue({ state: 'disconnected' }),
    execute: vi.fn(),
  }
  const mainFrame = { url: 'file:///app/index.html' }
  const webContents = { mainFrame }
  const window = { webContents }
  const event = { sender: webContents, senderFrame: mainFrame }
  const unregister = registerIpc(
    window as Parameters<typeof registerIpc>[0],
    mainFrame.url,
    store,
    credentials,
    driver as unknown as SqlService,
    driver as unknown as RedisService,
    driver as unknown as Parameters<typeof registerIpc>[6],
    vi.fn(),
  )
  cleanups.push(() => {
    unregister()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const invoke = (method: string, input?: unknown) => callbacks.get(`harbor:${method}`)!(event, input)
  return { store, credentials, driver, event, invoke }
}

describe('IPC boundary validation', () => {
  it('does not route MongoDB operations through SQL connections', async () => {
    const { store, invoke } = boundary()
    store.saveProfile(
      profileSchema.parse({
        id: 'sql-only',
        name: 'SQL only',
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
      }),
    )
    await expect(
      invoke('mongoRead', { connectionId: 'sql-only', database: 'db', collection: 'docs' }),
    ).rejects.toThrow(/MongoDB connection/)
    await expect(
      invoke('mongoWrite', {
        connectionId: 'sql-only',
        database: 'db',
        collection: 'docs',
        action: 'delete',
        original: '{}',
      }),
    ).rejects.toThrow(/MongoDB connection/)
  })
  it('rejects unsafe and unknown profile payload fields', () => {
    const profile = profileSchema.parse({
      id: 'test',
      name: 'Test',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
    })
    expect(
      ipcSchemas.saveProfile.safeParse({
        profile,
        secrets: { password: 'provided password' },
        rememberPassword: true,
      }).success,
    ).toBe(true)
    expect(
      ipcSchemas.saveProfile.safeParse({ profile: { ...profile, password: 'not allowed in metadata' } })
        .success,
    ).toBe(false)
    expect(ipcSchemas.saveProfile.safeParse({ profile: { ...profile, port: 0 } }).success).toBe(false)
    expect(
      ipcSchemas.saveProfile.safeParse({ profile, secrets: { command: 'arbitrary shell' } }).success,
    ).toBe(false)
  })
  it('bounds SQL, IDs, exports and limits without accepting filesystem paths or raw channels', () => {
    expect(
      ipcSchemas.query.safeParse({ connectionId: '', sessionId: 'a', requestId: 'b', sql: 'select 1' })
        .success,
    ).toBe(false)
    expect(
      ipcSchemas.query.safeParse({
        connectionId: 'a',
        sessionId: 'a',
        requestId: 'b',
        sql: 'select 1',
        maxRows: 100000,
      }).success,
    ).toBe(false)
    expect(
      ipcSchemas.exportResults.safeParse({
        format: 'json',
        columns: [],
        rows: [],
        spreadsheetSafe: true,
        scope: 'all database output',
      }).success,
    ).toBe(false)
    expect(
      ipcSchemas.exportSql.safeParse({ name: 'query', sql: 'select 1', path: '/etc/passwd' }).success,
    ).toBe(false)
    expect(ipcSchemas.bootstrap.safeParse({ channel: 'shell' }).success).toBe(false)
  })
  it('allows only the application main frame with exact local URL', () => {
    const mainFrame = { url: 'file:///app/index.html' }
    const webContents = { mainFrame }
    const window = { webContents }
    const event = { sender: webContents, senderFrame: mainFrame }
    type Sender = Parameters<typeof isTrustedSender>[0]
    type Window = Parameters<typeof isTrustedSender>[1]
    expect(isTrustedSender(event as Sender, window as Window, 'file:///app/index.html')).toBe(true)
    expect(
      isTrustedSender(
        { ...event, senderFrame: { url: mainFrame.url } } as Sender,
        window as Window,
        'file:///app/index.html',
      ),
    ).toBe(false)
    expect(
      isTrustedSender(
        { ...event, sender: { mainFrame } } as Sender,
        window as Window,
        'file:///app/index.html',
      ),
    ).toBe(false)
    mainFrame.url = 'https://example.com/'
    expect(isTrustedSender(event as Sender, window as Window, 'file:///app/index.html')).toBe(false)
    mainFrame.url = 'file:///app/index.html?modified=true'
    expect(isTrustedSender(event as Sender, window as Window, 'file:///app/index.html')).toBe(false)
  })
})

describe('registered privileged workflows', () => {
  it('saves offline, clamps newly production profiles and never returns entered credentials', async () => {
    const { invoke, driver, store } = boundary()
    const profile = profileSchema.parse({
      id: 'offline',
      name: 'Production',
      engine: 'postgres',
      host: 'unavailable.example',
      port: 5432,
      environment: 'production',
      readOnly: false,
    })
    const result = await invoke('saveProfile', {
      profile,
      secrets: { password: 'session-only-secret' },
      rememberPassword: false,
    })
    expect(result).toMatchObject({ id: 'offline', readOnly: true, hasPassword: false })
    expect(JSON.stringify(result)).not.toContain('session-only-secret')
    expect(driver.connect).not.toHaveBeenCalled()
    expect(store.profiles()).toHaveLength(1)
    await invoke('connect', { id: 'offline' })
    expect(driver.connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'offline', readOnly: true }), {
      password: 'session-only-secret',
    })
    await invoke('saveProfile', { profile: { ...profile, host: 'new-host' }, rememberPassword: false })
    expect(driver.disconnect).toHaveBeenCalledWith('offline')
    expect(store.profile('offline').readOnly).toBe(false)
  })
  it('restores metadata without invoking any engine and rejects untrusted senders before work', async () => {
    const { invoke, driver, event } = boundary()
    expect(await invoke('bootstrap')).toMatchObject({
      profiles: [],
      history: [],
      secureStorage: { available: false },
    })
    expect(driver.connect).not.toHaveBeenCalled()
    await expect(
      callbacks.get('harbor:bootstrap')!({ ...event, senderFrame: { url: event.senderFrame.url } }),
    ).rejects.toThrow('trusted Harbor DB')
    await expect(
      invoke('query', {
        connectionId: 'missing',
        sessionId: 's',
        requestId: 'r',
        sql: 'SELECT 1',
        injected: true,
      }),
    ).rejects.toThrow('Invalid query request')
    expect(driver.execute).not.toHaveBeenCalled()
  })
  it('keeps live session credentials and transactions when only organization metadata changes', async () => {
    const { invoke, driver } = boundary()
    const profile = profileSchema.parse({
      id: 'favorite',
      name: 'Local',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
    })
    await invoke('saveProfile', { profile, secrets: { password: 'temporary' }, rememberPassword: false })
    await invoke('connect', { id: profile.id })
    await invoke('saveProfile', {
      profile: { ...profile, favorite: true, folder: 'Work', tags: ['active'] },
      rememberPassword: false,
    })
    expect(driver.disconnect).not.toHaveBeenCalled()
    await invoke('connect', { id: profile.id })
    expect(driver.connect).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: true }), {
      password: 'temporary',
    })
  })
  it('reports genuine test failures without creating a profile or leaking its entered secret', async () => {
    const { invoke, driver, store } = boundary()
    driver.connect.mockRejectedValue(new Error('Authentication failed: supplied failed-password'))
    const profile = profileSchema.parse({
      id: 'unsaved',
      name: 'Unsaved',
      engine: 'redis',
      host: 'localhost',
      port: 6379,
    })
    const result = await invoke('testConnection', {
      profile,
      secrets: { password: 'failed-password' },
      rememberPassword: true,
    })
    expect(result).toMatchObject({ state: 'failed' })
    expect(JSON.stringify(result)).not.toContain('failed-password')
    expect(store.profiles()).toEqual([])
    expect(driver.disconnect).toHaveBeenCalledWith(expect.stringMatching(/^test-/))
  })
  it('records confirmed cancellation distinctly instead of reporting query success', async () => {
    const { invoke, driver, store } = boundary()
    const profile = profileSchema.parse({
      id: 'cancelled',
      name: 'Cancellation',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
    })
    store.saveProfile(profile)
    driver.execute.mockResolvedValue({
      requestId: 'cancel-1',
      sets: [],
      durationMs: 20,
      messages: ['The server confirmed cancellation.'],
      transaction: 'idle',
      cancelled: true,
    })
    const result = await invoke('query', {
      connectionId: profile.id,
      sessionId: 'tab',
      requestId: 'cancel-1',
      sql: 'SELECT pg_sleep(10)',
      maxRows: 10,
      privateSession: false,
    })
    expect(result).toMatchObject({ cancelled: true })
    expect(store.history()[0]).toMatchObject({ success: false, error: expect.stringMatching(/^Cancelled:/) })
  })
})
