import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import oracledb from 'oracledb'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Oracle native form, exact table projections, SQL and physical transaction controls', async () => {
  const fixture = process.env.HARBOR_ORACLE_FIXTURE_ENV
  test.skip(!fixture, 'Requires authorized isolated Oracle Free fixture.')
  const password = /^ORACLE_TEST_PASSWORD=(.+)$/m.exec(await readFile(fixture!, 'utf8'))?.[1] ?? ''
  const directory = await mkdtemp(join(tmpdir(), 'harbor-oracle-ui-')),
    root = resolve(import.meta.dirname, '..')
  const table = 'UI_' + randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  const admin = await oracledb.getConnection({
    user: 'HARBOR_VERIFY',
    password,
    connectString: '127.0.0.1:25421/FREEPDB1',
  })
  let desktop: ElectronApplication | undefined
  try {
    await admin.execute(
      `CREATE TABLE "${table}"(ID NUMBER(20) PRIMARY KEY, AMOUNT NUMBER(38,9), CREATED TIMESTAMP(9) WITH TIME ZONE, NOTE CLOB)`,
    )
    await admin.execute(
      `INSERT INTO "${table}" VALUES(9007199254740993,12345678901234567890.123456789,TO_TIMESTAMP_TZ('2026-09-18T12:34:56.123456789+03:30','YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM'),TO_CLOB('native Oracle'))`,
      {},
      { autoCommit: true },
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    )
    desktop = await _electron.launch({
      chromiumSandbox: true,
      args: [root],
      cwd: root,
      env: { ...env, HARBOR_USER_DATA: directory },
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    await selectDatabaseEngine(page, 'Oracle Database')
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Oracle native fixture')
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await dialog.getByLabel('Port', { exact: true }).fill('25421')
    await dialog.getByLabel('Username', { exact: true }).fill('HARBOR_VERIFY')
    await dialog.getByLabel('Password', { exact: true }).fill(password)
    await expect(dialog.getByLabel('Service name', { exact: true })).toHaveValue('FREEPDB1')
    await dialog.getByLabel('Default schema (optional, exact case)', { exact: true }).fill('HARBOR_VERIFY')
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Oracle 23.26.1/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Oracle native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Oracle native fixture', exact: true }).click()
    await page.getByRole('button', { name: table, exact: true }).click()
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.getByRole('cell', { name: '12345678901234567890.123456789', exact: true })).toBeVisible(
      { timeout: 50000 },
    )
    await expect(
      grid.getByRole('cell', { name: '2026-09-18T12:34:56.123456789+03:30 [+03:30]', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT 9007199254740993 AS EXACT_ID FROM DUAL')
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(grid.getByRole('cell', { name: '9007199254740993', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await typeSql(page, `INSERT INTO "${table}" (ID,NOTE) VALUES(2,'pending native transaction')`)
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(page.getByText('1 affected', { exact: true })).toBeVisible()
    await expect
      .poll(async () => (await admin.execute(`SELECT COUNT(*) FROM "${table}" WHERE ID=2`)).rows)
      .toEqual([[0]])
    await page.getByRole('button', { name: 'Rollback', exact: true }).click()
    await typeSql(page, 'SELECT SYSTIMESTAMP FROM DUAL')
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(
      page.getByRole('alert').filter({ hasText: /cannot fetch raw DATE\/TIMESTAMP/ }),
    ).toBeVisible()
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.getByRole('button', { name: /^Run(?! script)/ })).toBeVisible()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.profiles.find((profile) => profile.name === 'Oracle native fixture')?.engine).toBe('oracle')
    expect(JSON.stringify(state)).not.toContain(password)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await admin.execute(`DROP TABLE "${table}" PURGE`).catch(() => {})
    await admin.close()
    await rm(directory, { recursive: true, force: true })
  }
})
