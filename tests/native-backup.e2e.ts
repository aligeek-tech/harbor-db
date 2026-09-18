import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('native backup UI selects pinned tools, writes a new archive and reviews restore to a fresh database', async () => {
  test.skip(process.env.HARBOR_NATIVE_BACKUP !== '1', 'Requires disposable PostgreSQL18/native tools.')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harbor-native-drill-ui-')))
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12),
    database = `backup_ui_source_${suffix}`,
    restored = `backup_ui_restored_${suffix}`
  const options = { host: '127.0.0.1', port: 15434, user: 'harbor', password: 'harbor_test' }
  const admin = new Client({ ...options, database: 'harbor' }),
    source = new Client({ ...options, database })
  let desktop: ElectronApplication | undefined
  try {
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    await source.connect()
    await source.query(
      "CREATE TABLE records(id BIGINT PRIMARY KEY,amount NUMERIC(30,8),bytes BYTEA); INSERT INTO records VALUES(9007199254740993,12345678901234567890.12345678,decode('00ff','hex'))",
    )
    const root = resolve(import.meta.dirname, '..'),
      env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
        ),
      )
    desktop = await _electron.launch({
      chromiumSandbox: true,
      args: [root],
      cwd: root,
      env: { ...env, HARBOR_USER_DATA: join(directory, 'metadata') },
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await page.setViewportSize({ width: 1024, height: 700 })
    const profile = profileSchema.parse({
      id: 'backup-ui',
      name: 'Disposable native backup UI',
      engine: 'postgres',
      host: options.host,
      port: options.port,
      database,
      username: options.user,
      schema: 'public',
      readOnly: false,
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'harbor_test' },
        rememberPassword: false,
      })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await page.getByRole('button', { name: 'Inspect database activity', exact: true }).click()
    await page.getByRole('button', { name: 'Native backup / restore', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'PostgreSQL native backup and restore', exact: true })
    await expect(dialog.getByRole('button', { name: 'Preview native backup', exact: true })).toBeDisabled()
    const choose = async (path: string, name: string) => {
      await desktop!.evaluate(({ dialog }, path) => {
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original
          return { canceled: false, filePaths: [path] }
        }
      }, path)
      await dialog.getByRole('button', { name, exact: true }).click()
    }
    await choose('/opt/homebrew/bin/pg_dump', 'Choose pg_dump executable')
    await expect(dialog).toContainText('pg_dump (PostgreSQL) 18.6')
    await dialog.getByLabel('Maximum archive MiB', { exact: true }).fill('16')
    await dialog.getByRole('button', { name: 'Preview native backup', exact: true }).click()
    const startBackup = dialog.getByRole('button', { name: 'Start reviewed native backup', exact: true })
    await expect(startBackup).toBeDisabled()
    await dialog
      .getByLabel('Native backup target confirmation', { exact: true })
      .fill(`back up ${database} on ${profile.name}`)
    const output = join(directory, 'ui.dump')
    await desktop.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath }
      }
    }, output)
    await startBackup.click()
    const progress = dialog.getByRole('status', { name: 'Native backup progress', exact: true })
    await expect(progress).toContainText('backup: completed')
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    await dialog.getByLabel('Native backup workflow', { exact: true }).selectOption('restore')
    await choose('/opt/homebrew/bin/pg_restore', 'Choose pg_restore executable')
    await choose(output, 'Choose custom backup archive')
    await dialog.getByLabel('New restore database name', { exact: true }).fill(restored)
    await dialog.getByRole('checkbox', { name: /I trust the archive source/ }).check()
    await dialog.getByRole('button', { name: 'Preview native restore', exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'Native backup review' })).toContainText(restored)
    expect((await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [restored])).rowCount).toBe(0)
    await dialog
      .getByLabel('Native backup target confirmation', { exact: true })
      .fill(`create and restore ${restored} on ${profile.name}`)
    await dialog.getByRole('button', { name: 'Start reviewed native restore', exact: true }).click()
    await expect(progress).toContainText('restore: completed')
    await expect(progress).toContainText('Representative data still needs verification')
    const verification = new Client({ ...options, database: restored })
    await verification.connect()
    try {
      expect(
        (await verification.query("SELECT id,amount,encode(bytes,'hex') AS bytes FROM records")).rows,
      ).toEqual([{ id: '9007199254740993', amount: '12345678901234567890.12345678', bytes: '00ff' }])
    } finally {
      await verification.end()
    }
    await expect(dialog).not.toContainText(options.password)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await source.end().catch(() => {})
    for (const name of [restored, database])
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
