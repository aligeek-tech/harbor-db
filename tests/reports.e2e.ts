import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const root = resolve(import.meta.dirname, '..')
const primary = shortcutPlatform(process.platform)

test('saved DuckDB report restores inert chart settings and resolves a deleted binding explicitly', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-reports-desktop-'))
  let desktop: ElectronApplication | undefined
  try {
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
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const original = profileSchema.parse({
      id: 'report-source',
      name: 'Report source',
      engine: 'duckdb',
      host: '127.0.0.1',
      port: 1,
      schema: 'main',
      readOnly: false,
      duckdb: { path: join(userData, 'reports.duckdb'), mode: 'open' },
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile: { ...profile, duckdb: { ...profile.duckdb!, mode: 'create' } },
        rememberPassword: false,
      })
      await window.harbor.connect({ id: profile.id })
      const sessionId = crypto.randomUUID()
      try {
        await window.harbor.query({
          connectionId: profile.id,
          sessionId,
          requestId: crypto.randomUUID(),
          privateSession: true,
          sql: "CREATE TABLE report_source(region VARCHAR, amount HUGEINT); INSERT INTO report_source VALUES ('north one',9007199254740993),('south',2),('north two',3);",
          maxRows: 100,
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
      await window.harbor.disconnect(profile.id)
      await window.harbor.saveProfile({ profile, rememberPassword: false })
    }, original)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: original.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${original.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT region, amount FROM report_source ORDER BY region;')
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect(page.locator('.table-scroll:visible').getByRole('cell', { name: 'north one' })).toBeVisible()

    await page.getByRole('button', { name: 'Reports', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Local analytics reports', exact: true })
    await expect(dialog).toContainText('never execute, mutate, read another file, or send data remotely')
    await dialog.getByLabel('Report name', { exact: true }).fill('North exact amounts')
    await dialog.getByLabel('Report view', { exact: true }).selectOption('line')
    await dialog.getByLabel('Report point limit', { exact: true }).fill('2')
    await dialog.getByRole('button', { name: 'Add filter', exact: true }).click()
    await dialog.getByLabel('Report filter 1 column', { exact: true }).selectOption('0')
    await dialog.getByLabel('Report filter 1 operator', { exact: true }).selectOption('contains')
    await dialog.getByLabel('Report filter 1 value', { exact: true }).fill('north')
    await expect(dialog.getByRole('status')).toContainText('Showing 2 of 2 filtered rows from 3 loaded rows')
    await expect(dialog).toContainText('approximate numeric conversion')
    await expect(dialog.getByText('9007199254740993', { exact: true })).toBeVisible()
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Save definition', exact: true }).click()
    await expect(dialog.getByText(/Report definition saved locally/)).toBeVisible()
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).reports.length)
      .toBe(1)
    const saved = (await page.evaluate(() => window.harbor.bootstrap())).reports[0]
    expect(saved).toMatchObject({
      name: 'North exact amounts',
      connectionId: original.id,
      view: { kind: 'line', categoryColumn: 0, valueColumn: 1, maxPoints: 2, sampling: 'even' },
      filters: [{ column: 0, operator: 'contains', value: 'north' }],
      parameterDefinitions: [],
    })
    expect(JSON.stringify(saved)).not.toContain('9007199254740993')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
            (tab) => tab.reportId === saved.id,
          )?.reportId,
      )
      .toBe(saved.id)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Reports', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Local analytics reports', exact: true })
    await expect(dialog.getByText(/Saved chart, filters, and sampling restored/)).toBeVisible()
    await expect(dialog.getByLabel('Report view', { exact: true })).toHaveValue('line')
    await expect(dialog.getByLabel('Report point limit', { exact: true })).toHaveValue('2')
    await expect(dialog.getByLabel('Report filter 1 value', { exact: true })).toHaveValue('north')
    await expect(dialog).toContainText('Run the report query explicitly to load a result')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    const replacement = profileSchema.parse({
      ...original,
      id: 'report-replacement',
      name: 'Replacement analytics',
    })
    await page.evaluate(
      async ({ replacement, originalId }) => {
        await window.harbor.saveProfile({ profile: replacement, rememberPassword: false })
        await window.harbor.deleteProfile(originalId)
      },
      { replacement, originalId: original.id },
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    const afterDelete = await page.evaluate(() => window.harbor.bootstrap())
    expect(afterDelete.reports[0].connectionId).toBeUndefined()
    expect(afterDelete.history).toHaveLength(0)
    await page.getByRole('button', { name: /^Saved queries/ }).click()
    const reportRow = page.getByRole('button', {
      name: 'Open report North exact amounts without executing',
      exact: true,
    })
    await expect(reportRow).toBeVisible()
    await reportRow.click()
    const chooser = page.getByRole('dialog', { name: 'Choose query target', exact: true })
    await expect(chooser).toContainText('does not connect or execute')
    await chooser.getByRole('button', { name: /Replacement analytics/ }).click()
    await expect(page.getByRole('tab', { name: /North exact amounts/ })).toBeVisible()
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    await page.getByRole('button', { name: 'Reports', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Local analytics reports', exact: true })
    await expect(dialog.getByRole('status')).toContainText('Saved chart, filters, and sampling restored')
    await expect(dialog.getByLabel('Report view', { exact: true })).toHaveValue('line')
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
