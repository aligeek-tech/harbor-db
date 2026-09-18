import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Connection, Request } from 'tedious'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

// Browser traces retain evaluate arguments. Never capture the disposable credential in artifacts.
test.use({ trace: 'off' })
test('SQL Server desktop binds T-SQL values, browses exact legacy columns, stages a guarded edit and preserves target identity', async () => {
  test.skip(
    !process.env.HARBOR_MSSQL_TEST_ENV_FILE,
    'Requires separately authorized SQL Server Developer fixture.',
  )
  const text = await readFile(process.env.HARBOR_MSSQL_TEST_ENV_FILE!, 'utf8')
  const password = /^HARBOR_MSSQL_TEST_PASSWORD=(.+)$/m.exec(text)?.[1] || ''
  if (!password) throw new Error('Disposable SQL Server credentials unavailable.')
  const database = 'harbor_ui_' + randomUUID().replaceAll('-', '')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-mssql-ui-'))
  const admin = new Connection({
    server: '127.0.0.1',
    authentication: { type: 'default', options: { userName: 'sa', password } },
    options: {
      port: 25433,
      database: 'master',
      encrypt: false,
      trustServerCertificate: true,
      requestTimeout: 15000,
      maxRetriesOnTransientErrors: 0,
    },
  })
  admin.on('error', () => {})
  const raw = (sql: string) =>
    new Promise<void>((resolve, reject) =>
      admin.execSqlBatch(new Request(sql, (error) => (error ? reject(error) : resolve()))),
    )
  let desktop: ElectronApplication | undefined
  await new Promise<void>((resolve, reject) => {
    admin.once('connect', (error) => (error ? reject(error) : resolve()))
    admin.connect()
  })
  try {
    await raw(`CREATE DATABASE [${database}]`)
    await raw(
      `USE [${database}]; CREATE TABLE dbo.records(id bigint PRIMARY KEY, label nvarchar(200), amount money, created datetime); INSERT INTO dbo.records VALUES(9007199254740993,N'Original SQL Server row',123.4567,'2026-09-18T12:34:56.123');`,
    )
    const profile = profileSchema.parse({
      id: 'mssql-desktop',
      name: 'Disposable SQL Server desktop',
      engine: 'mssql',
      host: '127.0.0.1',
      port: 25433,
      database,
      schema: 'dbo',
      username: 'sa',
      readOnly: false,
      tls: { enabled: false, rejectUnauthorized: false },
    })
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
    await page.evaluate(
      async ({ profile, password }) =>
        window.harbor.saveProfile({ profile, secrets: { password }, rememberPassword: false }),
      { profile, password },
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'records', exact: true }).click()
    const grid = page.locator('.table-scroll:visible')
    await expect(grid.getByRole('cell', { name: '9007199254740993', exact: true })).toBeVisible()
    await expect(grid.getByRole('cell', { name: '123.4567', exact: true })).toBeVisible()
    await expect(grid.getByRole('cell', { name: '2026-09-18T12:34:56.123', exact: true })).toBeVisible()
    await grid.getByRole('cell', { name: 'Original SQL Server row', exact: true }).dblclick()
    await page.getByLabel('Cell value', { exact: true }).fill('Reviewed SQL Server edit')
    await page.getByRole('button', { name: 'Stage change', exact: true }).click()
    await page.getByRole('button', { name: 'Review & apply', exact: true }).click()
    const review = page.getByRole('dialog', { name: /Apply.*change/ })
    await review.getByRole('button', { name: /Apply/ }).click()
    await expect(grid.getByRole('cell', { name: 'Reviewed SQL Server edit', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT @amount AS exact_amount, @label AS unicode_label;')
    await page.locator('summary:visible').filter({ hasText: /^Parameters \(0\)$/ }).click()
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Parameter 1 name', { exact: true }).fill('amount')
    await page.getByLabel('Parameter 1 type', { exact: true }).selectOption('decimal')
    await page.getByLabel('Parameter 1 value', { exact: true }).fill('12345678901234567890.123456789')
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Parameter 2 name', { exact: true }).fill('label')
    await page.getByLabel('Parameter 2 value', { exact: true }).fill('فارسی exact')
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    await expect(
      grid.getByRole('cell', { name: '12345678901234567890.123456789', exact: true }),
    ).toBeVisible()
    await expect(grid.getByRole('cell', { name: 'فارسی exact', exact: true })).toBeVisible()
    const saved = await page.evaluate(() => window.harbor.bootstrap())
    expect(saved.workspace.tabs.every((tab) => tab.database === database)).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('12345678901234567890.123456789')
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await raw(`USE master; IF DB_ID(N'${database}') IS NOT NULL DROP DATABASE [${database}]`)
    admin.close()
    await rm(directory, { recursive: true, force: true })
  }
})
