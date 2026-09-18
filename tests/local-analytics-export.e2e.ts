import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

const root = resolve(import.meta.dirname, '..')
async function launch(userData: string, profile: ConnectionProfile) {
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
    await page.evaluate(
      async (profile) =>
        window.harbor.saveProfile({ profile, secrets: { password: 'harbor_test' }, rememberPassword: false }),
      profile,
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect
      .poll(() => page.evaluate((id) => window.harbor.status(id), profile.id))
      .toMatchObject({ state: 'connected' })
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    return { desktop, page }
  } catch (error) {
    await desktop.close()
    throw error
  }
}
test('DuckDB native file grant previews and transactionally imports CSV then queries exact rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-analytics-desktop-'))
  let desktop: ElectronApplication | undefined
  try {
    const csv = join(directory, 'exact.csv')
    await writeFile(csv, 'id,label\n9007199254740993,precise\n2,second\n')
    const profile = profileSchema.parse({
      id: 'analytics-memory',
      name: 'Local analytical scratchpad',
      engine: 'duckdb',
      host: '127.0.0.1',
      port: 1,
      schema: 'main',
      readOnly: false,
      duckdb: { path: '', mode: 'memory' },
    })
    const fixture = await launch(directory, profile)
    desktop = fixture.desktop
    const page = fixture.page
    await page.getByRole('button', { name: 'Explore local file', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Explore a local data file', exact: true })
    await expect(dialog).toContainText('No network access or extension download')
    await desktop.evaluate(({ dialog }, filePath) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: [filePath] }
      }
    }, csv)
    await dialog.getByRole('button', { name: 'Choose data file…', exact: true }).click()
    await dialog.getByRole('button', { name: 'Preview first 200 rows', exact: true }).click()
    await expect(dialog.getByRole('cell', { name: '9007199254740993', exact: true })).toBeVisible()
    await expect(dialog.getByRole('cell', { name: 'precise', exact: true })).toBeVisible()
    await dialog.getByLabel('New table in main', { exact: true }).fill('imported_exact')
    await dialog.getByRole('button', { name: 'Review full import', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Import this local file?', exact: true })
    await confirmation.getByRole('textbox').fill('main.imported_exact')
    await confirmation.getByRole('button', { name: 'Create table and import', exact: true }).click()
    await expect(dialog).toContainText('Committed 2 rows to main.imported_exact.')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await typeSql(page, 'SELECT id, label FROM main.imported_exact ORDER BY id DESC;')
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: '9007199254740993', exact: true }),
    ).toBeVisible()
    await typeSql(page, "SELECT * FROM read_csv('/etc/passwd');")
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(page.locator('.error-panel[role=alert]')).toContainText(/external|disabled|access|permission/i)
    const saved = await page.evaluate(() => window.harbor.bootstrap())
    expect(saved.profiles[0].autoReconnect).toBe(false)
    expect(await readFile(csv, 'utf8')).toBe('id,label\n9007199254740993,precise\n2,second\n')
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('full export uses reviewed native query output beyond loaded rows and supports cancellation', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires disposable PostgreSQL fixture.')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-full-export-desktop-'))
  let desktop: ElectronApplication | undefined
  try {
    const profile = profileSchema.parse({
      id: 'full-export',
      name: 'Disposable full export',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'harbor',
      database: 'harbor',
      schema: 'public',
      readOnly: true,
    })
    const fixture = await launch(directory, profile)
    desktop = fixture.desktop
    const page = fixture.page
    await typeSql(
      page,
      'SELECT i::bigint AS duplicate, (9007199254740993::bigint+i)::text AS duplicate FROM generate_series(1,5000) AS i;',
    )
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(page.getByText('1,000 rows', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Full query export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export a full query result', exact: true })
    await expect(dialog).toContainText('excludes this tab’s uncommitted changes')
    const output = join(directory, 'full.jsonl')
    await desktop.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath }
      }
    }, output)
    await dialog
      .getByRole('button', { name: 'Review accepted · choose new file and export', exact: true })
      .click()
    await expect(dialog.getByRole('status')).toContainText('completed · 5,000 rows')
    const lines = (await readFile(output, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(5001)
    expect(JSON.parse(lines[0]).columns.map((column: { name: string }) => column.name)).toEqual([
      'duplicate',
      'duplicate',
    ])
    expect(JSON.parse(lines[1])).toEqual(['1', '9007199254740994'])
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
    await typeSql(page, 'SELECT pg_sleep(0.02), i FROM generate_series(1,10000) AS i;')
    await page.getByRole('button', { name: 'Full query export', exact: true }).click()
    const partial = join(directory, 'cancelled.jsonl')
    await desktop.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath }
      }
    }, partial)
    await dialog
      .getByRole('button', { name: 'Review accepted · choose new file and export', exact: true })
      .click()
    await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('cancelled')
    await expect(readFile(partial)).rejects.toThrow()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(1)
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
