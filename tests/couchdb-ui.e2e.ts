import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { waitForElectronWorkspace } from './electron-runtime'
import { couchConfirmation } from '../src/shared/couchdb'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('CouchDB form, explicit selector pages, reviewed revisions, stale draft preservation and privacy', async () => {
  const fixture = process.env.HARBOR_COUCHDB_FIXTURE_DIR
  test.skip(!fixture, 'Requires authorized CouchDB fixture')
  const password = /^COUCHDB_PASSWORD=(.+)$/m.exec(await readFile(fixture + '/fixture.env', 'utf8'))![1]!,
    database = 'harbor_ui_' + randomUUID().replaceAll('-', ''),
    directory = await mkdtemp(join(tmpdir(), 'harbor-couch-ui-')),
    root = resolve(import.meta.dirname, '..')
  const native = async (path: string, method = 'GET', body?: string) => {
    const response = await fetch('http://127.0.0.1:15984/' + database + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from('harbor_fixture:' + password).toString('base64'),
        'Content-Type': 'application/json',
      },
      body,
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  let desktop: ElectronApplication | undefined
  try {
    expect((await native('', 'PUT')).status).toBe(201)
    await native(
      '/sample',
      'PUT',
      '{"_id":"sample","exact":9007199254740993,"label":"synthetic private content"}',
    )
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
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await selectDatabaseEngine(dialog, 'CouchDB')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Couch native fixture')
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await dialog.getByLabel('Port', { exact: true }).fill('15984')
    await dialog.getByLabel('Username', { exact: true }).fill('harbor_fixture')
    await dialog.getByLabel('Password', { exact: true }).fill(password)
    await dialog.getByLabel('Database', { exact: true }).fill(database)
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · CouchDB 3.5.1/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Couch native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Couch native fixture', exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: 'CouchDB documents', exact: true })).toBeVisible()
    await expect(page.getByLabel('CouchDB result documents')).toHaveCount(0)
    await page.getByRole('button', { name: 'Run selector', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'No usable index' })).toBeVisible()
    await page.getByRole('checkbox', { name: /Allow index fallback/ }).check()
    await page.getByRole('button', { name: 'Run selector', exact: true }).click()
    await page
      .getByLabel('CouchDB result documents')
      .getByRole('button', { name: /^sample ·/ })
      .click()
    const editor = page.getByLabel('CouchDB JSON document', { exact: true })
    await expect(editor).toHaveValue(/9007199254740993/)
    const original = await editor.inputValue()
    const revision = JSON.parse(original)._rev as string
    const state = await page.evaluate(() => window.harbor.bootstrap()),
      profile = state.profiles.find((p) => p.name === 'Couch native fixture')!
    await editor.fill(original.replace('synthetic private content', 'local stale draft'))
    await native('/sample', 'PUT', original.replace('synthetic private content', 'concurrent server change'))
    await page
      .getByLabel('Confirm CouchDB mutation', { exact: true })
      .fill(
        couchConfirmation({ connectionId: profile.id, database, id: 'sample', action: 'replace', revision }),
      )
    await page.getByRole('button', { name: 'Apply reviewed document mutation', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Conflict' })).toBeVisible()
    await expect(editor).toHaveValue(original.replace('synthetic private content', 'local stale draft'))
    await page.getByRole('button', { name: 'Discard document draft', exact: true }).click()
    await page.getByRole('button', { name: 'Reload current revision', exact: true }).click()
    await expect(editor).toHaveValue(/concurrent server change/)
    const current = await editor.inputValue(),
      newRevision = JSON.parse(current)._rev as string
    await editor.fill(current.replace('concurrent server change', 'reviewed final value'))
    await page
      .getByLabel('Confirm CouchDB mutation', { exact: true })
      .fill(
        couchConfirmation({
          connectionId: profile.id,
          database,
          id: 'sample',
          action: 'replace',
          revision: newRevision,
        }),
      )
    await page.getByRole('button', { name: 'Apply reviewed document mutation', exact: true }).click()
    await expect.poll(async () => (await native('/sample')).body.label).toBe('reviewed final value')
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.getByRole('button', { name: 'Run selector', exact: true })).toBeVisible()
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(final)).not.toContain(password)
    expect(JSON.stringify(final)).not.toContain('reviewed final value')
    expect(final.history).toHaveLength(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await native('', 'DELETE')
    await rm(directory, { recursive: true, force: true })
  }
})
