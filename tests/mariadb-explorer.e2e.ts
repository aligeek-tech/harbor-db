import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import mariadb, { type Connection } from 'mariadb'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox } from './electron-runtime'

test('MariaDB without a default database browses catalogs and preserves the server-level profile on reconnect', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated MariaDB development service.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-maria-explorer-'))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const table = `explorer_${suffix}`
  const laterTable = `explorer_${suffix}_later`
  const defaultTable = `explorer_${suffix}_default`
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'MariaDB server explorer',
    engine: 'mariadb',
    host: '127.0.0.1',
    port: 13306,
    username: 'harbor',
    database: '',
    schema: '',
    environment: 'development',
    readOnly: true,
  })
  let connection: Connection | undefined
  let desktop: ElectronApplication | undefined
  try {
    connection = await mariadb.createConnection({
      host: '127.0.0.1',
      port: 13306,
      user: 'harbor',
      password: 'harbor_test',
      database: 'harbor',
    })
    // Only generated tables in the disposable Compose database are created or removed.
    await connection.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, label VARCHAR(100))`)
    await connection.query(`INSERT INTO \`${table}\` VALUES (1, 'blank database original')`)

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
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForFunction(() => !!window.harbor)
    // Profile setup uses the validated bridge; connecting, browsing, refreshing,
    // opening the settings dialog, and reconnecting below are real UI interactions.
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'harbor_test' },
        rememberPassword: false,
      })
      const state = await window.harbor.bootstrap()
      await window.harbor.saveWorkspace({ ...state.workspace, tabs: [], activeTabId: null, expanded: [] })
    }, profile)
    await page.reload()
    await page.waitForFunction(() => !!window.harbor)
    await test.info().attach('electron-sandbox', {
      body: JSON.stringify(await inspectElectronSandbox(desktop, page), null, 2),
      contentType: 'application/json',
    })
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))

    const profileButton = page.getByRole('button', { name: profile.name, exact: true })
    const tree = profileButton.locator('..').locator('..')
    const actions = page.getByRole('button', { name: `Actions for ${profile.name}`, exact: true })
    await expect(profileButton).toBeVisible()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Edit connection', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Database', { exact: true })).toHaveValue('')
    await expect(dialog.getByLabel('Database', { exact: true })).toHaveAttribute(
      'placeholder',
      'Optional — browse available databases',
    )
    await expect(dialog.getByText(/Leave blank to browse databases available to this account/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    await profileButton.dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await expect(tree.getByText('Databases', { exact: true })).toBeVisible()
    await expect(
      tree.getByText('No default database. Expand a database to browse its objects.', { exact: true }),
    ).toBeVisible()
    const catalog = tree.getByRole('button', { name: 'harbor', exact: true })
    await expect(catalog).toBeVisible()
    await expect(catalog).toHaveAttribute('aria-expanded', 'false')
    await expect(tree.getByRole('button', { name: table, exact: true })).toHaveCount(0)
    await catalog.click()
    await expect(tree.getByRole('button', { name: table, exact: true })).toBeVisible()
    await expect(tree.getByRole('button', { name: 'Refresh harbor objects', exact: true })).toBeEnabled()
    await expect(tree.getByRole('alert')).toHaveCount(0)
    await expect(
      tree.getByText(/No databases are visible|No tables, views, routines, or triggers/),
    ).toHaveCount(0)

    await tree.getByRole('button', { name: table, exact: true }).click()
    const tableTab = page.getByRole('tab').filter({ has: page.getByText(table, { exact: true }) })
    await expect(tableTab).toHaveAttribute('aria-selected', 'true')
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.getByRole('cell', { name: 'blank database original', exact: true })).toBeVisible()
    await expect(page.locator('.context-bar')).toContainText('harbor')
    await expect(page.locator('.context-target')).toHaveText(profile.name)
    const saved = await page.evaluate(async (id) => {
      const state = await window.harbor.bootstrap()
      return state.profiles.find((item) => item.id === id)
    }, profile.id)
    expect(saved?.database).toBe('')
    expect(saved?.schema).toBe('')
    await page.screenshot({ path: test.info().outputPath('mariadb-explorer-blank.png') })

    await page.getByRole('button', { name: `Collapse ${profile.name}`, exact: true }).click()
    await actions.click()
    await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByLabel(`${profile.name}: disconnected`, { exact: true })).toBeVisible()
    // A table introduced while disconnected and collapsed proves that reopening
    // the saved profile fetches its catalog again, without displaying stale objects.
    await connection.query(`CREATE TABLE \`${laterTable}\` (id INT PRIMARY KEY)`)
    await connection.query(`UPDATE \`${table}\` SET label = 'blank database reconnected' WHERE id = 1`)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Edit connection', exact: true }).click()
    await expect(dialog.getByLabel('Database', { exact: true })).toHaveValue('')
    await dialog.getByLabel(/^Password/).fill('harbor_test')
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Expand ${profile.name}`, exact: true }).click()
    await expect(tree.getByRole('button', { name: laterTable, exact: true })).toBeVisible()
    await expect(tree.getByRole('button', { name: /^harbor \d+$/ })).toHaveAttribute('aria-expanded', 'true')
    await tree.getByRole('button', { name: table, exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(grid.getByRole('cell', { name: 'blank database reconnected', exact: true })).toBeVisible()
    await expect(tree.getByRole('alert')).toHaveCount(0)
    expect(
      await page.evaluate(
        async (id) => (await window.harbor.bootstrap()).profiles.find((item) => item.id === id)?.database,
        profile.id,
      ),
    ).toBe('')

    await tree.getByRole('button', { name: 'information_schema', exact: true }).click()
    await expect(tree.getByRole('button', { name: 'SCHEMATA', exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Collapse ${profile.name}`, exact: true }).click()
    await connection.query(`CREATE TABLE \`${defaultTable}\` (id INT PRIMARY KEY)`)
    await actions.click()
    await page.getByRole('menuitem', { name: 'Edit connection', exact: true }).click()
    await dialog.getByLabel('Database', { exact: true }).fill('harbor')
    await dialog.getByLabel(/^Password/).fill('harbor_test')
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Expand ${profile.name}`, exact: true }).click()
    await expect(tree.getByRole('button', { name: defaultTable, exact: true })).toBeVisible()
    await expect(tree.getByRole('button', { name: table, exact: true })).toBeVisible()
    await expect(tree.getByRole('button', { name: /^information_schema(?: \d+)?$/ })).toHaveCount(0)
    await expect(tree.getByRole('button', { name: 'SCHEMATA', exact: true })).toHaveCount(0)
    await expect(tree.getByText('Databases', { exact: true })).toHaveCount(0)
    await expect(tree.getByText(/No default database\. Expand a database/)).toHaveCount(0)
    await expect(tree.getByRole('alert')).toHaveCount(0)
    expect(
      await page.evaluate(
        async (id) => (await window.harbor.bootstrap()).profiles.find((item) => item.id === id)?.database,
        profile.id,
      ),
    ).toBe('harbor')
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('mariadb-explorer.png') })
  } finally {
    if (desktop) {
      const closed = desktop.waitForEvent('close')
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => desktop?.process().kill('SIGTERM'))
      await closed
    }
    if (connection) {
      try {
        await connection.query(`DROP TABLE IF EXISTS \`${defaultTable}\`, \`${laterTable}\`, \`${table}\``)
      } finally {
        await connection.end()
      }
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
