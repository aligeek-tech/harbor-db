import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { createClient } from 'redis'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Valkey form preserves product identity, edits with conflict/TTL checks and reopens without execution', async () => {
  const fixture = process.env.HARBOR_VALKEY_FIXTURE_DIR
  test.skip(!fixture, 'Requires the isolated native Valkey fixture.')
  const credentials = JSON.parse(await readFile(fixture + '/credentials.json', 'utf8')) as {
    password: string
  }
  const directory = await mkdtemp(join(tmpdir(), 'harbor-valkey-ui-')),
    root = resolve(import.meta.dirname, '..')
  const prefix = 'harbor-valkey-ui:' + randomUUID() + ':',
    key = prefix + 'value'
  const client = createClient({
    socket: { host: '127.0.0.1', port: 16479, reconnectStrategy: false },
    username: 'harbor',
    password: credentials.password,
    database: 13,
  })
  client.on('error', () => {})
  let desktop: ElectronApplication | undefined
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  const launch = () =>
    _electron.launch({
      chromiumSandbox: true,
      args: [root],
      cwd: root,
      env: { ...env, HARBOR_USER_DATA: directory },
    })
  try {
    await client.connect()
    await client.set(key, 'before', { EX: 300 })
    desktop = await launch()
    let page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    await selectDatabaseEngine(page, 'Valkey')
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Valkey native fixture')
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await dialog.getByLabel('Port', { exact: true }).fill('16479')
    await dialog.getByLabel('ACL username (optional)', { exact: true }).fill('harbor')
    await dialog.getByLabel('Password', { exact: true }).fill(credentials.password)
    await dialog.getByLabel('Logical database', { exact: true }).fill('13')
    await expect(dialog.getByLabel('Deployment', { exact: true })).toHaveValue('standalone')
    await expect(dialog.locator('option[value="cluster"]')).toBeDisabled()
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Valkey 9.1.2/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Valkey native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Valkey native fixture', exact: true }).click()
    await page.getByRole('button', { name: 'Browse keys', exact: true }).click()
    await page.getByLabel('Valkey key pattern', { exact: true }).fill(prefix + '*')
    await page.getByRole('button', { name: 'Scan matching keys', exact: true }).click()
    await page
      .getByRole('button')
      .filter({ has: page.locator('strong', { hasText: key }) })
      .click()
    const value = page.getByLabel('Raw string value', { exact: true })
    await expect(value).toHaveValue('before')
    await value.fill('after')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(() => client.get(key)).toBe('after')
    expect(await client.ttl(key)).toBeGreaterThan(200)
    await value.fill('stale local draft')
    await client.set(key, 'concurrent change', { KEEPTTL: true })
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'CONFLICT' })).toBeVisible()
    await expect(value).toHaveValue('stale local draft')
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.getByRole('button', { name: 'Topology', exact: true }).click()
    const topology = page.getByRole('dialog', { name: /Valkey topology/ })
    await topology.getByRole('button', { name: 'Refresh topology', exact: true }).click()
    await expect(topology.getByText(/standalone/)).toBeVisible()
    await topology.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Stream / live tools', exact: true }).click()
    const tools = page.getByRole('dialog', { name: 'Valkey stream and live tools', exact: true })
    await tools.getByLabel('Channel to capture', { exact: true }).fill(prefix + 'channel')
    await tools.getByRole('button', { name: 'Start capture', exact: true }).click()
    await expect(tools.getByRole('status')).toContainText('running')
    await client.publish(prefix + 'channel', 'synthetic Valkey message')
    await expect(tools.getByText(/synthetic Valkey message/)).toBeVisible()
    await tools.getByRole('button', { name: 'Stop capture', exact: true }).click()
    await expect(tools.getByRole('status')).toContainText('stopped')
    await tools.getByRole('button', { name: 'Close', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.getByRole('button', { name: 'Topology', exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.profiles[0]?.engine).toBe('valkey')
    expect(JSON.stringify(state)).not.toContain(credentials.password)
    expect(JSON.stringify(state)).not.toContain('synthetic Valkey message')
    await desktop.evaluate(({ app }) => app.exit(0))
    await desktop.close()
    desktop = undefined
    desktop = await launch()
    page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await expect(page.getByRole('button', { name: 'Valkey native fixture', exact: true })).toBeVisible()
    const reopened = await page.evaluate(() => window.harbor.bootstrap())
    expect(reopened.profiles[0]?.engine).toBe('valkey')
    expect(await client.get(key)).toBe('concurrent change')
  } finally {
    if (client.isReady) await client.unlink(key)
    if (client.isOpen) client.destroy()
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
