import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

test('portable handoff exports reviewed drafts, strips credential paths and imports inactive copies or explicit bindings', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-portable-workspace-'))
  const root = resolve(import.meta.dirname, '..')
  const primary = shortcutPlatform(process.platform)
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
      name: 'Handoff source',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 1,
      username: 'local_fixture',
      database: 'example',
      notes: 'DO_NOT_EXPORT_NOTES',
      tls: {
        ca: '/source/laptop/ca.pem',
        cert: '/source/laptop/cert.pem',
        keyPath: '/source/laptop/private.key',
      },
      ssh: { privateKeyPath: '/source/laptop/ssh.key' },
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'DISPOSABLE_NOT_EXPORTED' },
        rememberPassword: false,
      })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const sql = "SELECT 'deliberately reviewed text' AS draft_value;"
    await typeSql(page, sql)
    await page.keyboard.press(shortcutKeys('save-query', primary))
    const save = page.getByRole('dialog', { name: 'Save query', exact: true })
    await save.getByRole('textbox').fill('Portable saved query')
    await save.getByRole('button', { name: 'Save query', exact: true }).click()
    await expect(page.getByText('Query saved', { exact: true })).toBeVisible()
    const before = await page.evaluate(() => window.harbor.bootstrap())
    const output = join(userData, 'handoff.json')
    await desktop.evaluate(({ dialog }, path) => {
      // Only the native chooser is a fixture; serialization and filesystem I/O remain real.
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, output)
    await page.keyboard.press(shortcutKeys('settings', primary))
    const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true })
    await settings.getByRole('button', { name: 'Workspace handoff', exact: true }).click()
    const handoff = page.getByRole('dialog', { name: 'Portable workspace handoff', exact: true })
    await handoff.getByRole('checkbox', { name: /^Include saved query text/ }).check()
    await handoff.getByRole('checkbox', { name: /^Include current and archived draft workspaces/ }).check()
    await expect(handoff.getByRole('button', { name: 'Export handoff file', exact: true })).toBeDisabled()
    await handoff.getByRole('checkbox', { name: /^I reviewed the included SQL/ }).check()
    await handoff.getByRole('button', { name: 'Export handoff file', exact: true }).click()
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(output, 'utf8')).format
        } catch {
          return ''
        }
      })
      .toBe('harbor-db-workspace')
    const exported = await readFile(output, 'utf8')
    for (const forbidden of [
      '/source/laptop/',
      'DISPOSABLE_NOT_EXPORTED',
      'DO_NOT_EXPORT_NOTES',
      'hasPassword',
      'privateKeyPath',
      'keyPath',
    ])
      expect(exported).not.toContain(forbidden)
    expect(exported).toContain(sql)
    await handoff.getByRole('button', { name: 'Choose handoff file', exact: true }).click()
    await expect(handoff.getByLabel('Connection 1 import action', { exact: true })).toBeVisible()
    await expect(handoff).toContainText('name conflict; import suffix added')
    await handoff.getByRole('button', { name: 'Import reviewed handoff', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.bootstrap())).profiles.length)
      .toBe(2)
    let imported = await page.evaluate(() => window.harbor.bootstrap())
    const copied = imported.profiles.find((item) => item.id !== profile.id)!
    expect(copied).toMatchObject({
      name: 'Handoff source (imported 1)',
      readOnly: true,
      autoReconnect: false,
      tls: { ca: '', cert: '', keyPath: '' },
      ssh: { privateKeyPath: '' },
    })
    expect(imported.workspace.tabs.map((tab) => tab.id)).toEqual(before.workspace.tabs.map((tab) => tab.id))
    expect(imported.workspace.archivedWorkspaces).toHaveLength(1)
    expect(imported.workspace.archivedWorkspaces[0].tabs[0]).toMatchObject({ connectionId: copied.id, sql })
    expect(imported.savedQueries).toHaveLength(2)
    expect(imported.history).toHaveLength(0)
    expect((await page.evaluate((id) => window.harbor.status(id), copied.id)).state).toBe('disconnected')

    await handoff.getByRole('button', { name: 'Choose handoff file', exact: true }).click()
    await handoff.getByLabel('Connection 1 import action', { exact: true }).selectOption(`bind:${profile.id}`)
    await handoff.getByLabel('Saved query import policy', { exact: true }).selectOption('skip')
    await expect(handoff.getByRole('button', { name: 'Import reviewed handoff', exact: true })).toBeDisabled()
    await handoff.getByRole('checkbox', { name: /^I reviewed each linked destination/ }).check()
    await handoff.getByRole('button', { name: 'Import reviewed handoff', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.archivedWorkspaces.length,
      )
      .toBe(2)
    imported = await page.evaluate(() => window.harbor.bootstrap())
    expect(imported.profiles).toHaveLength(2)
    expect(imported.profiles.find((item) => item.id === profile.id)).toEqual(before.profiles[0])
    expect(imported.workspace.archivedWorkspaces[1].tabs[0].connectionId).toBe(profile.id)
    expect(imported.history).toHaveLength(0)
    await writeFile(output, JSON.stringify({ ...JSON.parse(exported), version: 999 }))
    await handoff.getByRole('button', { name: 'Choose handoff file', exact: true }).click()
    await expect(handoff.getByRole('alert')).toBeVisible()
    await expect(handoff.getByRole('button', { name: 'Import reviewed handoff', exact: true })).toHaveCount(0)
    expect((await page.evaluate(() => window.harbor.bootstrap())).profiles).toHaveLength(2)
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
