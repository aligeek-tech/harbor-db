import { _electron, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { profileSchema } from '../src/shared/contracts'
import { diagnosticBundleSchema } from '../src/shared/diagnostic-bundle'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const execFileAsync = promisify(execFile)

test('packaged application loads local assets, native workers, sandbox and database drivers', async () => {
  test.setTimeout(180000)
  test.skip(
    process.env.HARBOR_PACKAGE !== '1',
    'Opt-in test of the native package with disposable development services running.',
  )
  const configDirectory = await mkdtemp(join(tmpdir(), 'harbor-package-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'HARBOR_USER_DATA'].includes(entry[0]),
    ),
  )
  const macApplication = resolve(`release/mac-${process.arch}/Harbor DB.app`)
  const executablePath =
    process.env.HARBOR_PACKAGE_EXECUTABLE ||
    resolve(
      process.platform === 'darwin'
        ? `${macApplication}/Contents/MacOS/Harbor DB`
        : process.platform === 'win32'
          ? 'release/win-unpacked/Harbor DB.exe'
          : 'release/linux-unpacked/harbor-db',
    )
  let platformVerification: Record<string, unknown> = { status: 'not-checked' }
  if (process.platform === 'darwin') {
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', macApplication])
    const details = await execFileAsync('codesign', ['-dv', '--verbose=4', macApplication])
    platformVerification = {
      status: 'passed',
      kind: /Signature=adhoc/.test(details.stderr) ? 'ad-hoc' : 'other',
      notarization: 'not-checked',
    }
  }
  console.info('HARBOR_PACKAGE_STAGE signature-checked')
  const launchOptions = {
    chromiumSandbox: true,
    executablePath,
    args: [`--user-data-dir=${configDirectory}`],
    env: { ...env, XDG_CONFIG_HOME: configDirectory },
    timeout: 30000,
  }
  let desktop = await _electron.launch(launchOptions)
  const errors: string[] = []
  try {
    let page = await desktop.firstWindow()
    page.on('pageerror', (error) => { errors.push(error.message); console.info('HARBOR_PACKAGE_RENDERER_ERROR', error.message) })
    await waitForElectronWorkspace(page)
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
        platform: process.platform,
        arch: process.arch,
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
      platform: process.platform,
      arch: process.arch,
    })
    expect(runtime.userData.replace(/^\/private\/var\//, '/var/')).toBe(
      configDirectory.replace(/^\/private\/var\//, '/var/'),
    )
    const sandbox = await inspectElectronSandbox(desktop, page)
    console.info('HARBOR_PACKAGE_STAGE first-launch-ready')
    const secureStorage = (await page.evaluate(() => window.harbor.bootstrap())).secureStorage
    expect(await page.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require)).toBe(
      'undefined',
    )
    const profiles = (['postgres', 'mariadb', 'mysql', 'redis', 'mongodb'] as const).map((engine) =>
      profileSchema.parse({
        id: `package-${engine}`,
        name: `Packaged ${engine}`,
        engine,
        host: '127.0.0.1',
        port:
          engine === 'postgres'
            ? 15432
            : engine === 'mariadb'
              ? 13306
              : engine === 'mysql'
                ? 13307
                : engine === 'mongodb'
                  ? 17017
                  : 16379,
        username: engine === 'redis' ? '' : 'harbor',
        database: engine === 'redis' ? '' : 'harbor',
        schema: engine === 'postgres' ? 'public' : ['mariadb', 'mysql'].includes(engine) ? 'harbor' : '',
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
          if (profile.engine === 'mongodb') {
            const databases = await window.harbor.mongoDatabases(profile.id)
            if (!databases.includes('admin')) throw new Error('Packaged MongoDB catalog did not load')
            const data = await window.harbor.mongoRead({
              connectionId: profile.id,
              database: 'admin',
              collection: 'system.version',
              mode: 'find',
              query: '{}',
              limit: 10,
              offset: 0,
              direction: 'asc',
            })
            if (!data.documents.length) throw new Error('Packaged MongoDB document read did not load')
          } else if (profile.engine !== 'redis') {
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
    expect(results.map((result) => result.state)).toEqual(profiles.map(() => 'connected'))
    console.info('HARBOR_PACKAGE_STAGE remote-drivers-complete')
    for (const engine of ['sqlite', 'duckdb'] as const) {
      const local = profileSchema.parse({
        id: `package-${engine}`,
        name: `Packaged ${engine} native worker`,
        engine,
        host: '127.0.0.1',
        port: 1,
        schema: 'main',
        readOnly: false,
        sqlite: { path: join(configDirectory, 'packaged-managed.sqlite3'), mode: 'create' },
        duckdb: { path: '', mode: 'memory' },
      })
      const rows = await page.evaluate(async (profile) => {
        await window.harbor.saveProfile({ profile, rememberPassword: false })
        const state = await window.harbor.connect({ id: profile.id })
        if (state.state !== 'connected')
          throw new Error(state.error || 'Native local adapter did not connect')
        const result = await window.harbor.query({
          connectionId: profile.id,
          sessionId: 'package-native',
          requestId: crypto.randomUUID(),
          sql: 'SELECT 9007199254740993 AS precise',
          maxRows: 10,
          privateSession: true,
        })
        await window.harbor.disconnect(profile.id)
        await window.harbor.deleteProfile(profile.id)
        return result.sets[0].rows
      }, local)
      expect(rows).toEqual([['9007199254740993']])
    }
    console.info('HARBOR_PACKAGE_STAGE native-workers-complete')
    await page.reload()
    console.info('HARBOR_PACKAGE_STAGE reloaded')
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'Packaged postgres', exact: true }).click()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT 42 AS packaged_editor;')
    await expect
      .poll(async () =>
        page
          .evaluate(() => window.harbor.bootstrap())
          .then((state) => state.workspace.tabs.map((tab) => tab.sql)),
      )
      .toContain('SELECT 42 AS packaged_editor;')
    expect(errors).toEqual([])
    console.info('HARBOR_PACKAGE_STAGE editor-draft-complete')
    let rememberedReconnect: { exercised: boolean; states: string[] } = { exercised: false, states: [] }
    if (secureStorage.available) {
      const storedProfiles = (await page.evaluate(() => window.harbor.bootstrap())).profiles
      expect(storedProfiles.every((profile) => profile.hasPassword)).toBe(true)
      await desktop.close()
      console.info('HARBOR_PACKAGE_STAGE first-process-closed')
      desktop = await _electron.launch(launchOptions)
      const restoredPage = await desktop.firstWindow()
      page = restoredPage
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
      expect(states).toEqual(profiles.map(() => 'connected'))
      rememberedReconnect = { exercised: true, states }
      console.info('HARBOR_PACKAGE_STAGE protected-reconnect-complete')
    }
    const diagnostics = diagnosticBundleSchema.parse(
      await page.evaluate(() => window.harbor.previewDiagnosticBundle()),
    )
    expect(diagnostics.distribution).toMatchObject({
      packaged: true,
      signatureVerification: 'unknown',
      notarizationVerification: 'unknown',
      automaticUpdates: false,
      updatePolicy: 'manual-download',
    })
    const diagnosticText = JSON.stringify(diagnostics)
    for (const profile of profiles) {
      expect(diagnosticText).not.toContain(profile.id)
      expect(diagnosticText).not.toContain(profile.name)
      expect(diagnosticText).not.toContain(profile.host)
    }
    expect(diagnosticText).not.toContain(configDirectory)
    const diagnosticPath = join(configDirectory, 'packaged-diagnostics.json')
    await desktop.evaluate(({ dialog }, path) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath: path }
      }
    }, diagnosticPath)
    expect(await page.evaluate((bundle) => window.harbor.exportDiagnosticBundle(bundle), diagnostics)).toEqual({
      cancelled: false,
      path: diagnosticPath,
    })
    expect(await readFile(diagnosticPath, 'utf8')).toBe(`${JSON.stringify(diagnostics, null, 2)}\n`)
    console.info('HARBOR_PACKAGE_STAGE diagnostics-complete')
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await writeFile(
      '/tmp/harbor-db-e2e/packaged-runtime.json',
      JSON.stringify(
        {
          ...runtime,
          sandbox,
          secureStorage,
          rememberedReconnect,
          platformVerification,
          diagnosticBundle: diagnostics,
          results,
          pageErrors: errors,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.info('HARBOR_PACKAGE_FAILURE', error instanceof Error ? error.message : 'Unknown failure', errors)
    throw error
  } finally {
    // A crashed or uninitialized renderer cannot answer the graceful-close IPC.
    // Bound cleanup of this disposable test process without hiding test failures.
    const cleanup = setTimeout(() => desktop.process().kill('SIGKILL'), 5000)
    try { await desktop.close().catch(() => desktop.process().kill('SIGTERM')) }
    finally { clearTimeout(cleanup) }
    await rm(configDirectory, { recursive: true, force: true })
  }
})
