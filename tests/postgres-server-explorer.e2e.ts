import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutLabel, shortcutPlatform } from '../src/shared/shortcuts'

test('blank PostgreSQL profile browses databases and keeps table and saved SQL targets isolated under one connection', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated PostgreSQL development service.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-postgres-server-'))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const databases = [`server_alpha_${suffix}`, `server_beta_${suffix}`]
  const markers = ['alpha database marker', 'beta database marker']
  const savedNames = ['SQL bound to alpha database', 'SQL bound to beta database']
  const sql = 'SELECT current_database() AS database_name, label FROM public.records;'
  const credentials = { host: '127.0.0.1', port: 15432, user: 'harbor', password: 'harbor_test' }
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'PostgreSQL server fixture',
    engine: 'postgres',
    host: credentials.host,
    port: credentials.port,
    username: credentials.user,
    database: '',
    schema: 'public',
    environment: 'development',
    readOnly: true,
  })
  const admin = new Client({ ...credentials, database: 'harbor' })
  const fixtures: Array<{ database: string; client: Client }> = []
  const created: string[] = []
  let adminConnected = false
  let desktop: ElectronApplication | undefined
  async function createFixture(index: number) {
    const database = databases[index]
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    created.push(database)
    const client = new Client({ ...credentials, database })
    await client.connect()
    fixtures.push({ database, client })
    await client.query('CREATE TABLE public.records (id INTEGER PRIMARY KEY, label TEXT)')
    await client.query('INSERT INTO public.records VALUES (1, $1)', [markers[index]])
  }
  try {
    await admin.connect()
    adminConnected = true
    // Two generated databases share table/schema names to expose accidental
    // deduplication or dispatch through the profile's maintenance connection.
    await createFixture(0)
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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await waitForElectronWorkspace(page)
    // Fixture setup uses the validated bridge. All browsing, query execution,
    // saving, reopening, refreshing, and reconnecting below use actual controls.
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'harbor_test' },
        rememberPassword: false,
      })
      const state = await window.harbor.bootstrap()
      await window.harbor.saveWorkspace({
        ...state.workspace,
        tabs: [],
        activeTabId: null,
        expanded: [],
        settings: { ...state.workspace.settings, theme: 'dark', sidebarWidth: 360, editorHeight: 200 },
      })
    }, profile)
    await page.reload()
    await expect(page).toHaveTitle('Harbor DB')
    expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/)
    await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await inspectElectronSandbox(desktop, page)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))

    const profileButton = page.getByRole('button', { name: profile.name, exact: true })
    const tree = profileButton.locator('..').locator('..')
    const actions = page.getByRole('button', { name: `Actions for ${profile.name}`, exact: true })
    await profileButton.dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await expect(tree.getByText('Databases', { exact: true })).toBeVisible()
    const databaseButton = (database: string) =>
      tree.getByRole('button', { name: new RegExp(`^(?:Expand|Collapse) database ${database}$`) })
    const databaseTree = (database: string) => tree.locator(`[data-database="${database}"]`)
    await expect(databaseButton(databases[0])).toBeVisible()
    await expect(databaseButton(databases[0])).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.getByRole('button', { name: 'records', exact: true })).toHaveCount(0)
    await expect(databaseButton(databases[1])).toHaveCount(0)
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeDisabled()
    await expect(
      page
        .locator('.editor-region:visible')
        .getByRole('button', { name: /^Run(?: (?:Command|Ctrl)\+Enter)?$/ }),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Choose database', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose database', exact: true })
    await picker.getByRole('button', { name: databases[0], exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Ready when you are', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeEnabled()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.harbor.bootstrap())
        return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
      })
      .toMatchObject({ connectionId: profile.id, database: databases[0], kind: 'query' })
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    await createFixture(1)
    await tree.getByRole('button', { name: `Refresh ${profile.name} objects`, exact: true }).click()
    await expect(databaseButton(databases[1])).toBeVisible()

    for (const [index, database] of databases.entries()) {
      const group = databaseTree(database)
      await databaseButton(database).click()
      const schema = group.getByRole('button', {
        name: new RegExp(`^(?:Expand|Collapse) schema public in ${database}$`),
      })
      await expect(schema).toBeVisible()
      if ((await schema.getAttribute('aria-expanded')) !== 'true') await schema.click()
      await group.getByRole('button', { name: 'records', exact: true }).click()
      const grid = page.locator('.table-scroll:visible')
      await expect(grid.getByRole('cell', { name: markers[index], exact: true })).toBeVisible()
      await expect(grid.getByRole('cell', { name: markers[1 - index], exact: true })).toHaveCount(0)
      await expect(page.locator('.context-target')).toHaveText(profile.name)
      await expect(page.locator('.context-bar')).toContainText(database)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect
        .poll(async () => {
          const state = await page.evaluate(() => window.harbor.bootstrap())
          return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
        })
        .toMatchObject({
          connectionId: profile.id,
          database,
          schema: 'public',
          table: 'records',
          kind: 'table',
        })
      await group.getByRole('button', { name: `New query in ${database}`, exact: true }).click()
      await typeSql(page, sql)
      await page.getByRole('button', { name: 'Run script', exact: true }).click()
      await expect(grid.getByRole('cell', { name: database, exact: true })).toBeVisible()
      await expect(grid.getByRole('cell', { name: markers[index], exact: true })).toBeVisible()
      await page
        .getByRole('button', {
          name: `Save query · ${shortcutLabel('save-query', shortcutPlatform(process.platform))}`,
          exact: true,
        })
        .click()
      const save = page.getByRole('dialog', { name: 'Save query', exact: true })
      await save.getByLabel('Name', { exact: true }).fill(savedNames[index])
      await save.getByRole('button', { name: 'Save query', exact: true }).click()
      await expect(save).toHaveCount(0)
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).savedQueries.find(
            (query) => query.name === savedNames[index],
          ),
        )
        .toMatchObject({ connectionId: profile.id, database, sql })
    }

    const browsed = await page.evaluate(() => window.harbor.bootstrap())
    expect(browsed.profiles).toHaveLength(1)
    expect(browsed.profiles[0]).toMatchObject({ id: profile.id, database: '', schema: 'public' })
    expect(browsed.workspace.tabs.filter((tab) => tab.kind === 'table')).toHaveLength(2)
    expect(
      browsed.workspace.tabs
        .filter((tab) => tab.kind === 'table')
        .map((tab) => tab.database)
        .sort(),
    ).toEqual([...databases].sort())
    let historyIds = browsed.history.map((entry) => entry.id)
    for (const [index, database] of databases.entries()) {
      await page.getByRole('button', { name: /^Saved queries/ }).click()
      await page
        .getByRole('button', { name: `Open saved query ${savedNames[index]} without executing`, exact: true })
        .click()
      await expect(page.getByRole('heading', { name: 'Ready when you are', exact: true })).toBeVisible()
      await expect(page.locator('.context-bar')).toContainText(database)
      await expect
        .poll(async () => {
          const state = await page.evaluate(() => window.harbor.bootstrap())
          return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
        })
        .toMatchObject({ connectionId: profile.id, database, sql, kind: 'query' })
      expect((await page.evaluate(() => window.harbor.bootstrap())).history.map((entry) => entry.id)).toEqual(
        historyIds,
      )
      await page.getByRole('button', { name: 'Run script', exact: true }).click()
      const grid = page.locator('.table-scroll:visible')
      await expect(grid.getByRole('cell', { name: database, exact: true })).toBeVisible()
      await expect(grid.getByRole('cell', { name: markers[index], exact: true })).toBeVisible()
      historyIds = (await page.evaluate(() => window.harbor.bootstrap())).history.map((entry) => entry.id)
    }
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/postgres-server-explorer.png' })

    await fixtures[0].client.query('CREATE TABLE public.added_after_refresh (id INTEGER PRIMARY KEY)')
    await databaseTree(databases[0])
      .getByRole('button', { name: `Refresh database ${databases[0]}`, exact: true })
      .click()
    await expect(
      databaseTree(databases[0]).getByRole('button', { name: 'added_after_refresh', exact: true }),
    ).toBeVisible()
    await expect(
      databaseTree(databases[1]).getByRole('button', { name: 'added_after_refresh', exact: true }),
    ).toHaveCount(0)
    await page.getByRole('button', { name: `Collapse ${profile.name}`, exact: true }).click()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByLabel(`${profile.name}: disconnected`, { exact: true })).toBeVisible()
    await fixtures[1].client.query('CREATE TABLE public.added_while_disconnected (id INTEGER PRIMARY KEY)')
    await actions.click()
    await page.getByRole('menuitem', { name: 'Edit connection', exact: true }).click()
    const reconnect = page.getByRole('dialog', { name: 'Edit connection', exact: true })
    await expect(reconnect.getByLabel('Database', { exact: true })).toHaveValue('')
    await reconnect.getByLabel(/^Password/).fill('harbor_test')
    await reconnect.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(reconnect).toHaveCount(0)
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Expand ${profile.name}`, exact: true }).click()
    await expect(
      databaseTree(databases[1]).getByRole('button', { name: 'added_while_disconnected', exact: true }),
    ).toBeVisible()
    for (const [index, database] of databases.entries()) {
      await databaseTree(database).getByRole('button', { name: 'records', exact: true }).click()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(
        page.locator('.table-scroll:visible').getByRole('cell', { name: markers[index], exact: true }),
      ).toBeVisible()
      await expect(page.locator('.context-bar')).toContainText(database)
    }
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(final.profiles).toHaveLength(1)
    expect(final.profiles[0]).toMatchObject({ id: profile.id, database: '' })
    expect(final.workspace.tabs.every((tab) => tab.connectionId === profile.id)).toBe(true)
    expect(final.workspace.tabs.filter((tab) => tab.kind === 'table')).toHaveLength(2)
    await expect(tree.getByRole('alert')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    if (desktop) {
      await desktop.close()
    }
    await Promise.allSettled(fixtures.map(({ client }) => client.end()))
    if (adminConnected) {
      try {
        for (const database of created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
