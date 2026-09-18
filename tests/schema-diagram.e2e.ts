import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('inspects bounded foreign-key neighborhoods from real SQLite catalogs and exports passive local SVG', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-diagram-ui-')),
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
      id: 'diagram-fixture',
      name: 'Diagram fixture',
      engine: 'sqlite',
      host: 'local',
      port: 1,
      schema: 'main',
      readOnly: false,
      sqlite: { path: join(directory, 'fixture.sqlite'), mode: 'create' },
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
          privateSession: true,
          maxRows: 200,
          sql:
            'CREATE TABLE parent(tenant INTEGER,id INTEGER,PRIMARY KEY(tenant,id)); CREATE TABLE child(id INTEGER PRIMARY KEY,tenant INTEGER,parent_id INTEGER,FOREIGN KEY(tenant,parent_id) REFERENCES parent(tenant,id));' +
            Array.from({ length: 42 }, (_, i) => `CREATE TABLE filler_${i}(id INTEGER PRIMARY KEY)`).join(
              ';',
            ),
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'child', exact: true }).click()
    await page.getByRole('button', { name: 'Schema diagram', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Schema relationships', exact: true })
    await expect(dialog.getByRole('button', { name: 'Inspect next 20 tables', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Inspect next 20 tables', exact: true }).click()
    await expect(dialog.getByText(/20\/200 inspected/)).toBeVisible()
    await expect(dialog.getByRole('img')).toHaveJSProperty('naturalWidth', 1440)
    await dialog
      .getByLabel('Focused relationship neighborhood', { exact: true })
      .selectOption({ label: 'main.child' })
    await expect(dialog.getByRole('img')).toHaveAttribute('alt', /2 tables and 1 inspected constraints/)
    await dialog.locator('summary').click()
    await expect(dialog.getByRole('table')).toContainText('tenant, parent_id')
    await expect(dialog.getByRole('table')).toContainText('tenant, id')
    const path = join(directory, 'diagram.svg')
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, path)
    await dialog.getByRole('button', { name: 'Export diagram SVG', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('Saved local SVG')
    const svg = await readFile(path, 'utf8')
    expect(svg).toContain('main.child')
    expect(svg).toContain('main.parent')
    expect(svg).not.toContain('filler_')
    await dialog.getByRole('button', { name: 'Export diagram SVG', exact: true }).click()
    await expect(dialog.getByText(/EEXIST/)).toBeVisible()
    expect(await readFile(path, 'utf8')).toBe(svg)
    await dialog.getByRole('button', { name: 'Clear diagram', exact: true }).click()
    await dialog.getByLabel('Find diagram tables', { exact: true }).fill('parent')
    await dialog.getByRole('button', { name: 'Inspect next 1 tables', exact: true }).click()
    await expect(dialog.getByRole('img')).toHaveAttribute('alt', /1 tables and 0 inspected constraints/)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
