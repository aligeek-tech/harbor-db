import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema, tabSchema } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

test('empty PostgreSQL explorer explains its database scope and opens another database without retargeting the original profile', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated PostgreSQL development service.')
  const root = resolve(import.meta.dirname, '..')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const emptyDatabase = `explorer_empty_${suffix}`
  const schema = `explorer_populated_${suffix}`
  const userData = await mkdtemp(join(tmpdir(), 'harbor-postgres-explorer-'))
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'Production-labelled empty fixture',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'harbor',
    database: emptyDatabase,
    schema: 'public',
    environment: 'production',
    readOnly: true,
  })
  const originalTab = tabSchema.parse({
    id: randomUUID(),
    connectionId: profile.id,
    kind: 'query',
    title: 'Original database context',
    sql: 'SELECT current_database() AS database_name;',
  })
  const targetName = 'Populated PostgreSQL fixture'
  const admin = new Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'harbor',
    password: 'harbor_test',
    database: 'harbor',
  })
  let adminConnected = false
  let databaseCreated = false
  let desktop: ElectronApplication | undefined
  try {
    await admin.connect()
    adminConnected = true
    // Generated local fixtures only. The production badge tests presentation and
    // safeguards, not a connection to any actual production service.
    await admin.query(`CREATE DATABASE "${emptyDatabase}" TEMPLATE template0`)
    databaseCreated = true
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE TABLE "${schema}".records (id INTEGER PRIMARY KEY, label TEXT)`)
    await admin.query(`INSERT INTO "${schema}".records VALUES (1, 'found in the selected database')`)
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
    await page.evaluate(
      async ({ profile, tab }) => {
        await window.harbor.saveProfile({
          profile,
          secrets: { password: 'harbor_test' },
          rememberPassword: false,
        })
        const state = await window.harbor.bootstrap()
        await window.harbor.saveWorkspace({
          ...state.workspace,
          tabs: [tab],
          activeTabId: tab.id,
          expanded: [],
          settings: { ...state.workspace.settings, theme: 'dark', sidebarWidth: 320, editorHeight: 200 },
        })
      },
      { profile, tab: originalTab },
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page).toHaveTitle('Harbor DB')
    expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/)
    await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await inspectElectronSandbox(desktop, page)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    const originalButton = page.getByRole('button', { name: profile.name, exact: true })
    const originalTree = originalButton.locator('..').locator('..')
    await originalButton.dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    const emptyText = originalTree.getByText(`No user objects found in ${emptyDatabase}.`, { exact: true })
    await expect(emptyText).toBeVisible()
    await expect(
      originalTree.getByText(
        "Choose another database for a new query, or clear this connection's default database to browse the server.",
        { exact: true },
      ),
    ).toBeVisible()
    await expect(originalTree.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Run script', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: emptyDatabase, exact: true }),
    ).toBeVisible()
    await expect(page.locator('.context-target')).toHaveText(profile.name)
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/postgres-explorer-empty.png' })

    await originalTree.getByRole('button', { name: 'Choose database', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Open another database', exact: true })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: `${emptyDatabase} Current`, exact: true })).toBeDisabled()
    await picker.getByRole('button', { name: 'harbor', exact: true }).click()
    const settings = page.getByRole('dialog')
    await expect(settings.getByLabel('Database', { exact: true })).toHaveValue('harbor')
    await expect(settings.getByRole('checkbox', { name: 'Read-only safeguard', exact: true })).toBeChecked()
    await settings.getByLabel('Connection name', { exact: true }).fill(targetName)
    await settings.getByLabel(/^Password/).fill('harbor_test')
    await settings.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await expect(page.getByLabel(`${targetName}: connected`, { exact: true })).toBeVisible()
    const targetButton = page.getByRole('button', { name: targetName, exact: true })
    const targetTree = targetButton.locator('..').locator('..')
    await targetButton.click()
    const schemaButton = targetTree.getByRole('button', { name: new RegExp(`^${schema} \\d+$`) })
    await expect(schemaButton).toBeVisible()
    if ((await schemaButton.getAttribute('aria-expanded')) !== 'true') await schemaButton.click()
    await targetTree.getByRole('button', { name: 'records', exact: true }).click()
    await expect(
      page
        .locator('.table-scroll:visible')
        .getByRole('cell', { name: 'found in the selected database', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.context-target')).toHaveText(targetName)
    await expect(page.locator('.context-bar')).toContainText('harbor')
    await expect(page.getByText('Read-only safeguard', { exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    const target = state.profiles.find((item) => item.name === targetName)!
    expect(target.id).not.toBe(profile.id)
    expect(target).toMatchObject({ database: 'harbor', environment: 'production', readOnly: true })
    expect(state.profiles.find((item) => item.id === profile.id)).toMatchObject({
      database: emptyDatabase,
      schema: 'public',
      environment: 'production',
      readOnly: true,
    })
    expect(state.workspace.tabs.find((tab) => tab.id === originalTab.id)?.connectionId).toBe(profile.id)
    await page.screenshot({ path: '/tmp/harbor-db-e2e/postgres-explorer-populated.png' })

    await originalTree.getByRole('button', { name: `Refresh ${profile.name} objects`, exact: true }).click()
    await expect(emptyText).toBeVisible()
    await page.getByRole('button', { name: `Actions for ${profile.name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reconnect', exact: true }).click()
    // Disconnect clears session-only credentials. Re-enter the fixture secret in
    // the original profile dialog and verify that reconnect retains its target.
    const reconnect = page.getByRole('dialog', { name: 'Edit connection', exact: true })
    await expect(reconnect.getByLabel('Database', { exact: true })).toHaveValue(emptyDatabase)
    await expect(reconnect.getByLabel('Connection name', { exact: true })).toHaveValue(profile.name)
    await expect(reconnect.getByRole('checkbox', { name: 'Read-only safeguard', exact: true })).toBeChecked()
    await reconnect.getByLabel(/^Password/).fill('harbor_test')
    await reconnect.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(reconnect).toHaveCount(0)
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await expect(emptyText).toBeVisible()
    await page.getByRole('tab').filter({ hasText: originalTab.title }).click()
    await page.getByRole('button', { name: 'Run script', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: emptyDatabase, exact: true }),
    ).toBeVisible()
    await expect(page.locator('.context-target')).toHaveText(profile.name)
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(final.profiles.find((item) => item.id === profile.id)?.database).toBe(emptyDatabase)
    expect(final.profiles.find((item) => item.id === target.id)?.database).toBe('harbor')
    // Tab activation and editor state are saved with a debounce. Read the real
    // persisted workspace until that save completes, including on fast runners.
    await expect
      .poll(async () => {
        const saved = await page.evaluate(() => window.harbor.bootstrap())
        return saved.workspace.tabs.find((tab) => tab.kind === 'table' && tab.schema === schema)?.connectionId
      })
      .toBe(target.id)
    expect(errors).toEqual([])
  } finally {
    if (desktop) {
      await desktop.close()
    }
    if (adminConnected) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        if (databaseCreated) await admin.query(`DROP DATABASE "${emptyDatabase}" WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
