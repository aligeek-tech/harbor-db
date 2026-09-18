import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

test('native transfer reviews both targets, maps duplicate columns, commits exact rows and reports later rollback', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires isolated PostgreSQL fixture.')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-transfer-ui-'))
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
    await page.setViewportSize({ width: 1024, height: 700 })
    const source = profileSchema.parse({
      id: 'transfer-source',
      name: 'Transfer source PostgreSQL',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 15432,
      username: 'harbor',
      database: 'harbor',
      schema: 'public',
      readOnly: true,
    })
    const target = profileSchema.parse({
      id: 'transfer-target',
      name: 'Transfer destination SQLite',
      engine: 'sqlite',
      host: 'local',
      port: 1,
      schema: 'main',
      readOnly: false,
      sqlite: { path: join(directory, 'destination.sqlite'), mode: 'create' },
    })
    await page.evaluate(
      async ({ source, target }) => {
        await window.harbor.saveProfile({
          profile: source,
          secrets: { password: 'harbor_test' },
          rememberPassword: false,
        })
        await window.harbor.saveProfile({ profile: target, rememberPassword: false })
        await window.harbor.connect({ id: target.id })
        await window.harbor.query({
          connectionId: target.id,
          sessionId: 'setup',
          requestId: crypto.randomUUID(),
          sql: 'CREATE TABLE records(id INTEGER PRIMARY KEY,exact_value TEXT NOT NULL,label TEXT)',
          maxRows: 1,
          privateSession: true,
        })
        await window.harbor.closeSession({ connectionId: target.id, sessionId: 'setup' })
        await window.harbor.saveProfile({ profile: { ...target, sqlite: { ...target.sqlite, mode: 'open' } }, rememberPassword: false })
      },
      { source, target },
    )
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: target.name, exact: true }).dblclick()
    await page.getByRole('button', { name: source.name, exact: true }).dblclick()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const count = () =>
      page.evaluate(async () => {
        const result = await window.harbor.query({
          connectionId: 'transfer-target',
          sessionId: 'verify',
          requestId: crypto.randomUUID(),
          sql: 'SELECT COUNT(*) FROM records',
          maxRows: 1,
          privateSession: true,
        })
        await window.harbor.closeSession({ connectionId: 'transfer-target', sessionId: 'verify' })
        return result.sets[0].rows[0][0]
      })
    await typeSql(
      page,
      "SELECT n::bigint AS duplicate,9007199254740993::bigint AS duplicate,CASE WHEN n=1 THEN NULL ELSE '' END::text AS label FROM generate_series(1,251) n;",
    )
    await page.getByRole('button', { name: 'Transfer to database', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Transfer a query result to a database', exact: true })
    await expect(
      dialog.getByRole('button', { name: 'Preview source and destination', exact: true }),
    ).toBeDisabled()
    expect(await count()).toBe('0')
    await dialog.getByLabel('Transfer destination connection', { exact: true }).selectOption(target.id)
    await dialog.getByRole('button', { name: 'Load destination tables', exact: true }).click()
    await dialog.getByLabel('Transfer destination table', { exact: true }).selectOption('records')
    await dialog.getByRole('button', { name: 'Preview source and destination', exact: true }).click()
    await expect(dialog.getByRole('region', { name: 'Database transfer review' })).toContainText(
      'Transfer source PostgreSQL / harbor → Transfer destination SQLite / main / main.records',
    )
    expect(await count()).toBe('0')
    await dialog.getByLabel('Source for id', { exact: true }).selectOption('0')
    await dialog.getByLabel('Conversion for id', { exact: true }).selectOption('integer')
    await dialog.getByLabel('Source for exact_value', { exact: true }).selectOption('1')
    await dialog.getByLabel('Source for label', { exact: true }).selectOption('2')
    const start = dialog.getByRole('button', { name: 'Start reviewed database transfer', exact: true })
    await expect(start).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /Rerun the source/ }).check()
    await dialog.getByRole('checkbox', { name: /Commit each destination batch/ }).check()
    await dialog
      .getByLabel('Transfer destination confirmation', { exact: true })
      .fill('TRANSFER transfer-target/main/main/records')
    await start.click()
    const progress = dialog.getByRole('status', { name: 'Database transfer progress', exact: true })
    await expect(progress).toContainText('Transfer completed')
    await expect(progress).toContainText('251 committed in 3 batches')
    const result = await page.evaluate(async () => {
      const result = await window.harbor.query({
        connectionId: 'transfer-target',
        sessionId: 'verify',
        requestId: crypto.randomUUID(),
        sql: "SELECT COUNT(*),MIN(exact_value),SUM(label IS NULL),SUM(label='') FROM records",
        maxRows: 1,
        privateSession: true,
      })
      await window.harbor.closeSession({ connectionId: 'transfer-target', sessionId: 'verify' })
      return result.sets[0].rows
    })
    expect(result).toEqual([['251', '9007199254740993', '1', '250']])
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
    await typeSql(
      page,
      "SELECT n::bigint AS id,'exact'::text AS exact_value FROM (VALUES(1,500),(2,501),(3,502),(4,500),(5,503)) v(ord,n) ORDER BY ord;",
    )
    await page.getByRole('button', { name: 'Transfer to database', exact: true }).click()
    await dialog.getByRole('button', { name: 'Preview source and destination', exact: true }).click()
    await dialog.getByLabel('Source for id', { exact: true }).selectOption('0')
    await dialog.getByLabel('Conversion for id', { exact: true }).selectOption('integer')
    await dialog.getByLabel('Source for exact_value', { exact: true }).selectOption('1')
    await dialog.getByLabel('Transfer batch size', { exact: true }).fill('2')
    await dialog.getByRole('checkbox', { name: /Rerun the source/ }).check()
    await dialog.getByRole('checkbox', { name: /Commit each destination batch/ }).check()
    await dialog
      .getByLabel('Transfer destination confirmation', { exact: true })
      .fill('TRANSFER transfer-target/main/main/records')
    await start.click()
    await expect(progress).toContainText('Transfer failed')
    await expect(progress).toContainText('2 committed in 1 batches · 2 confirmed rolled back · 0 uncertain')
    await expect(progress).toContainText('0 buffered rows')
    expect(await count()).toBe('253')
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
    await typeSql(page, "SELECT (1000+n)::bigint AS id,'cancel'::text AS exact_value,pg_sleep(0.005) AS pause FROM generate_series(1,100000) n;")
    await page.getByRole('button', { name: 'Transfer to database', exact: true }).click()
    await dialog.getByRole('button', { name: 'Preview source and destination', exact: true }).click()
    await dialog.getByLabel('Source for id', { exact: true }).selectOption('0')
    await dialog.getByLabel('Conversion for id', { exact: true }).selectOption('integer')
    await dialog.getByLabel('Source for exact_value', { exact: true }).selectOption('1')
    await dialog.getByRole('checkbox', { name: /Rerun the source/ }).check()
    await dialog.getByRole('checkbox', { name: /Commit each destination batch/ }).check()
    await dialog.getByLabel('Transfer destination confirmation', { exact: true }).fill('TRANSFER transfer-target/main/main/records')
    await start.click()
    await dialog.getByRole('button', { name: 'Cancel database transfer', exact: true }).click()
    await expect(progress).toContainText('Transfer cancelled')
    await expect(progress).toContainText('0 uncertain')
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
