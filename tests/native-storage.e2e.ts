import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('normal Electron OS credential encryption persists across process restart without mock-keychain switches', async () => {
  test.skip(process.env.HARBOR_NATIVE_STORAGE !== '1', 'Opt-in native credential backend check; requires an unlocked OS store.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-native-storage-'))
  const executablePath = createRequire(import.meta.url)('electron') as string
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
  ))
  let desktop: ElectronApplication | undefined
  const launch = async () => {
    // Explicit executable avoids Playwright's Electron loader, which appends
    // --use-mock-keychain and --password-store=basic to ordinary _electron.launch.
    desktop = await _electron.launch({ executablePath, chromiumSandbox: true, args: [root], cwd: root,
      env: { ...env, HARBOR_USER_DATA: userData }, timeout: 30000 })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    expect(await desktop.evaluate(({ app }) => ({
      mock: app.commandLine.hasSwitch('use-mock-keychain'), basic: app.commandLine.getSwitchValue('password-store'),
      isolated: app.getPath('userData'), sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
    }))).toEqual({ mock: false, basic: '', isolated: userData, sandboxDisabled: false })
    return page
  }
  try {
    let page = await launch()
    const initial = await page.evaluate(() => window.harbor.bootstrap())
    expect(initial.secureStorage.available, initial.secureStorage.reason).toBe(true)
    expect(initial.secureStorage.backend).not.toBe('basic_text')
    const profile = profileSchema.parse({ id: 'native-storage', name: 'Native storage disposable fixture', engine: 'postgres',
      host: '127.0.0.1', port: 15432, database: 'harbor', username: 'harbor', readOnly: true })
    await page.evaluate(async (profile) => window.harbor.saveProfile({ profile, secrets: { password: 'harbor_test' }, rememberPassword: true }), profile)
    expect((await page.evaluate(() => window.harbor.bootstrap())).profiles[0].hasPassword).toBe(true)
    await desktop!.close(); desktop = undefined
    expect((await readFile(join(userData, 'harbor.sqlite3'))).includes(Buffer.from('harbor_test'))).toBe(false)
    page = await launch()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.profiles[0].hasPassword).toBe(true)
    expect(JSON.stringify(state)).not.toContain('harbor_test')
    const connection = await page.evaluate(() => window.harbor.connect({ id: 'native-storage' }))
    expect(connection.state, connection.error).toBe('connected')
    await page.evaluate(() => window.harbor.disconnect('native-storage'))
    await page.evaluate(() => window.harbor.forgetPassword('native-storage'))
    expect((await page.evaluate(() => window.harbor.bootstrap())).profiles[0].hasPassword).toBe(false)
  } finally { await desktop?.close(); await rm(userData, { recursive: true, force: true }) }
})
