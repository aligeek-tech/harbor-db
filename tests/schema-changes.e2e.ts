import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('visual schema changes require exact review, show real rollback, create constraints and open an inert comparison draft', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-schema-ui-')),
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
      env: { ...env, HARBOR_USER_DATA: userData },
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Schema UI fixture',
      engine: 'sqlite',
      host: 'local',
      port: 1,
      schema: 'main',
      sqlite: { path: join(userData, 'data.sqlite'), mode: 'create' },
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
          maxRows: 20,
          privateSession: true,
          sql: 'CREATE TABLE records(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO records VALUES(1,7),(2,7); CREATE TABLE desired(id INTEGER PRIMARY KEY,value TEXT,extra INTEGER); CREATE VIEW records_view AS SELECT id,value FROM records',
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, profile)
    const secondary = {
      ...profile,
      id: randomUUID(),
      name: 'Schema comparison target',
      sqlite: { ...profile.sqlite, path: join(userData, 'target.sqlite') },
    }
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.connect({ id: profile.id })
      const sessionId = crypto.randomUUID()
      try {
        await window.harbor.query({
          connectionId: profile.id,
          sessionId,
          requestId: crypto.randomUUID(),
          maxRows: 20,
          privateSession: true,
          sql: 'CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT,only_target INTEGER); CREATE VIEW records_view AS SELECT id FROM records',
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, secondary)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: secondary.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${secondary.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Collapse ${secondary.name}`, exact: true }).click()
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page
      .getByRole('button', { name: /^Actions for (?:main\.)?main\.records$/ })
      .click()
    await page.getByRole('menuitem', { name: 'Inspect structure', exact: true }).click()
    const inspector = page.getByRole('dialog', { name: /^(?:main\.)?main\.records$/ })
    await inspector.getByRole('button', { name: 'Review schema changes', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Review schema changes', exact: true })
    await dialog.getByLabel('Schema column 1 name', { exact: true }).fill('added')
    await dialog.getByLabel('Schema column 1 type', { exact: true }).selectOption('integer')
    await dialog.getByRole('button', { name: 'Preview schema change', exact: true }).click()
    const preview = dialog.getByRole('region', { name: 'Schema change preview', exact: true })
    await expect(preview).toContainText('ADD COLUMN "added" INTEGER')
    const execute = dialog.getByRole('button', { name: 'Execute reviewed schema change', exact: true })
    await expect(execute).toBeDisabled()
    await dialog.getByLabel('Schema execution confirmation', { exact: true }).fill('wrong')
    await expect(execute).toBeDisabled()
    const confirmation = await preview.locator('label strong').innerText()
    await dialog.getByLabel('Schema execution confirmation', { exact: true }).fill(confirmation)
    await execute.click()
    await expect(dialog.getByRole('region', { name: 'Schema execution result', exact: true })).toContainText(
      'Schema outcome: committed',
    )
    const target = { connectionId: profile.id, schema: 'main', table: 'records' }
    expect(
      (await page.evaluate((target) => window.harbor.structure(target), target)).columns.map(
        (column) => column.name,
      ),
    ).toContain('added')
    // Duplicate unique index fails against the actual database and shows a confirmed rollback.
    await dialog.getByLabel('Schema operation', { exact: true }).selectOption('create-index')
    await dialog.getByLabel('Schema new name', { exact: true }).fill('value_unique')
    await dialog.getByLabel('Schema index columns', { exact: true }).fill('value')
    await dialog.getByRole('checkbox', { name: 'Unique', exact: true }).check()
    await dialog.getByRole('button', { name: 'Preview schema change', exact: true }).click()
    await dialog
      .getByLabel('Schema execution confirmation', { exact: true })
      .fill(await preview.locator('label strong').innerText())
    await execute.click()
    await expect(dialog.getByRole('region', { name: 'Schema execution result', exact: true })).toContainText(
      'Schema outcome: rolled-back',
    )
    // A visual create-table request includes a real explicit primary key.
    await dialog.getByLabel('Schema operation', { exact: true }).selectOption('create-table')
    await dialog.getByLabel('New schema table name', { exact: true }).fill('created_visually')
    await dialog.getByRole('button', { name: 'Preview schema change', exact: true }).click()
    await expect(preview).toContainText('PRIMARY KEY ("id")')
    await dialog
      .getByLabel('Schema execution confirmation', { exact: true })
      .fill(await preview.locator('label strong').innerText())
    await execute.click()
    await expect(dialog.getByRole('region', { name: 'Schema execution result', exact: true })).toContainText(
      'Schema outcome: committed',
    )
    expect(
      (
        await page.evaluate(
          (target) => window.harbor.structure({ ...target, table: 'created_visually' }),
          target,
        )
      ).columns[0].primaryKey,
    ).toBe(true)
    await dialog.getByRole('button', { name: 'Back to inspector', exact: true }).click()
    await inspector.getByRole('button', { name: 'Compare table schemas', exact: true }).click()
    const compare = page.getByRole('dialog', { name: 'Compare table schemas', exact: true })
    await compare.getByLabel('Schema comparison connection', { exact: true }).selectOption(secondary.id)
    await compare.getByRole('button', { name: 'Load scoped comparison catalogs', exact: true }).click()
    await compare.getByRole('checkbox', { name: 'Compare table records', exact: true }).check()
    await compare.getByRole('checkbox', { name: 'Compare view records_view', exact: true }).check()
    await compare.getByRole('button', { name: 'Compare selected schema objects', exact: true }).click()
    await expect(
      compare.getByRole('region', { name: 'Schema comparison result', exact: true }),
    ).toContainText('view records_view → records_view')
    await expect(
      compare.getByRole('region', { name: 'Schema comparison result', exact: true }),
    ).toContainText('Manual definition/dependency review required')
    expect(
      (
        await page.evaluate(
          (id) => window.harbor.structure({ connectionId: id, schema: 'main', table: 'records' }),
          secondary.id,
        )
      ).columns.map((column) => column.name),
    ).toEqual(['id', 'value', 'only_target'])
    await compare.getByRole('button', { name: 'Use table pair', exact: true }).click()
    await compare.getByLabel('Schema comparison connection', { exact: true }).selectOption(profile.id)
    await compare.getByLabel('Schema comparison table', { exact: true }).fill('desired')
    await compare.getByRole('button', { name: 'Compare selected tables', exact: true }).click()
    await expect(
      compare.getByRole('region', { name: 'Schema comparison result', exact: true }),
    ).toContainText('Manual review required')
    const before = await page.evaluate(
      (target) => window.harbor.structure({ ...target, table: 'desired' }),
      target,
    )
    await compare.getByRole('button', { name: 'Open inert migration draft', exact: true }).click()
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.some(
          (tab) => tab.title === 'Migration draft: desired' && tab.sql?.includes('INERT MIGRATION DRAFT'),
        ),
      )
      .toBe(true)
    expect(
      await page.evaluate((target) => window.harbor.structure({ ...target, table: 'desired' }), target),
    ).toEqual(before)
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
