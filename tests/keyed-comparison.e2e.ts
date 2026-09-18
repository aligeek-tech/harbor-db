import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
test('compares explicitly mapped keys in real query results without executing more SQL or hiding duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-keyed-ui-')),
    root = resolve(import.meta.dirname, '..')
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
      env: { ...env, HARBOR_USER_DATA: directory },
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: 'keyed-fixture',
      name: 'Keyed comparison fixture',
      engine: 'sqlite',
      host: 'local',
      port: 1,
      schema: 'main',
      readOnly: false,
      sqlite: { path: join(directory, 'fixture.db'), mode: 'create' },
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.connect({ id: profile.id })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(
      page,
      "SELECT 'a' AS id,NULL AS label UNION ALL SELECT 'dup','x' UNION ALL SELECT 'dup','y'; SELECT 'a' AS id,'' AS label UNION ALL SELECT 'right','z';",
    )
    await page.keyboard.press(shortcutKeys('run-script', shortcutPlatform(process.platform)))
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'a', exact: true }),
    ).toBeVisible()
    const before = await page.evaluate(() => window.harbor.bootstrap())
    await page.getByRole('button', { name: 'Compare loaded results', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Compare loaded results', exact: true })
    await dialog.getByLabel('Comparison method', { exact: true }).selectOption('keys')
    const compare = dialog.getByRole('button', { name: 'Compare selected keys', exact: true })
    await expect(compare).toBeDisabled()
    await dialog.getByLabel('Key column 1', { exact: true }).check()
    await compare.click()
    await expect(dialog.getByRole('status')).toContainText(
      '1 changed · 0 left only · 1 right only · 1 duplicate key groups',
    )
    await expect(dialog.getByRole('cell', { name: 'duplicate', exact: true })).toBeVisible()
    await dialog.getByLabel('Comparison row limit', { exact: true }).fill('1')
    await compare.click()
    await expect(dialog.getByText(/Comparison is partial:/)).toBeVisible()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toEqual(before.history)
    await page.screenshot({ path: test.info().outputPath('keyed-comparison.png') })
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
