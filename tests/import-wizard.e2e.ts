import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { importTargetConfirmation } from '../src/shared/imports'
import { waitForElectronWorkspace } from './electron-runtime'

test('reviewed JSONL import commits multiple native batches, preserves exact values and reports a rejected later batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-import-ui-'))
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
    const profile = profileSchema.parse({
      id: 'import-fixture',
      name: 'Isolated import fixture',
      engine: 'sqlite',
      host: '127.0.0.1',
      port: 1,
      schema: 'main',
      readOnly: false,
      sqlite: { path: join(directory, 'import.sqlite3'), mode: 'create' },
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.connect({ id: profile.id })
      await window.harbor.query({
        connectionId: profile.id,
        sessionId: 'setup',
        requestId: crypto.randomUUID(),
        sql: 'CREATE TABLE records(id INTEGER PRIMARY KEY, exact_value TEXT NOT NULL, label TEXT)',
        maxRows: 1,
        privateSession: true,
      })
      await window.harbor.closeSession({ connectionId: profile.id, sessionId: 'setup' })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await page.getByRole('button', { name: 'records', exact: true }).click()
    await page.getByRole('button', { name: 'Import file…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import file into table', exact: true })
    await dialog.getByLabel('Import format', { exact: true }).selectOption('jsonl')
    const file = join(directory, 'exact.jsonl')
    await writeFile(
      file,
      Array.from(
        { length: 251 },
        (_, index) =>
          `{"id":${index + 1},"exact_value":9007199254740993,"label":${index === 0 ? 'null' : '""'}}`,
      ).join('\n') + '\n',
    )
    await desktop.evaluate(({ dialog }, file) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: [file] }
      }
    }, file)
    await dialog.getByRole('button', { name: 'Choose and preview file…', exact: true }).click()
    await expect(dialog.getByRole('cell', { name: '9007199254740993', exact: true })).toHaveCount(20)
    await dialog.getByLabel('Conversion for source 1', { exact: true }).selectOption('integer')
    const start = dialog.getByRole('button', { name: 'Start reviewed import', exact: true })
    await expect(start).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /each batch commits separately/ }).check()
    await dialog
      .getByLabel('Confirm import target', { exact: true })
      .fill(importTargetConfirmation({ connectionId: profile.id, schema: 'main', table: 'records' }))
    await start.click()
    await expect(dialog.getByRole('status')).toContainText('Import completed')
    await expect(dialog.getByRole('definition').nth(0)).toHaveText('251')
    const retained = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(retained)).not.toContain('9007199254740993')
    const result = await page.evaluate(async () => {
      const result = await window.harbor.query({
        connectionId: 'import-fixture',
        sessionId: 'verify',
        requestId: crypto.randomUUID(),
        sql: "SELECT COUNT(*), MIN(exact_value), SUM(label IS NULL), SUM(label='') FROM records",
        maxRows: 1,
        privateSession: true,
      })
      await window.harbor.closeSession({ connectionId: 'import-fixture', sessionId: 'verify' })
      return result.sets[0].rows
    })
    expect(result).toEqual([['251', '9007199254740993', '1', '250']])
    await dialog.getByRole('button', { name: 'Close and reload table', exact: true }).click()
    await page.getByRole('button', { name: 'Import file…', exact: true }).click()
    await dialog.getByLabel('Import format', { exact: true }).selectOption('jsonl')
    const failing = join(directory, 'later-conflict.jsonl')
    await writeFile(
      failing,
      '{"id":500,"exact_value":"first"}\n{"id":501,"exact_value":"second"}\n{"id":500,"exact_value":"duplicate"}\n',
    )
    await desktop.evaluate(({ dialog }, file) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: [file] }
      }
    }, failing)
    await dialog.getByRole('button', { name: 'Choose and preview file…', exact: true }).click()
    await dialog.getByLabel('Rows per import batch', { exact: true }).fill('2')
    await dialog.getByRole('checkbox', { name: /each batch commits separately/ }).check()
    await dialog
      .getByLabel('Confirm import target', { exact: true })
      .fill(importTargetConfirmation({ connectionId: profile.id, schema: 'main', table: 'records' }))
    await start.click()
    await expect(dialog.getByRole('status')).toContainText('Import failed')
    await expect(dialog.getByRole('definition').nth(0)).toHaveText('2')
    await expect(dialog.getByRole('definition').nth(1)).toHaveText('1')
    await expect(dialog.getByRole('definition').nth(2)).toHaveText('0')
    await expect(dialog.locator('.error-panel')).toContainText('rolled back')
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
