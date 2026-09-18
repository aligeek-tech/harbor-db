import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const root = resolve(import.meta.dirname, '..')
async function launch(userData: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  const desktop = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData },
    timeout: 30000,
  })
  const page = await desktop.firstWindow()
  await waitForElectronWorkspace(page)
  return { desktop, page }
}

test('connection hub filters favorites and URI review is redacted, engine-specific and explicit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-connection-experience-'))
  let desktop: ElectronApplication | undefined
  try {
    const launched = await launch(userData)
    desktop = launched.desktop
    const page = launched.page
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Favorite target',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      favorite: true,
      folder: 'Many folders',
      tags: ['catalog-team'],
    })
    await page.evaluate(
      async (profile) => window.harbor.saveProfile({ profile, rememberPassword: false }),
      profile,
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('combobox', { name: 'Connection view', exact: true }).selectOption('favorites')
    await expect(page.getByRole('button', { name: profile.name, exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Connection view', exact: true }).selectOption('recent')
    await expect(page.getByText('No recent connections yet.', { exact: false })).toBeVisible()
    await page.getByRole('combobox', { name: 'Connection view', exact: true }).selectOption('all')
    await page.getByLabel('Filter connections and loaded objects', { exact: true }).fill('catalog-team')
    await expect(page.getByRole('button', { name: profile.name, exact: true })).toBeVisible()
    await page.getByLabel('Filter connections and loaded objects', { exact: true }).fill('')

    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
    await dialog.getByText('Use a connection URL', { exact: true }).click()
    await dialog
      .getByLabel('Connection URL', { exact: true })
      .fill('mysql://demo:private%40value@127.0.0.1:13306/example?ssl=true')
    await dialog.getByRole('button', { name: 'Parse', exact: true }).click()
    await expect(dialog.getByLabel('Parsed connection URL preview')).toContainText('MySQL')
    await expect(dialog.getByLabel('Parsed connection URL preview')).toContainText(
      'Password supplied (hidden)',
    )
    await expect(dialog.getByLabel('Parsed connection URL preview')).not.toContainText('private')
    await expect(dialog.getByRole('button', { name: 'Database engine: MySQL', exact: true })).toBeVisible()
    await expect(dialog.getByLabel('Connection URL', { exact: true })).toHaveValue('')
    await dialog.getByLabel('Connection name', { exact: true }).fill('MySQL offline target')
    await dialog.getByLabel('Environment', { exact: true }).selectOption('production')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'MySQL offline target', exact: true })).toBeVisible()
    await expect(page.getByTitle('Production environment', { exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.profiles.find((item) => item.name === 'MySQL offline target')).toMatchObject({
      engine: 'mysql',
      readOnly: true,
      hasPassword: false,
    })
    expect(state.history).toHaveLength(0)
    expect(JSON.stringify(state)).not.toContain('private@value')

    await page.keyboard.press(shortcutKeys('command-palette', shortcutPlatform(process.platform)))
    await page.getByLabel('Search scope', { exact: true }).selectOption('connections')
    await page
      .getByRole('combobox', { name: 'Search actions and database objects', exact: true })
      .fill('Favorite')
    await expect(page.getByRole('listbox').getByRole('option', { name: /Favorite target/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Open settings/ })).toHaveCount(0)
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})

test('palette loads one PostgreSQL catalog and selected table indexes without executing user SQL', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the disposable PostgreSQL service.')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-catalog-search-'))
  const schema = `palette_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = new Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'harbor',
    password: 'harbor_test',
    database: 'harbor',
  })
  let connected = false
  let desktop: ElectronApplication | undefined
  try {
    await admin.connect()
    connected = true
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE TABLE "${schema}".records (id INTEGER PRIMARY KEY, label TEXT)`)
    await admin.query(`CREATE INDEX "${schema}_label_idx" ON "${schema}".records(label)`)
    const launched = await launch(userData)
    desktop = launched.desktop
    const page = launched.page
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Scoped catalog fixture',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'harbor',
      database: 'harbor',
      schema,
      readOnly: true,
    })
    await page.evaluate(
      async (profile) =>
        window.harbor.saveProfile({ profile, secrets: { password: 'harbor_test' }, rememberPassword: false }),
      profile,
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.keyboard.press(shortcutKeys('command-palette', shortcutPlatform(process.platform)))
    await page.getByLabel('Search scope', { exact: true }).selectOption('objects')
    await page.getByLabel('Search connection', { exact: true }).selectOption(profile.id)
    await page.getByRole('button', { name: 'Load this database’s catalog', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'No row data was read' })).toBeVisible()
    await page
      .getByLabel('Table for index search', { exact: true })
      .selectOption({ label: `${schema}.records` })
    await page.getByRole('button', { name: 'Load indexes', exact: true }).click()
    await page
      .getByRole('combobox', { name: 'Search actions and database objects', exact: true })
      .fill(`${schema}_label_idx`)
    await page.getByRole('option', { name: new RegExp(`${schema}_label_idx`) }).click()
    await expect(page.getByLabel('Catalog object details', { exact: true })).toContainText('CREATE INDEX')
    await expect(page.getByLabel('Catalog object details', { exact: true })).toContainText(
      `${schema}.records`,
    )
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    await page.keyboard.press('Escape')
    await page.getByLabel('Connection view', { exact: true }).selectOption('recent')
    await expect(page.getByRole('button', { name: profile.name, exact: true })).toBeVisible()
  } finally {
    await desktop?.close()
    if (connected) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(userData, { recursive: true, force: true })
  }
})

test('SQLite file workflow separates existing-file tests from reviewed creation and browses real local rows', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-sqlite-workbench-'))
  const file = join(userData, 'customer-fixture.sqlite3')
  let desktop: ElectronApplication | undefined
  try {
    const launched = await launch(userData)
    desktop = launched.desktop
    const page = launched.page
    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(dialog, 'SQLite')
    await expect(dialog.getByLabel('Host', { exact: true })).toHaveCount(0)
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('TLS / SSL encryption', { exact: true })).toHaveCount(0)
    await dialog.getByLabel('Connection name', { exact: true }).fill('Local SQLite fixture')
    await dialog.getByLabel('SQLite database file', { exact: true }).fill(file)
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('does not exist')
    expect(
      await stat(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await dialog.getByLabel('SQLite database file', { exact: true }).fill(join(userData, 'harbor.sqlite3'))
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('metadata cannot be opened')
    await dialog.getByLabel('Database file operation', { exact: true }).selectOption('create')
    await dialog.getByLabel('SQLite database file', { exact: true }).fill(file)
    await expect(dialog.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('Read-only safeguard', { exact: true })).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Save and create', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Create this SQLite database?', exact: true })
    await expect(review).toContainText(file)
    expect(
      await stat(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await review.getByRole('button', { name: 'Create database', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel('Local SQLite fixture: connected', { exact: true })).toBeVisible()
    const profile = (await page.evaluate(() => window.harbor.bootstrap())).profiles.find(
      (item) => item.name === 'Local SQLite fixture',
    )!
    expect(profile).toMatchObject({
      engine: 'sqlite',
      sqlite: { path: file, mode: 'open' },
      hasPassword: false,
    })
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const sql =
      "CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO records VALUES (1, 'SQLite real row');"
    await typeSql(page, sql)
    await page.keyboard.press(shortcutKeys('run-script', shortcutPlatform(process.platform)))
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.harbor.bootstrap())).history.some(
          (entry) => entry.sql === sql && entry.success,
        ),
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Local SQLite fixture', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh Local SQLite fixture objects', exact: true }).click()
    await page.getByRole('button', { name: 'records', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'SQLite real row', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.context-bar')).toContainText(file)
    expect((await stat(file)).size).toBeGreaterThan(0)
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
