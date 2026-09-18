import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

for (const engine of ['postgres', 'mariadb'] as const) test(`${engine}: typed private parameters use actual editor and survive only as definitions`, async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the disposable SQL fixture.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-parameters-ui-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
  ))
  const desktop = await _electron.launch({ chromiumSandbox: true, args: [root], cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData } })
  try {
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({ id: `parameters-${engine}`, name: `Parameters ${engine}`, engine, host: '127.0.0.1',
      port: engine === 'postgres' ? 15432 : 13306, username: 'harbor', database: 'harbor', readOnly: true })
    await page.evaluate(async (profile) => window.harbor.saveProfile({ profile, secrets: { password: 'harbor_test' }, rememberPassword: false }), profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const statement = engine === 'postgres' ? 'SELECT $1::bigint AS precise, $2::text AS text;' : 'SELECT CAST(? AS SIGNED) AS precise, ? AS text;'
    await typeSql(page, statement)
    await page.getByText('Parameters (0)', { exact: true }).click()
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Parameter 1 type', { exact: true }).selectOption('integer')
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Private', { exact: true }).nth(1).check()
    await page.getByLabel('Parameter 1 value', { exact: true }).fill('9007199254740993')
    await page.getByLabel('Parameter 2 value', { exact: true }).fill('local-private-parameter')
    await page.locator('.editor-region:visible').getByRole('button', { name: /^Run (?:Command|Ctrl)\+Enter/ }).click()
    await expect(page.locator('.table-scroll:visible').getByRole('cell', { name: '9007199254740993', exact: true })).toBeVisible()
    await expect(page.locator('.table-scroll:visible').getByRole('cell', { name: 'local-private-parameter', exact: true })).toBeVisible()
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.harbor.bootstrap())
      return state.workspace.tabs.find((t) => t.id === state.workspace.activeTabId)?.parameterDefinitions?.length
    }).toBe(2)
    const persisted = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(persisted)).not.toContain('local-private-parameter')
    expect(persisted.history.at(0)?.sql).toBe(statement)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByText('Parameters (2)', { exact: true }).click()
    await expect(page.getByLabel('Parameter 2 value', { exact: true })).toHaveValue('')
    await expect(page.getByRole('heading', { name: 'Ready when you are', exact: true })).toBeVisible()
  } finally { await desktop.close(); await rm(userData, { recursive: true, force: true }) }
})
