import { _electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox } from './electron-runtime'

test('packaged Linux application loads local assets, SQLite, sandbox and all database drivers', async () => {
  test.skip(
    process.env.HARBOR_PACKAGE !== '1' || process.platform !== 'linux',
    'Opt-in test of the built Linux package with development services running.',
  )
  const configDirectory = await mkdtemp(join(tmpdir(), 'harbor-package-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'HARBOR_USER_DATA'].includes(entry[0]),
    ),
  )
  const launchOptions = {
    chromiumSandbox: true,
    executablePath: resolve('release/linux-unpacked/harbor-db'),
    args: [],
    env: { ...env, XDG_CONFIG_HOME: configDirectory },
    timeout: 30000,
  }
  let desktop = await _electron.launch(launchOptions)
  try {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Add connection', exact: true }),
    ).toBeVisible()
    expect(page.url()).toMatch(/^file:.*app\.asar.*index\.html$/)
    const runtime = await desktop.evaluate(({ app, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): { sandbox: boolean; nodeIntegration: boolean; contextIsolation: boolean }
      }
      const preferences = contents.getLastWebPreferences()
      return {
        packaged: app.isPackaged,
        sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
        userData: app.getPath('userData'),
        electron: process.versions.electron,
        node: process.versions.node,
        sqlite: process.versions.sqlite,
        sandbox: preferences.sandbox,
        nodeIntegration: preferences.nodeIntegration,
        contextIsolation: preferences.contextIsolation,
      }
    })
    expect(runtime).toMatchObject({
      packaged: true,
      sandboxDisabled: false,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    })
    expect(runtime.userData.startsWith(configDirectory)).toBe(true)
    const sandbox = await inspectElectronSandbox(desktop, page)
    const secureStorage = (await page.evaluate(() => window.harbor.bootstrap())).secureStorage
    expect(await page.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require)).toBe(
      'undefined',
    )
    const profiles = (['postgres', 'mariadb', 'redis'] as const).map((engine) =>
      profileSchema.parse({
        id: `package-${engine}`,
        name: `Packaged ${engine}`,
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 16379,
        username: engine === 'redis' ? '' : 'harbor',
        database: engine === 'redis' ? '' : 'harbor',
        schema: engine === 'postgres' ? 'public' : engine === 'mariadb' ? 'harbor' : '',
        readOnly: true,
      }),
    )
    const results = await page.evaluate(
      async ({ profiles, rememberPasswords }) => {
        const results = []
        for (const profile of profiles) {
          await window.harbor.saveProfile({
            profile,
            secrets: { password: 'harbor_test' },
            rememberPassword: rememberPasswords,
          })
          const state = await window.harbor.connect({ id: profile.id })
          results.push({ engine: profile.engine, state: state.state })
          if (profile.engine !== 'redis') {
            const data = await window.harbor.query({
              connectionId: profile.id,
              sessionId: 'package-smoke',
              requestId: crypto.randomUUID(),
              sql: 'SELECT CAST(9007199254740993 AS DECIMAL(30,0)) AS precise',
              maxRows: 10,
              privateSession: true,
            })
            if (data.sets[0]?.rows[0]?.[0] !== '9007199254740993')
              throw new Error('Packaged driver lost integer precision')
          } else {
            const data = await window.harbor.redisScan({
              connectionId: profile.id,
              cursor: '0',
              pattern: 'harbor:*',
              count: 20,
            })
            if (typeof data.cursor !== 'string')
              throw new Error('Packaged Redis SCAN did not return a cursor')
          }
          await window.harbor.disconnect(profile.id)
        }
        return results
      },
      { profiles, rememberPasswords: secureStorage.available },
    )
    expect(results.map((result) => result.state)).toEqual(['connected', 'connected', 'connected'])
    await page.reload()
    await page.getByRole('button', { name: 'Packaged postgres', exact: true }).click()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const editor = page.locator('.monaco-editor textarea').first()
    await expect(editor).toBeVisible()
    await editor.focus()
    await editor.press('ControlOrMeta+Home')
    await editor.press('ControlOrMeta+Shift+End')
    await editor.pressSequentially('SELECT 42 AS packaged_editor;')
    await expect
      .poll(async () =>
        page
          .evaluate(() => window.harbor.bootstrap())
          .then((state) => state.workspace.tabs.map((tab) => tab.sql)),
      )
      .toContain('SELECT 42 AS packaged_editor;')
    expect(errors).toEqual([])
    let rememberedReconnect: { exercised: boolean; states: string[] } = { exercised: false, states: [] }
    if (secureStorage.available) {
      const storedProfiles = (await page.evaluate(() => window.harbor.bootstrap())).profiles
      expect(storedProfiles.every((profile) => profile.hasPassword)).toBe(true)
      await desktop.close()
      desktop = await _electron.launch(launchOptions)
      const restoredPage = await desktop.firstWindow()
      await restoredPage.waitForFunction(() => !!window.harbor)
      await inspectElectronSandbox(desktop, restoredPage)
      const states = await restoredPage.evaluate(async () => {
        const restored = await window.harbor.bootstrap()
        const states = []
        for (const profile of restored.profiles) {
          // No supplied password: reconnect must decrypt the persisted OS-protected ciphertext.
          states.push((await window.harbor.connect({ id: profile.id })).state)
          await window.harbor.disconnect(profile.id)
        }
        return states
      })
      expect(states).toEqual(['connected', 'connected', 'connected'])
      rememberedReconnect = { exercised: true, states }
    }
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await writeFile(
      '/tmp/harbor-db-e2e/packaged-runtime.json',
      JSON.stringify(
        { ...runtime, sandbox, secureStorage, rememberedReconnect, results, pageErrors: errors },
        null,
        2,
      ),
    )
  } finally {
    await desktop.close().catch(() => desktop.process().kill('SIGTERM'))
    await rm(configDirectory, { recursive: true, force: true })
  }
})
