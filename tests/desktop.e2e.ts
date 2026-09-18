import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutKeys, shortcutLabel, shortcutPlatform } from '../src/shared/shortcuts'

const root = resolve(import.meta.dirname, '..')
const fixturePassword = 'harbor_test'
let desktop: ElectronApplication | undefined
let userData: string

async function launch(): Promise<Page> {
  await mkdir('/tmp/harbor-db-e2e', { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  desktop = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData },
    timeout: 30000,
  })
  const page = await desktop.firstWindow()
  await page.waitForFunction(() => !!window.harbor)
  await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
  const secureStorage = (await page.evaluate(() => window.harbor.bootstrap())).secureStorage
  const runtime = await desktop.evaluate(({ app }) => ({
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
    chromium: process.versions.chrome,
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
  }))
  expect(runtime.sandboxDisabled).toBe(false)
  const sandbox = await inspectElectronSandbox(desktop, page)
  await writeFile(
    '/tmp/harbor-db-e2e/security-runtime.json',
    JSON.stringify({ runtime, secureStorage, sandbox }, null, 2),
  )
  return page
}

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'harbor-desktop-'))
})
test.afterEach(async () => {
  if (desktop) {
    await desktop.close().catch(() => desktop?.process().kill('SIGTERM'))
    desktop = undefined
  }
  await rm(userData, { recursive: true, force: true })
})

test('actual Electron isolation, offline profile creation, protected credentials and ordinary restart restoration', async () => {
  let page = await launch()
  const sandbox = await desktop!.evaluate(({ BrowserWindow }) => {
    // Electron exposes this inspection helper in its internal typing, not electron.d.ts.
    const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences(): { sandbox: boolean; nodeIntegration: boolean; contextIsolation: boolean }
    }
    const preferences = contents.getLastWebPreferences()
    return {
      sandbox: preferences.sandbox,
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
    }
  })
  expect(sandbox).toEqual({ sandbox: true, nodeIntegration: false, contextIsolation: true })
  const bridge = await page.evaluate(() => ({
    node: typeof (globalThis as unknown as { require?: unknown }).require,
    process: typeof (globalThis as unknown as { process?: unknown }).process,
    methods: Object.keys(window.harbor),
  }))
  expect(bridge.node).toBe('undefined')
  expect(bridge.process).toBe('undefined')
  expect(bridge.methods).not.toContain('invoke')
  expect(bridge.methods).not.toContain('ipcRenderer')

  await page.getByRole('main').getByRole('button', { name: 'Add connection', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Connection name', { exact: true }).fill('E2E PostgreSQL')
  await page.getByLabel('Host', { exact: true }).fill('127.0.0.1')
  await page.getByLabel('Port', { exact: true }).fill('15432')
  await page.getByLabel('Username', { exact: true }).fill('harbor')
  await page.getByLabel('Database', { exact: true }).fill('harbor')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('E2E PostgreSQL', { exact: true }).first()).toBeVisible()

  const initial = await page.evaluate(() => window.harbor.bootstrap())
  expect(initial.profiles).toHaveLength(1)
  const postgres = initial.profiles[0]!
  const enteredSecret = `e2e-only-${randomUUID()}`
  const fixtures = [
    profileSchema.parse({
      id: randomUUID(),
      name: 'E2E MariaDB',
      engine: 'mariadb',
      host: '127.0.0.1',
      port: 13306,
      username: 'harbor',
      database: 'harbor',
      schema: 'harbor',
    }),
    profileSchema.parse({
      id: randomUUID(),
      name: 'E2E Redis',
      engine: 'redis',
      host: '127.0.0.1',
      port: 16379,
    }),
  ]
  await page.evaluate(
    async ({ postgres, fixtures, secret, available }) => {
      await window.harbor.saveProfile({
        profile: postgres,
        secrets: { password: secret },
        rememberPassword: available,
      })
      for (const profile of fixtures) await window.harbor.saveProfile({ profile, rememberPassword: false })
    },
    { postgres, fixtures, secret: enteredSecret, available: initial.secureStorage.available },
  )
  const invalid = await page.evaluate(async () => {
    try {
      await window.harbor.query({
        connectionId: 'invalid',
        sessionId: 's',
        requestId: 'r',
        sql: 'SELECT 1',
        maxRows: Infinity,
        privateSession: false,
      })
      return false
    } catch (error) {
      return String(error).includes('Invalid query request')
    }
  })
  expect(invalid).toBe(true)
  const wrongSenderRejected = await desktop!.evaluate(
    async ({ BrowserWindow }, paths) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: paths.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        await foreign.loadURL('data:text/html,<html><body>IPC sender validation</body></html>')
        return (await foreign.webContents.executeJavaScript(
          'window.harbor.bootstrap().then(() => false, error => String(error).includes("trusted Harbor DB"))',
        )) as boolean
      } finally {
        foreign.destroy()
      }
    },
    { preload: join(root, 'out/preload/index.js') },
  )
  expect(wrongSenderRejected).toBe(true)
  const exportPath = join(userData, 'loaded-results.json')
  const exported = await desktop!.evaluate(async ({ BrowserWindow, dialog }, exportPath) => {
    // Scope only the native file chooser; the real validated IPC, worker and filesystem remain active.
    const original = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
    try {
      return (await BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        'window.harbor.exportResults({format:"json",columns:[{name:"id",type:"bigint"},{name:"id",type:"text"}],rows:[["9007199254740993",null]],spreadsheetSafe:true,scope:"loaded results"})',
      )) as { cancelled: boolean }
    } finally {
      dialog.showSaveDialog = original
    }
  }, exportPath)
  expect(exported.cancelled).toBe(false)
  expect(JSON.parse(await readFile(exportPath, 'utf8'))).toMatchObject({
    columns: [
      { name: 'id', type: 'bigint' },
      { name: 'id', type: 'text' },
    ],
    rows: [['9007199254740993', null]],
    scope: 'loaded results',
  })

  // Type into the locally bundled Monaco editor, then let the real debounce persist it.
  await page.getByRole('button', { name: 'New query', exact: true }).first().click()
  const draft = "SELECT 'draft restored without execution', 9007199254740993;"
  const editor = await typeSql(page, draft)
  const platform = shortcutPlatform(process.platform)
  await expect(
    page.getByRole('button', { name: `Save query · ${shortcutLabel('save-query', platform)}`, exact: true }),
  ).toBeVisible()
  for (const [action, cursor] of [
    ['editor-start', 0],
    ['editor-end', draft.length],
  ] as const) {
    await editor.press(shortcutKeys(action, platform))
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const { workspace } = await window.harbor.bootstrap()
          return workspace.tabs.find((tab) => tab.id === workspace.activeTabId)?.cursor
        }),
      )
      .toBe(cursor)
  }
  await editor.press(shortcutKeys('save-query', platform))
  await expect(page.getByRole('dialog', { name: 'Save query', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'Save query', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect
    .poll(async () =>
      page
        .evaluate(() => window.harbor.bootstrap())
        .then((state) => state.workspace.tabs.map((tab) => tab.sql)),
    )
    .toContain(draft)
  await page.screenshot({ path: '/tmp/harbor-db-e2e/desktop-workspace.png' })
  await desktop!.close()
  desktop = undefined
  expect((await readFile(join(userData, 'harbor.sqlite3'))).includes(Buffer.from(enteredSecret))).toBe(false)

  page = await launch()
  const restored = await page.evaluate(() => window.harbor.bootstrap())
  expect(restored.profiles.map((profile) => profile.name).sort()).toEqual([
    'E2E MariaDB',
    'E2E PostgreSQL',
    'E2E Redis',
  ])
  expect(restored.profiles.find((profile) => profile.id === postgres.id)?.hasPassword).toBe(
    initial.secureStorage.available,
  )
  expect(restored.workspace.tabs.some((tab) => tab.sql === draft)).toBe(true)
  expect(restored.history).toHaveLength(0)
  const statuses = await page.evaluate(async () =>
    Promise.all(
      (await window.harbor.bootstrap()).profiles.map((profile) => window.harbor.status(profile.id)),
    ),
  )
  expect(statuses.every((status) => status.state === 'disconnected')).toBe(true)
  await page.keyboard.press(shortcutKeys('command-palette', platform))
  const palette = page.getByRole('combobox', { name: 'Search actions and database objects' })
  await expect(palette).toBeVisible()
  await palette.fill('Open settings')
  await palette.press('ArrowDown')
  await palette.press('Enter')
  await expect(page.getByRole('heading', { name: 'Make yourself at home' })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const originalTab = restored.workspace.activeTabId
  await page.keyboard.press(shortcutKeys('new-query', platform))
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.keyboard.press(shortcutKeys('previous-tab', platform))
  await expect
    .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.activeTabId)
    .toBe(originalTab)
  await page.keyboard.press(shortcutKeys('next-tab', platform))
  await expect
    .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.activeTabId)
    .not.toBe(originalTab)
  await page.keyboard.press(shortcutKeys('close-tab', platform))
  await expect(page.getByRole('tab')).toHaveCount(1)
  expect(
    await page
      .evaluate(() => window.harbor.bootstrap())
      .then((state) => JSON.stringify(state).includes(enteredSecret)),
  ).toBe(false)
})

test('actual database round trips through the Electron bridge, transaction isolation, cancellation and Redis TTL', async () => {
  test.skip(
    process.env.HARBOR_INTEGRATION !== '1',
    'Set HARBOR_INTEGRATION=1 with the isolated development database services running.',
  )
  let page = await launch()
  const profiles = (['postgres', 'mariadb', 'redis'] as const).map((engine) =>
    profileSchema.parse({
      id: `electron-${engine}`,
      name: `Electron ${engine}`,
      engine,
      host: '127.0.0.1',
      port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 16379,
      username: engine === 'redis' ? '' : 'harbor',
      database: engine === 'redis' ? '' : 'harbor',
      schema: engine === 'postgres' ? 'public' : engine === 'mariadb' ? 'harbor' : '',
      readOnly: false,
      queryTimeout: 15000,
    }),
  )
  const secureAvailable = (await page.evaluate(() => window.harbor.bootstrap())).secureStorage.available
  await page.evaluate(
    async ({ profiles, password, remember }) => {
      for (const profile of profiles)
        await window.harbor.saveProfile({ profile, secrets: { password }, rememberPassword: remember })
    },
    { profiles, password: fixturePassword, remember: secureAvailable },
  )
  // Reopen before connecting: this exercises the actual OS-protected ciphertext when available.
  await desktop!.close()
  desktop = undefined
  page = await launch()
  const states = await page.evaluate(
    async ({ profiles, password, remembered }) => {
      const result = []
      for (const profile of profiles)
        result.push(
          await window.harbor.connect({ id: profile.id, ...(remembered ? {} : { secrets: { password } }) }),
        )
      return result
    },
    { profiles, password: fixturePassword, remembered: secureAvailable },
  )
  expect(states.map((state) => state.state)).toEqual(['connected', 'connected', 'connected'])
  for (const engine of ['postgres', 'mariadb'] as const) {
    const result = await page.evaluate(async (engine) => {
      const connectionId = `electron-${engine}`
      const query = (sessionId: string, sql: string) =>
        window.harbor.query({
          connectionId,
          sessionId,
          requestId: crypto.randomUUID(),
          sql,
          maxRows: 20,
          privateSession: true,
        })
      const rows = await query(
        'roundtrip',
        'SELECT CAST(9007199254740993 AS DECIMAL(30,0)) AS exact_integer, NULL AS empty_value',
      )
      await window.harbor.transaction({ connectionId, sessionId: 'owner', action: 'begin' })
      const owner = await query('owner', 'SELECT 1')
      const other = await query('other', 'SELECT 2')
      await window.harbor.transaction({ connectionId, sessionId: 'owner', action: 'rollback' })
      return { rows: rows.sets[0]!.rows[0], owner: owner.transaction, other: other.transaction }
    }, engine)
    expect(result.rows).toEqual(['9007199254740993', null])
    expect(result.owner).toBe('open')
    expect(result.other).toBe('idle')
  }
  const cancellation = await page.evaluate(async () => {
    const connectionId = 'electron-postgres'
    const sessionId = 'cancellation'
    await window.harbor.query({
      connectionId,
      sessionId,
      requestId: 'warm',
      sql: 'SELECT 1',
      maxRows: 10,
      privateSession: true,
    })
    const result = window.harbor.query({
      connectionId,
      sessionId,
      requestId: 'slow',
      sql: 'SELECT pg_sleep(10)',
      maxRows: 10,
      privateSession: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const request = await window.harbor.cancel({ connectionId, sessionId, requestId: 'slow' })
    const outcome = await result
    return { request, cancelled: outcome.cancelled, durationMs: outcome.durationMs }
  })
  expect(cancellation.request.requested).toBe(true)
  expect(cancellation.cancelled).toBe(true)
  expect(cancellation.durationMs).toBeLessThan(10000)
  const redisValue = await page.evaluate(async () => {
    const connectionId = 'electron-redis'
    const keyBase64 = btoa(`harbor-desktop:${crypto.randomUUID()}`)
    try {
      await window.harbor.redisMutate({ connectionId, keyBase64, action: 'set', value: 'first' })
      await window.harbor.redisMutate({ connectionId, keyBase64, action: 'expire', ttl: 60 })
      await window.harbor.redisMutate({
        connectionId,
        keyBase64,
        action: 'set',
        value: 'updated',
        expectedBase64: btoa('first'),
      })
      const inspected = await window.harbor.redisInspect({
        connectionId,
        keyBase64,
        cursor: '0',
        offset: 0,
        count: 10,
      })
      return { value: inspected.value, ttl: inspected.key.ttl }
    } finally {
      await window.harbor.redisMutate({ connectionId, keyBase64, action: 'delete' })
    }
  })
  expect(redisValue.value).toBe('updated')
  expect(redisValue.ttl).toBeGreaterThan(0)
  expect(redisValue.ttl).toBeLessThanOrEqual(60)
  await page.getByRole('button', { name: 'Electron postgres', exact: true }).dblclick()
  await expect(page.getByLabel('Electron postgres: connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New query', exact: true }).first().click()
  await typeSql(
    page,
    "SELECT n AS id, 'developer' || n || '@example.test' AS email, CASE WHEN n % 3 = 0 THEN 'Team' ELSE 'Professional' END AS plan, (n * 29.50)::numeric(12,2) AS amount, 'active' AS status FROM generate_series(1, 16) n;",
  )
  await page.getByRole('button', { name: 'Format SQL', exact: true }).click()
  await page.keyboard.press(shortcutKeys('run-script', shortcutPlatform(process.platform)))
  await expect(page.getByText('developer1@example.test', { exact: true }).first()).toBeVisible()
  await page.getByText('developer1@example.test', { exact: true }).first().click()
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
  for (const theme of ['dark', 'light'] as const) {
    await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
    await page.getByLabel(theme === 'dark' ? 'Dark theme' : 'Light theme', { exact: true }).click()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
    await page.screenshot({ path: `/tmp/harbor-db-e2e/harbor-${theme}.png` })
  }
  await desktop!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700))
  await page.screenshot({ path: '/tmp/harbor-db-e2e/harbor-1024.png' })
  await page.evaluate(async () => {
    for (const profile of (await window.harbor.bootstrap()).profiles)
      await window.harbor.disconnect(profile.id)
  })
})
