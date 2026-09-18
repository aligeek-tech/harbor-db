import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createClient, ClickHouseLogLevel } from '@clickhouse/client'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { importTargetConfirmation } from '../src/shared/imports'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
test('ClickHouse desktop reads exact analytics, shows estimates and requires nontransactional append consent', async () => {
  test.skip(process.env.HARBOR_CLICKHOUSE !== '1', 'Requires the disposable ClickHouse26.3 fixture.')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-clickhouse-ui-')),
    root = resolve(import.meta.dirname, '..'),
    table = 'ui_' + randomUUID().replaceAll('-', '')
  const admin = createClient({
    url: 'http://127.0.0.1:18123',
    username: 'harbor',
    password: 'harbor_test',
    database: 'harbor',
    log: { level: ClickHouseLogLevel.OFF },
  })
  let desktop: ElectronApplication | undefined
  try {
    await admin.command({
      query: `CREATE TABLE ${table}(id UInt64,amount Decimal(38,9),label Nullable(String)) ENGINE=MergeTree ORDER BY id`,
    })
    await admin.command({
      query: `INSERT INTO ${table} VALUES(9007199254740993,12345678901234567890.123456789,NULL)`,
    })
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
    const profile = profileSchema.parse({
      id: 'clickhouse-ui',
      name: 'Disposable ClickHouse desktop',
      engine: 'clickhouse',
      host: '127.0.0.1',
      port: 18123,
      username: 'harbor',
      database: 'harbor',
      schema: 'harbor',
      readOnly: false,
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
    await page.getByRole('button', { name: table, exact: true }).click()
    const grid = page.locator('.table-scroll:visible')
    await expect(
      grid.getByRole('cell', { name: '12345678901234567890.123456789', exact: true }),
    ).toBeVisible()
    await expect(grid.getByRole('cell', { name: '9007199254740993', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Begin', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Import file…', exact: true }).click()
    const wizard = page.getByRole('dialog', { name: 'Import file into table', exact: true })
    await wizard.getByLabel('Import format', { exact: true }).selectOption('jsonl')
    const file = join(directory, 'append.jsonl')
    await writeFile(
      file,
      '{"id":9007199254740994,"amount":99999999999999999999.999999999,"label":"reviewed append"}\n',
    )
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    await wizard.getByRole('button', { name: 'Choose and preview file…', exact: true }).click()
    await wizard.getByLabel('Conversion for source 1', { exact: true }).selectOption('integer')
    await wizard.getByLabel('Conversion for source 2', { exact: true }).selectOption('decimal')
    await wizard.getByRole('checkbox', { name: /each append batch is separate/ }).check()
    await wizard
      .getByLabel('Confirm import target', { exact: true })
      .fill(
        importTargetConfirmation({ connectionId: profile.id, database: 'harbor', schema: 'harbor', table }),
      )
    const start = wizard.getByRole('button', { name: 'Start reviewed import', exact: true })
    await expect(start).toBeDisabled()
    await wizard.getByRole('checkbox', { name: /I authorize nontransactional append/ }).check()
    await start.click()
    await expect(wizard.getByRole('status')).toContainText('Import completed')
    await expect(wizard.getByText('Acknowledged appended rows', { exact: true })).toBeVisible()
    await wizard.getByRole('button', { name: 'Close and reload table', exact: true }).click()
    await expect(
      grid.getByRole('cell', { name: '99999999999999999999.999999999', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT {amount:Decimal(38,9)} AS exact_amount;')
    await page
      .locator('summary:visible')
      .filter({ hasText: /^Parameters \(0\)$/ })
      .click()
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Parameter 1 name', { exact: true }).fill('amount')
    await page.getByLabel('Parameter 1 type', { exact: true }).selectOption('decimal')
    await page.getByLabel('Parameter 1 value', { exact: true }).fill('12345678901234567890.123456789')
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(
      grid.getByRole('cell', { name: '12345678901234567890.123456789', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Inspect query plan', exact: true }).click()
    const plan = page.getByRole('dialog', { name: 'Query plan inspector', exact: true })
    await expect(
      plan.getByRole('button', { name: 'Review execution-based analysis', exact: true }),
    ).toBeDisabled()
    await plan.getByRole('button', { name: 'Estimate only', exact: true }).click()
    await expect(plan.getByText(/ReadFrom|Expression|Projection/).first()).toBeVisible()
    expect(JSON.stringify(await page.evaluate(() => window.harbor.bootstrap()))).not.toContain(
      '99999999999999999999.999999999',
    )
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await admin.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` })
    await admin.close()
    await rm(directory, { recursive: true, force: true })
  }
})
