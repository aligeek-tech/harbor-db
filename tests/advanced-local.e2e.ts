import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const root = resolve(import.meta.dirname, '..')

test('assistance preview and reusable report task stay reviewed, inert, and local', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'harbor-advanced-local-'))
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
      id: 'advanced-local-duckdb',
      name: 'Advanced local acceptance',
      engine: 'duckdb',
      host: '127.0.0.1',
      port: 1,
      schema: 'main',
      readOnly: false,
      duckdb: { path: join(userData, 'advanced.duckdb'), mode: 'open' },
    })
    await page.evaluate(async (value) => {
      await window.harbor.saveProfile({
        profile: { ...value, duckdb: { ...value.duckdb!, mode: 'create' } },
        rememberPassword: false,
      })
      await window.harbor.connect({ id: value.id })
      const sessionId = crypto.randomUUID()
      try {
        await window.harbor.query({
          connectionId: value.id,
          sessionId,
          requestId: crypto.randomUUID(),
          privateSession: true,
          sql: "CREATE TABLE synthetic_values(id INTEGER, label VARCHAR); INSERT INTO synthetic_values VALUES (1, 'alpha'), (2, 'beta');",
          maxRows: 100,
        })
      } finally {
        await window.harbor.closeSession({ connectionId: value.id, sessionId })
      }
      const now = new Date().toISOString()
      await window.harbor.saveReport({
        id: 'advanced-local-report',
        name: 'Synthetic local report',
        engine: 'duckdb',
        connectionId: value.id,
        database: 'main',
        sql: 'SELECT id, label FROM synthetic_values ORDER BY id',
        parameterDefinitions: [],
        view: { kind: 'table', maxPoints: 200, sampling: 'even' },
        filters: [],
        createdAt: now,
        updatedAt: now,
      })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(
      page,
      "SELECT id FROM synthetic_values WHERE label = 'password=CANARY_SECRET'; -- /Users/alice/private.sql",
    )
    await page.getByRole('button', { name: 'Review opt-in database assistance', exact: true }).click()
    const assistance = page.getByRole('dialog', { name: 'Opt-in database assistance', exact: true })
    await assistance.getByRole('button', { name: 'Review exact request', exact: true }).click()
    await expect(assistance).toContainText('http://127.0.0.1:11434/api/generate')
    await expect(assistance).toContainText('No row data, parameter values, credentials, local paths or results are included.')
    const reviewedRequest = await assistance.locator('pre').innerText()
    expect(reviewedRequest).toContain('password=[redacted]')
    expect(reviewedRequest).toContain('[redacted-path]')
    expect(reviewedRequest).not.toContain('CANARY_SECRET')
    expect(reviewedRequest).not.toContain('/Users/alice')
    expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
    await page.keyboard.press('Escape')
    await expect(assistance).not.toBeVisible()

    await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true })
    await settings.getByLabel('Name', { exact: true }).fill('Manual synthetic report')
    await settings.getByLabel('Explicitly enable', { exact: true }).check()
    await settings.getByRole('button', { name: 'Save reusable task', exact: true }).click()
    const task = settings.locator('div.rounded.border.p-2').filter({ hasText: 'Manual synthetic report' })
    await expect(task).toContainText('report · Advanced local acceptance')
    await expect(task).toContainText('enabled · next manual')
    await task.getByRole('button', { name: 'Run now', exact: true }).click()
    await expect(settings).toContainText('completed · completed')

    const automation = await page.evaluate(() => window.harbor.listAutomations())
    expect(automation.definitions).toHaveLength(1)
    expect(automation.runs[0]).toMatchObject({ state: 'completed', code: 'completed', rows: 2 })
    const persisted = JSON.stringify(automation)
    expect(persisted).not.toContain(userData)
    expect(persisted).not.toContain('CANARY_SECRET')
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
