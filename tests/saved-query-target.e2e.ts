import { _electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('unbound saved queries require a compatible explicit target without execution', async () => {
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-query-target-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
  ))
  const desktop = await _electron.launch({ chromiumSandbox: true, args: [root], cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData }, timeout: 30000 })
  try {
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profiles = [
      profileSchema.parse({ id: 'wrong-redis', name: 'Unrelated Redis', engine: 'redis', host: '127.0.0.1', port: 1 }),
      profileSchema.parse({ id: 'chosen-pg', name: 'Chosen PostgreSQL', engine: 'postgres', host: '127.0.0.1', port: 1, database: 'safe_local', schema: 'public' }),
    ]
    await page.evaluate(async (profiles) => {
      for (const profile of profiles) await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.saveQuery({ id: 'unbound', name: 'Unbound SQL', engine: 'postgres',
        sql: 'SELECT 9007199254740993::bigint;', database: 'safe_local', folder: '', tags: [], updatedAt: new Date().toISOString() })
    }, profiles)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: /^Saved queries/ }).click()
    await page.getByRole('button', { name: 'Open saved query Unbound SQL without executing', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose query target', exact: true })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: /Unrelated Redis/ })).toBeDisabled()
    await expect(picker).toContainText('Requires PostgreSQL')
    await picker.getByRole('button', { name: /Chosen PostgreSQL/ }).click()
    await expect(picker).toHaveCount(0)
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.harbor.bootstrap())
      return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
    }).toMatchObject({ connectionId: 'chosen-pg', database: 'safe_local', kind: 'query', sql: 'SELECT 9007199254740993::bigint;' })
    const result = await page.evaluate(() => window.harbor.bootstrap())
    expect(result.history).toHaveLength(0)
    expect(await page.evaluate(() => window.harbor.status('chosen-pg'))).toMatchObject({ state: 'disconnected' })
  } finally {
    await desktop.close()
    await rm(userData, { recursive: true, force: true })
  }
})
