import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForElectronWorkspace } from './electron-runtime'

test('Db2 profile exposes native prerequisites and the real child reports an absent driver without network credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-db2-offline-ui-'))
  let desktop: ElectronApplication | undefined
  try {
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
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const form = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(form, 'IBM Db2 LUW')
    await expect(form.getByTestId('db2-context')).toContainText('native runtime required')
    await form.getByTestId('db2-context').locator('summary').click()
    await expect(form.getByTestId('db2-context')).toContainText('511 declared bytes')
    await expect(form.getByText('Use a connection URL', { exact: true })).toHaveCount(0)
    await form.getByLabel('Connection name', { exact: true }).fill('Offline Db2')
    await form.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await form.getByLabel('Username', { exact: true }).fill('reader')
    await form.getByLabel('Database', { exact: true }).fill('HARBOR')
    await form.getByLabel('Schema', { exact: true }).fill('HARBOR_B_DB2')
    await page.screenshot({ path: resolve(root, 'work/db2-form.png'), fullPage: true })
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    const profile = await page.evaluate(async () =>
      (await window.harbor.bootstrap()).profiles.find((item) => item.name === 'Offline Db2'),
    )
    expect(profile).toMatchObject({
      engine: 'db2',
      port: 50000,
      database: 'HARBOR',
      schema: 'HARBOR_B_DB2',
      readOnly: true,
      autoReconnect: false,
      tls: { enabled: true, rejectUnauthorized: true },
    })
    if (!profile) throw new Error('Profile missing')
    const result = await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'offline-disposable-not-a-real-credential' },
        rememberPassword: false,
      })
      const status = await window.harbor.connect({ id: profile.id })
      const state = await window.harbor.bootstrap()
      await window.harbor.saveWorkspace({
        ...state.workspace,
        tabs: [
          {
            id: 'db2-offline-tab',
            connectionId: profile.id,
            database: profile.database,
            kind: 'query',
            title: 'Db2 review',
            sql: 'VALUES 1;',
          },
        ],
        activeTabId: 'db2-offline-tab',
      })
      return { status, history: state.history }
    }, profile)
    expect(result.status.state).toBe('failed')
    expect(result.status.error).toContain('Db2 native runtime unavailable')
    expect(result.status.error).not.toContain('offline-disposable')
    expect(result.history).toEqual([])
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page.getByTestId('db2-context')).toBeVisible()
    await page.getByTestId('db2-context').locator('summary').click()
    await page.screenshot({ path: resolve(root, 'work/db2-query.png'), fullPage: true })
    await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeDisabled()
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
