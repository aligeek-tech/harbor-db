import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

for (const engine of ['postgres', 'mariadb', 'redis'] as const) {
  test(`${engine} authentication feedback stays visible for Test and Save and connect`, async () => {
    test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated development databases.')
    const userData = await mkdtemp(join(tmpdir(), 'harbor-connection-feedback-'))
    const root = resolve(import.meta.dirname, '..')
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: `${engine} feedback fixture`,
      engine,
      host: '127.0.0.1',
      port: engine === 'postgres' ? 15432 : engine === 'mariadb' ? 13306 : 16379,
      username: engine === 'redis' ? '' : 'harbor',
      database: engine === 'redis' ? '' : 'harbor',
      readOnly: true,
    })
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
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await waitForElectronWorkspace(page)
      await expect(page).toHaveTitle('Harbor DB')
      expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/)
      await inspectElectronSandbox(desktop, page)
      await page.evaluate(async (profile) => {
        await window.harbor.saveProfile({
          profile,
          secrets: { password: 'harbor_test' },
          rememberPassword: false,
        })
      }, profile)
      await mkdir('/tmp/harbor-db-e2e', { recursive: true })
      for (const [theme, width, height] of [
        ['light', 1024, 700],
        ['dark', 1440, 900],
      ] as const) {
        await desktop.evaluate(
          ({ BrowserWindow }, { width, height }) => {
            BrowserWindow.getAllWindows()[0]!.setContentSize(width, height)
          },
          { width, height },
        )
        await page.evaluate(async (theme) => {
          const { workspace } = await window.harbor.bootstrap()
          await window.harbor.saveWorkspace({ ...workspace, settings: { ...workspace.settings, theme } })
        }, theme)
        await page.reload()
        await waitForElectronWorkspace(page)
        await page.getByRole('button', { name: `Actions for ${profile.name}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Edit connection', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true })
        const password = dialog.getByLabel('Password', { exact: true })
        // Keep the form longer than the viewport, as in the reported edit dialog.
        await dialog.getByText('Organization & connection preferences', { exact: true }).click()
        await password.fill('incorrect-fixture-password')
        for (const action of ['Test connection', 'Save and connect']) {
          await dialog.getByRole('button', { name: action, exact: true }).click()
          const feedback = dialog.getByRole('alert')
          await expect(feedback).toContainText(/password|authentication|access denied|WRONGPASS/i)
          await page.screenshot({
            path: `/tmp/harbor-db-e2e/connection-${engine}-${theme}-${action === 'Test connection' ? 'test' : 'save'}.png`,
          })
          await expect(feedback).toBeInViewport({ ratio: 1 })
          await expect(feedback).not.toContainText('incorrect-fixture-password')
          await expect(feedback).not.toContainText('SQL character')
          await expect(dialog).toBeVisible()
          await expect(dialog.getByRole('button', { name: action, exact: true })).toBeEnabled()
        }
        expect((await page.evaluate(() => window.harbor.bootstrap())).profiles).toHaveLength(1)
        expect((await page.evaluate((id) => window.harbor.status(id), profile.id)).state).toBe('failed')
        await password.fill('harbor_test')
        await expect(dialog.getByRole('alert')).toHaveCount(0)
        await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
        await expect(dialog.getByRole('status')).toContainText('Connection successful')
        await expect(dialog.getByRole('status')).toBeInViewport({ ratio: 1 })
        await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
      }
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)
      expect(errors).toEqual([])
    } finally {
      try {
        if (desktop) await desktop.close()
      } finally {
        await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  })
}
