import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { TrinoService } from '../src/main/engines/trino'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Trino desktop connects with TLS, browses catalogs, queries exact values and shows scoped progress without autoexecution on reopen', async () => {
  const file = process.env.HARBOR_TRINO_FIXTURE
  test.skip(!file, 'Requires the disposable real TLS/password Trino483 fixture.')
  const credentials = JSON.parse(await readFile(file!, 'utf8')), ca = await readFile(file!.replace('credentials.private.json', 'ca.pem'), 'utf8')
  const root = resolve(import.meta.dirname, '..'), directory = await mkdtemp(join(tmpdir(), 'harbor-trino-ui-'))
  const service = new TrinoService(), schema = 'ui_' + randomUUID().replaceAll('-', '').slice(0, 12)
  const profile = profileSchema.parse({ id: 'trino-ui-admin', name: 'Trino fixture setup', engine: 'trino', host: '127.0.0.1', port: credentials.port, username: 'harbor_writer', database: 'memory', tls: { enabled: true, ca }, trino: { auth: 'basic' }, readOnly: false })
  const setup = (sql: string) => service.execute({ connectionId: profile.id, database: 'memory', sessionId: randomUUID(), requestId: randomUUID(), sql, confirm: profile.name, maxRows: 1, privateSession: true })
  let desktop: ElectronApplication | undefined
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => _electron.launch({ chromiumSandbox: true, args: [root], cwd: root, env: { ...env, HARBOR_USER_DATA: directory } })
  try {
    expect((await service.connect(profile, { password: credentials.password })).state).toBe('connected')
    await setup(`CREATE SCHEMA memory.${schema}`)
    await setup(`CREATE TABLE memory.${schema}.exact_values AS SELECT CAST(9223372036854775807 AS bigint) AS id,DECIMAL '12345678901234567890.123456789012345678' AS amount`)
    desktop = await launch(); let page = await desktop.firstWindow(); await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    await selectDatabaseEngine(page, 'Trino')
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Trino native desktop')
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await dialog.getByLabel('Port', { exact: true }).fill(String(credentials.port))
    await dialog.getByLabel('Username', { exact: true }).fill('harbor_reader')
    await dialog.getByLabel('Trino authentication', { exact: true }).selectOption('basic')
    await dialog.getByLabel('Password', { exact: true }).fill(credentials.password)
    await dialog.getByLabel('Catalog', { exact: true }).fill('memory')
    await dialog.locator('summary').filter({ hasText: 'Organization & connection preferences' }).click()
    await dialog.getByLabel('Preferred schema', { exact: true }).fill(schema)
    await dialog.locator('summary').filter({ hasText: 'TLS / SSL encryption' }).click()
    await dialog.getByLabel('Use TLS', { exact: true }).check()
    await dialog.getByLabel('CA certificate', { exact: true }).fill(ca)
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Trino 483/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Trino native desktop: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Trino native desktop', exact: true }).click()
    await expect.poll(async () => (await page.getByRole('button').allTextContents()).some((text) => text.includes(schema))).toBe(true)
    const schemaButton = page.getByRole('button').filter({ hasText: schema }).first()
    if (await schemaButton.getAttribute('aria-expanded') === 'false') await schemaButton.click()
    await page.getByRole('button', { name: 'exact_values', exact: true }).click()
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.getByRole('cell', { name: '9223372036854775807', exact: true })).toBeVisible()
    await expect(grid.getByRole('cell', { name: '12345678901234567890.123456789012345678', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Begin', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, `SELECT amount,amount AS amount FROM memory.${schema}.exact_values;`)
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(grid.getByRole('cell', { name: '12345678901234567890.123456789012345678', exact: true })).toHaveCount(2)
    await expect(page.getByLabel('Trino query progress', { exact: true })).toContainText(/FINISHED/)
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(state)).not.toContain(credentials.password)
    expect(JSON.stringify(state)).not.toContain('12345678901234567890.123456789012345678')
    await desktop.evaluate(({ app }) => app.exit(0)); await desktop.close(); desktop = undefined
    desktop = await launch(); page = await desktop.firstWindow(); await waitForElectronWorkspace(page)
    await expect(page.getByRole('button', { name: 'Trino native desktop', exact: true })).toBeVisible()
    const reopened = await page.evaluate(() => window.harbor.bootstrap())
    expect(reopened.profiles[0].engine).toBe('trino')
    expect(reopened.profiles[0].autoReconnect).toBe(false)
    expect(reopened.workspace.tabs.some((tab) => tab.sql.includes('SELECT amount'))).toBe(true)
    await expect(page.getByRole('cell', { name: '12345678901234567890.123456789012345678', exact: true })).toHaveCount(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await desktop?.close()
    await setup(`DROP TABLE IF EXISTS memory.${schema}.exact_values`).catch(() => {})
    await setup(`DROP SCHEMA IF EXISTS memory.${schema}`).catch(() => {})
    await service.closeAll(); await rm(directory, { recursive: true, force: true })
  }
})
