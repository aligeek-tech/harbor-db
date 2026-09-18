import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('declared composite foreign keys open real rows, traverse references, return to snapshots and refuse NULL tuples', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-related-records-'))
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
      name: 'Related-record fixture',
      engine: 'sqlite',
      host: '127.0.0.1',
      port: 1,
      username: '',
      schema: 'main',
      sqlite: { path: join(userData, 'relations.sqlite3'), mode: 'create' },
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
          sql: `CREATE TABLE regions (id INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE customers (tenant_id INTEGER, id INTEGER, region_id INTEGER REFERENCES regions(id), title TEXT, PRIMARY KEY (tenant_id,id), UNIQUE(id,tenant_id));
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, tenant_id INTEGER, FOREIGN KEY(customer_id,tenant_id) REFERENCES customers(id,tenant_id));
INSERT INTO regions VALUES(1,'Western region'); INSERT INTO customers VALUES(7,3,1,'Composite related customer'); INSERT INTO orders VALUES(1,3,7),(2,NULL,7);`,
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'orders', exact: true }).click()
    const sourceGrid = page.locator('.table-scroll:visible')
    await expect(sourceGrid.getByRole('checkbox', { name: 'Select row 1', exact: true })).toBeVisible()
    await sourceGrid.getByRole('checkbox', { name: 'Select row 1', exact: true }).check()
    const retainedBefore = (await page.evaluate(() => window.harbor.bootstrap())).history.length
    await page.getByRole('button', { name: 'Related records', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Related records', exact: true })
    await expect(dialog.getByLabel('Declared foreign keys', { exact: true })).toContainText(
      '(customer_id, tenant_id)',
    )
    await dialog.getByRole('button', { name: /^Open referenced rows/ }).click()
    await expect(dialog.getByRole('cell', { name: 'Composite related customer', exact: true })).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Select row 1', exact: true }).check()
    await dialog.getByRole('button', { name: /^Open referenced rows/ }).click()
    await expect(dialog.getByRole('cell', { name: 'Western region', exact: true })).toBeVisible()
    await expect(dialog.getByLabel('Related record breadcrumbs', { exact: true })).toContainText(
      'main.orders',
    )
    await expect(dialog.getByLabel('Related record breadcrumbs', { exact: true })).toContainText(
      'main.customers',
    )
    await expect(dialog.getByLabel('Related record breadcrumbs', { exact: true })).toContainText(
      'main.regions',
    )
    await dialog.getByRole('button', { name: 'Back to previous rows', exact: true }).click()
    await expect(dialog.getByRole('cell', { name: 'Composite related customer', exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Select row 1', exact: true })).toBeChecked()
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(retainedBefore)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await sourceGrid.getByRole('checkbox', { name: 'Select row 1', exact: true }).uncheck()
    await sourceGrid.getByRole('checkbox', { name: 'Select row 2', exact: true }).check()
    await page.getByRole('button', { name: 'Related records', exact: true }).click()
    await expect(
      dialog.getByText('A foreign-key value is NULL; this row has no referenced tuple.', { exact: true }),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Open referenced rows/ })).toBeDisabled()
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
