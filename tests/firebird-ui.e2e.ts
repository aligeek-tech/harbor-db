import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Firebird form, exact native SQL, transaction state and inert reopened draft', async () => {
  const fixture = process.env.HARBOR_FIREBIRD_FIXTURE
  test.skip(!fixture, 'Requires an explicitly selected disposable Firebird fixture')
  const config = JSON.parse(await readFile(fixture!, 'utf8')), directory = await mkdtemp(join(tmpdir(), 'harbor-firebird-ui-')), root = resolve(import.meta.dirname, '..')
  let desktop: ElectronApplication | undefined
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await _electron.launch({ chromiumSandbox: true, args: [root], cwd: root, env: { ...env, HARBOR_USER_DATA: directory } })
    const page = await desktop.firstWindow(); await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await selectDatabaseEngine(dialog, 'Firebird')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Firebird native fixture')
    await dialog.getByLabel('Port', { exact: true }).fill(String(config.port))
    await dialog.getByLabel('Username', { exact: true }).fill(config.username)
    await dialog.getByLabel('Password', { exact: true }).fill(config.password)
    await dialog.getByLabel('Database alias or server file path', { exact: true }).fill(config.database)
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Firebird 5.0.4/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Firebird native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Firebird native fixture', exact: true }).dblclick()
    await typeSql(page, "SELECT CAST(9223372036854775807 AS BIGINT) AS EXACT, TIMESTAMP '2026-09-18 12:34:56.1234' AS STAMP FROM RDB$DATABASE")
    await page.getByRole('button', { name: /^Run(?! script)/ }).click()
    await expect(page.getByText('9223372036854775807', { exact: true })).toBeVisible()
    await expect(page.getByText('2026-09-18 12:34:56.1234', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Rollback', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.history.filter(item => item.connectionId === state.profiles.find(p => p.name === 'Firebird native fixture')?.id)).toHaveLength(1)
    await page.reload(); await waitForElectronWorkspace(page)
    await expect(page.locator('.monaco-editor').first()).toBeVisible()
    expect(await page.evaluate(() => window.harbor.bootstrap()).then(value => value.history.length)).toBe(state.history.length)
  } finally { await desktop?.close(); await rm(directory, { recursive: true, force: true }) }
})
