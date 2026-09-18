import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema, savedQuerySchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const root = resolve(import.meta.dirname, '..')
const primary = shortcutPlatform(process.platform)
async function fixture(userData: string) {
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
  })
  try {
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Grid library fixture',
      engine: 'sqlite',
      host: '127.0.0.1',
      port: 1,
      username: '',
      schema: 'main',
      sqlite: { path: join(userData, 'fixture.sqlite3'), mode: 'create' },
      readOnly: false,
    })
    const status = await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      return window.harbor.connect({ id: profile.id })
    }, profile)
    expect(status.state).toBe('connected')
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    return { desktop, page, profile }
  } catch (error) {
    await desktop.close()
    throw error
  }
}

test('real result grid keeps duplicate columns through sort, filtering, column controls, viewers, copy and export', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-grid-controls-'))
  let desktop: ElectronApplication | undefined
  let clipboardBefore: string | undefined
  try {
    const launched = await fixture(userData)
    desktop = launched.desktop
    const page = launched.page
    clipboardBefore = await desktop.evaluate(({ clipboard }) => clipboard.readText())
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(
      page,
      `SELECT 2 AS group_key, 9 AS item, 'second' AS item, '' AS text_value, '{"x":2}' AS payload, X'00FF0A' AS binary_value
UNION ALL SELECT 1, 5, 'third', NULL, '{"x":1}', X'01'
UNION ALL SELECT 1, 7, 'first', 'line1' || char(10) || 'line2', '{"x":3}', X'02';`,
    )
    await page.keyboard.press(shortcutKeys('run-current', primary))
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.getByRole('cell', { name: 'second', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Loaded-page view', exact: true }).click()
    const view = page.getByRole('dialog', { name: 'Loaded-page view', exact: true })
    await view.getByRole('button', { name: 'Add loaded sort', exact: true }).click()
    await view.getByRole('button', { name: 'Add loaded sort', exact: true }).click()
    await view.getByLabel('Loaded sort 2 direction', { exact: true }).selectOption('desc')
    await view.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]').first()).toContainText('first')
    await page.getByRole('button', { name: 'Loaded-page view', exact: true }).click()
    await view.getByRole('button', { name: 'Add loaded filter', exact: true }).click()
    await view.getByLabel('Loaded filter 1 column', { exact: true }).selectOption('3')
    await view.getByLabel('Loaded filter 1 operator', { exact: true }).selectOption('is empty')
    await view.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(1)
    await expect(grid.getByRole('cell', { name: 'second', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Columns', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Result columns', exact: true })
    await manager.getByLabel('Search result columns', { exact: true }).fill('item')
    await expect(manager.getByLabel('Show item (column 2)', { exact: true })).toBeVisible()
    await expect(manager.getByLabel('Show item (column 3)', { exact: true })).toBeVisible()
    await manager.getByLabel('Show item (column 2)', { exact: true }).uncheck()
    await manager.getByLabel('Pin item (column 3)', { exact: true }).check()
    await manager.getByLabel('Width item (column 3)', { exact: true }).fill('240')
    await manager.getByRole('button', { name: 'Move item (column 3) left', exact: true }).click()
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(grid.locator('thead th').nth(2)).toContainText('item')
    await expect(grid.locator('thead th').nth(2)).toHaveCSS('width', '240px')
    await expect(grid.getByRole('cell', { name: '9', exact: true })).toHaveCount(0)
    await grid.getByRole('cell', { name: 'second', exact: true }).click()
    await page.locator('.grid-selection-bar').getByRole('button', { name: 'Copy', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Copy selected rows · JSON', exact: true }).click()
    await expect(page.getByText('Selected rows copied as JSON', { exact: true })).toBeVisible()
    const copied = JSON.parse(await desktop.evaluate(({ clipboard }) => clipboard.readText()))
    expect(copied.columns.map((column: { name: string }) => column.name)).toEqual([
      'item',
      'group_key',
      'text_value',
      'payload',
      'binary_value',
    ])
    expect(copied.rows[0][0]).toBe('second')
    await page.getByRole('button', { name: 'View complete payload value', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: 'Cell value · payload', exact: true })
    await viewer.getByLabel('Cell viewer format', { exact: true }).selectOption('json')
    await expect(viewer.getByLabel('Complete cell value', { exact: true })).toHaveText('{\n  "x": 2\n}')
    await viewer.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'View complete binary_value value', exact: true }).click()
    await page.getByLabel('Cell viewer format', { exact: true }).selectOption('hex')
    await expect(page.getByLabel('Complete cell value', { exact: true })).toHaveText('00 ff 0a')
    await page
      .getByRole('dialog', { name: 'Cell value · binary_value', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    const exportPath = join(userData, 'loaded-results.json')
    await desktop.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath }
      }
    }, exportPath)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Loaded results · JSON', exact: true }).click()
    await expect
      .poll(async () =>
        readFile(exportPath, 'utf8').then(
          (value) => JSON.parse(value).rows.length,
          () => 0,
        ),
      )
      .toBe(3)
    const exported = JSON.parse(await readFile(exportPath, 'utf8'))
    expect(exported.columns.map((column: { name: string }) => column.name)).toEqual([
      'group_key',
      'item',
      'item',
      'text_value',
      'payload',
      'binary_value',
    ])
    expect(exported.rows[1][3]).toBe(null)
    expect(exported.rows[0][3]).toBe('')
    expect(exported.scope).toBe('loaded results')
  } finally {
    if (desktop && clipboardBefore !== undefined)
      await desktop.evaluate(({ clipboard }, previous) => clipboard.writeText(previous), clipboardBefore)
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})

test('saved query metadata editing preserves SQL and target while history filters and retention remain explicit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-library-controls-'))
  let desktop: ElectronApplication | undefined
  try {
    const launched = await fixture(userData)
    desktop = launched.desktop
    const { page, profile } = launched
    const query = savedQuerySchema.parse({
      id: randomUUID(),
      name: 'Original report',
      engine: 'sqlite',
      connectionId: profile.id,
      schema: 'main',
      sql: 'SELECT :label;',
      parameterDefinitions: [{ name: 'label', type: 'text', secret: true }],
      updatedAt: new Date().toISOString(),
    })
    await page.evaluate((query) => window.harbor.saveQuery(query), query)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: /^Saved queries/ }).click()
    await page.getByRole('button', { name: 'Edit metadata for Original report', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Edit saved-query metadata', exact: true })
    await editor.getByLabel('Saved query name', { exact: true }).fill('Daily report')
    await editor.getByLabel('Saved query folder', { exact: true }).fill('Operations')
    await editor.getByLabel('Saved query tags', { exact: true }).fill('daily, safe, daily')
    await editor.getByRole('button', { name: 'Save metadata', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const saved = (await page.evaluate(() => window.harbor.bootstrap())).savedQueries.find(
      (item) => item.id === query.id,
    )!
    expect(saved).toMatchObject({
      ...query,
      name: 'Daily report',
      folder: 'Operations',
      tags: ['daily', 'safe'],
      updatedAt: expect.any(String),
    })
    await page.getByLabel('Query folder filter', { exact: true }).selectOption({ label: 'Operations' })
    await page.getByLabel('Query tag filter', { exact: true }).selectOption('daily')
    await expect(
      page.getByRole('button', { name: 'Open saved query Daily report without executing', exact: true }),
    ).toBeVisible()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT 1 AS id UNION ALL SELECT 2;')
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).history.length)
      .toBe(1)
    await typeSql(page, 'SELECT missing_column;')
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).history.length)
      .toBe(2)
    await page.getByRole('button', { name: /^History/ }).click()
    await page.getByLabel('History connection filter', { exact: true }).selectOption(profile.id)
    await page.getByLabel('History outcome filter', { exact: true }).selectOption('success')
    await page.getByLabel('Minimum loaded rows', { exact: true }).fill('2')
    await page.getByLabel('Maximum loaded rows', { exact: true }).fill('2')
    await page.getByLabel('Minimum duration (ms)', { exact: true }).fill('0')
    await page.getByLabel('Maximum duration (ms)', { exact: true }).fill('60000')
    const date = new Date().toLocaleDateString('sv-SE')
    await page.getByLabel('History after date', { exact: true }).fill(date)
    await page.getByLabel('History before date', { exact: true }).fill(date)
    await expect(page.locator('.library-row')).toHaveCount(1)
    await expect(page.locator('.library-row')).toContainText('SELECT 1 AS id')
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await page.getByLabel('History outcome filter', { exact: true }).selectOption('failed')
    await expect(page.locator('.library-row')).toHaveCount(1)
    await expect(page.locator('.library-row')).toContainText('missing_column')
    await page.getByText('History retention', { exact: true }).click()
    await page.getByLabel('History retention days', { exact: true }).fill('7')
    await page.getByRole('button', { name: 'Apply retention', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Shorten history retention?', exact: true })
      .getByRole('button', { name: 'Apply retention', exact: true })
      .click()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.settings.historyRetentionDays,
      )
      .toBe(7)
    await page.getByRole('button', { name: 'Clear history', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Clear query history?', exact: true })
      .getByRole('button', { name: 'Clear history', exact: true })
      .click()
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).history.length)
      .toBe(0)
    expect(
      (await page.evaluate(() => window.harbor.bootstrap())).savedQueries.find((item) => item.id === query.id)
        ?.sql,
    ).toBe(query.sql)
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
