import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
test('same-engine target choice, cancelled choice, deleted binding and no eligible target preserve explicit execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-target-safety-')),
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
    const profiles = ['A', 'B', 'Deleted'].map((name) =>
      profileSchema.parse({
        id: 'target-' + name,
        name: 'Target ' + name,
        engine: 'sqlite',
        host: 'local',
        port: 1,
        schema: 'main',
        readOnly: false,
        sqlite: { path: join(directory, name + '.sqlite'), mode: 'create' },
      }),
    )
    await page.evaluate(async (profiles) => {
      for (const profile of profiles) {
        await window.harbor.saveProfile({ profile, rememberPassword: false })
        if (profile.id === 'target-Deleted') continue
        await window.harbor.connect({ id: profile.id })
        const sessionId = crypto.randomUUID()
        await window.harbor.query({
          connectionId: profile.id,
          sessionId,
          requestId: crypto.randomUUID(),
          sql: `CREATE TABLE identity(value TEXT);INSERT INTO identity VALUES('${profile.id}')`,
          maxRows: 1,
          privateSession: true,
        })
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
        await window.harbor.disconnect(profile.id)
      }
      const common = {
        engine: 'sqlite' as const,
        sql: 'SELECT value FROM identity;',
        schema: 'main',
        folder: '',
        tags: [],
        updatedAt: new Date().toISOString(),
      }
      await window.harbor.saveQuery({ ...common, id: 'unbound', name: 'Explicit target query' })
      await window.harbor.saveQuery({
        ...common,
        id: 'deleted',
        name: 'Deleted binding query',
        connectionId: 'target-Deleted',
      })
      await window.harbor.deleteProfile('target-Deleted')
    }, profiles)
    await page.reload()
    await waitForElectronWorkspace(page)
    const openLibrary = async () => page.getByRole('button', { name: /^Saved queries/ }).click()
    await openLibrary()
    await page
      .getByRole('button', { name: 'Open saved query Explicit target query without executing', exact: true })
      .click()
    const picker = page.getByRole('dialog', { name: 'Choose query target', exact: true })
    await expect(picker.getByRole('button', { name: /Target A/ })).toBeEnabled()
    await expect(picker.getByRole('button', { name: /Target B/ })).toBeEnabled()
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs).toHaveLength(0)
    await page
      .getByRole('button', { name: 'Open saved query Explicit target query without executing', exact: true })
      .click()
    await picker.getByRole('button', { name: /Target B/ }).click()
    await expect
      .poll(
        async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.at(0)?.connectionId,
      )
      .toBe('target-B')
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    expect(await page.evaluate(() => window.harbor.status('target-B'))).toMatchObject({
      state: 'disconnected',
    })
    await page.getByRole('button', { name: 'Target B', exact: true }).dblclick()
    await expect(page.getByLabel('Target B: connected', { exact: true })).toBeVisible()
    await page.locator('.monaco-editor:visible textarea').focus()
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'target-B', exact: true }),
    ).toBeVisible()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'target-A', exact: true }),
    ).toHaveCount(0)
    await openLibrary()
    await page
      .getByRole('button', { name: 'Open saved query Deleted binding query without executing', exact: true })
      .click()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(async () => {
      await window.harbor.deleteProfile('target-A')
      await window.harbor.deleteProfile('target-B')
    })
    await page.reload()
    await waitForElectronWorkspace(page)
    await openLibrary()
    await page
      .getByRole('button', { name: 'Open saved query Explicit target query without executing', exact: true })
      .click()
    await expect(
      picker.getByText('No compatible connection. Add one, then open this query again.', { exact: true }),
    ).toBeVisible()
    expect((await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs).toHaveLength(0)
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
