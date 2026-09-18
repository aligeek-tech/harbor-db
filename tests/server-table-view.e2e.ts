import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('server filter builder and sort priorities fetch real matching pages and keep SQL and pending guards aligned', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-server-view-'))
  const root = resolve(import.meta.dirname, '..')
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
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Server view fixture',
      engine: 'sqlite',
      host: '127.0.0.1',
      port: 1,
      username: '',
      schema: 'main',
      sqlite: { path: join(userData, 'data.sqlite3'), mode: 'create' },
      readOnly: false,
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.connect({ id: profile.id })
      const sessionId = crypto.randomUUID()
      try {
        await window.harbor.query({
          connectionId: profile.id,
          sessionId,
          requestId: crypto.randomUUID(),
          maxRows: 200,
          privateSession: true,
          sql: `CREATE TABLE records(id INTEGER PRIMARY KEY, bucket TEXT, quantity INTEGER, label TEXT);
INSERT INTO records VALUES(1,'A',10,NULL),(2,'A',20,''),(3,'B',30,'literal%_'),(4,'B',20,'other'),(5,'A',20,'last');`,
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'records', exact: true }).click()
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(5)
    await page.getByRole('button', { name: 'Server view', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Filter and sort table on server', exact: true })
    await dialog.getByRole('button', { name: 'Add server filter', exact: true }).click()
    await dialog.getByLabel('Server filter 1 column', { exact: true }).selectOption('quantity')
    await dialog.getByLabel('Server filter 1 operator', { exact: true }).selectOption('greater than')
    await dialog.getByLabel('Server filter 1 value', { exact: true }).fill('10')
    await dialog.getByRole('button', { name: 'Add server filter', exact: true }).click()
    await dialog.getByLabel('Server filter 2 column', { exact: true }).selectOption('label')
    await dialog.getByLabel('Server filter 2 operator', { exact: true }).selectOption('is not null')
    await dialog.getByRole('button', { name: 'Add server sort', exact: true }).click()
    await dialog.getByLabel('Server sort 1 column', { exact: true }).selectOption('bucket')
    await dialog.getByRole('button', { name: 'Add server sort', exact: true }).click()
    await dialog.getByLabel('Server sort 2 column', { exact: true }).selectOption('quantity')
    await dialog.getByLabel('Server sort 2 direction', { exact: true }).selectOption('desc')
    await dialog.getByRole('button', { name: 'Apply server view', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(4)
    await expect(grid.locator('tbody tr[aria-rowindex]').first().locator('td').nth(2)).toHaveText('2')
    const draft = async () =>
      (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
        (tab) => tab.table === 'records',
      )?.sql || ''
    await expect.poll(draft).toMatch(/"quantity" > '10'.*AND.*"label" IS NOT NULL/s)
    await expect.poll(draft).toMatch(/ORDER BY "bucket" ASC, "quantity" DESC, "id" ASC/)

    await expect
      .poll(async () =>
        grid.evaluate((element) => {
          const header = element.querySelector('thead')!.getBoundingClientRect().height
          return element.getBoundingClientRect().height - 2 * header
        }),
      )
      .toBeGreaterThanOrEqual(31)
    await grid.getByRole('cell', { name: 'last', exact: true }).dblclick()
    const edit = page.getByRole('dialog', { name: 'Edit label', exact: true })
    await edit.getByLabel('Cell value', { exact: true }).fill('staged last')
    await edit.getByRole('button', { name: 'Stage change', exact: true }).click()
    await page.getByRole('button', { name: 'Server view', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(
      page.getByText('Apply or discard staged changes before changing the table view.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Discard', exact: true }).click()

    await page.getByRole('button', { name: 'Server view', exact: true }).click()
    await dialog.getByLabel('Server filter match', { exact: true }).selectOption('any')
    await dialog.getByLabel('Server filter 1 column', { exact: true }).selectOption('bucket')
    await dialog.getByLabel('Server filter 1 operator', { exact: true }).selectOption('equals')
    await dialog.getByLabel('Server filter 1 value', { exact: true }).fill('A')
    await dialog.getByLabel('Server filter 2 operator', { exact: true }).selectOption('contains')
    await dialog.getByLabel('Server filter 2 value', { exact: true }).fill('%_')
    await dialog.getByRole('button', { name: 'Apply server view', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(4)
    await expect(grid.getByRole('cell', { name: 'literal%_', exact: true })).toBeVisible()
    await expect(grid.getByRole('cell', { name: 'other', exact: true })).toHaveCount(0)
    await expect.poll(draft).toContain(' OR ')
    await page.getByRole('button', { name: 'Clear server view', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]')).toHaveCount(5)
    await expect.poll(draft).not.toContain('WHERE')
    await grid.getByRole('button', { name: 'Sort quantity descending', exact: true }).click()
    await expect.poll(draft).toContain('ORDER BY "quantity" DESC')
    await expect.poll(draft).not.toContain('"bucket" ASC')
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
