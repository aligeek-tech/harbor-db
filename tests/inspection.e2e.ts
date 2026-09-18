import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

test('live object inspection opens inert bound templates, plans require distinct actions and diagnostics omit query text by default', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires disposable PostgreSQL fixture.')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-inspection-ui-'))
  const schema = 'inspect_' + randomUUID().replaceAll('-', '').slice(0, 12)
  const client = new Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'harbor',
    password: 'harbor_test',
    database: 'harbor',
  })
  let desktop: ElectronApplication | undefined
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(
      `CREATE TABLE "${schema}".records(id bigint PRIMARY KEY, label text NOT NULL); INSERT INTO "${schema}".records VALUES(9007199254740993,'inspection fixture');`,
    )
    const profile = profileSchema.parse({
      id: 'inspect-fixture',
      name: 'Inspected PostgreSQL',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'harbor',
      database: 'harbor',
      schema,
      readOnly: true,
    })
    const root = resolve(import.meta.dirname, '..')
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
    await page.evaluate(
      async (profile) =>
        window.harbor.saveProfile({ profile, secrets: { password: 'harbor_test' }, rememberPassword: false }),
      profile,
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page
      .getByRole('button', { name: new RegExp(`^Actions for (?:harbor\\.)?${schema}\\.records$`) })
      .click()
    await page.getByRole('menuitem', { name: 'Inspect structure', exact: true }).click()
    const object = page.getByRole('dialog', { name: new RegExp(`^(?:harbor\\.)?${schema}\\.records$`) })
    await expect(object).toContainText('Primary key · id')
    await object.getByLabel('Search object properties', { exact: true }).fill('label')
    await expect(object.getByRole('cell', { name: 'label', exact: true })).toBeVisible()
    await object.getByLabel('Search object properties', { exact: true }).fill('')
    await object.getByRole('button', { name: 'Open key-scoped UPDATE template', exact: true }).click()
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.some((tab) => tab.title === 'UPDATE records')).toBe(true)
    const state = await page.evaluate(() => window.harbor.bootstrap())
    const update = state.workspace.tabs.find((tab) => tab.title === 'UPDATE records')!
    expect(update.sql).toBe(`UPDATE "${schema}"."records"\nSET "label" = $1\nWHERE "id" = $2;`)
    expect(update.parameterDefinitions?.map((item) => item.name)).toEqual(['label', 'key_id'])
    expect(state.history).toHaveLength(0)
    expect((await client.query(`SELECT label FROM "${schema}".records`)).rows).toEqual([
      { label: 'inspection fixture' },
    ])
    // Parameters from the inert write template are discarded explicitly when replacing it with this read.
    await page.getByText('Parameters (2)', { exact: true }).click()
    await page.getByRole('button', { name: 'Remove 2', exact: true }).click()
    await page.getByRole('button', { name: 'Remove 1', exact: true }).click()
    await typeSql(page, `SELECT * FROM "${schema}".records WHERE id=9007199254740993;`)
    await page.getByRole('button', { name: 'Inspect query plan', exact: true }).click()
    const plan = page.getByRole('dialog', { name: 'Query plan inspector', exact: true })
    await expect(plan.getByRole('status')).toHaveText(
      'Choose Estimate only to plan without executing the statement.',
    )
    await plan.getByRole('button', { name: 'Estimate only', exact: true }).click()
    await expect(plan.getByRole('status')).toContainText('estimate')
    await plan.getByRole('button', { name: 'Raw plan', exact: true }).click()
    await expect(plan.locator('pre').last()).toContainText('Plan Rows')
    await expect(plan.locator('pre').last()).not.toContainText('Actual Rows')
    await plan.getByRole('button', { name: 'Review execution-based analysis', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Run execution-based analysis?', exact: true })
    await expect(review.getByRole('button', { name: 'Execute analysis', exact: true })).toBeDisabled()
    await review.getByRole('textbox').fill(profile.name)
    await review.getByRole('button', { name: 'Execute analysis', exact: true }).click()
    await expect(plan.getByRole('status')).toContainText('analyze')
    await expect(plan.locator('pre').last()).toContainText('Actual Rows')
    await plan.getByRole('button', { name: 'Plan tree', exact: true }).click()
    await expect(plan.getByText('Actual Rows:', { exact: true })).toBeVisible()
    await plan.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Inspect database activity', exact: true }).click()
    const diagnostics = page.getByRole('dialog', { name: 'Database diagnostics', exact: true })
    await expect(diagnostics.getByRole('checkbox', { name: /Include query text/ })).not.toBeChecked()
    await expect(
      diagnostics.getByText('Choose one diagnostic and load it explicitly.', { exact: true }),
    ).toBeVisible()
    await diagnostics.getByRole('button', { name: 'Load diagnostics', exact: true }).click()
    await expect(diagnostics.locator('.table-scroll')).toBeVisible()
    await expect(diagnostics).not.toContainText('inspection fixture')
    await diagnostics.getByLabel('Diagnostic view', { exact: true }).selectOption('extensions')
    await diagnostics.getByRole('button', { name: 'Load diagnostics', exact: true }).click()
    await expect(diagnostics.getByRole('cell', { name: 'plpgsql', exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await client.end()
    await rm(directory, { recursive: true, force: true })
  }
})
