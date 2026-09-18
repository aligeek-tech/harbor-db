import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const primary = shortcutPlatform(process.platform)
const root = resolve(import.meta.dirname, '..')
async function fixture(userData: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  const desktop = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData },
  })
  try {
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: 'Workspace fixture',
      engine: 'sqlite',
      host: '127.0.0.1',
      port: 1,
      username: '',
      schema: 'main',
      sqlite: { path: join(userData, 'workspace.sqlite3'), mode: 'create' },
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
          privateSession: true,
          sql: "CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO records VALUES(1,'ordinary');",
          maxRows: 100,
        })
      } finally {
        await window.harbor.closeSession({ connectionId: profile.id, sessionId })
      }
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    return { desktop, page, profile }
  } catch (error) {
    await desktop.close()
    throw error
  }
}
const manager = (page: Page) => page.getByRole('dialog', { name: 'Workspaces and tabs', exact: true })
async function openManager(page: Page) {
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click()
  await expect(manager(page)).toBeVisible()
  return manager(page)
}

test('named workspaces preserve renamed and pinned drafts, compare loaded sets and reopen without executing', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-workspace-drafts-'))
  let desktop: ElectronApplication | undefined
  try {
    const launched = await fixture(userData)
    desktop = launched.desktop
    const { page } = launched
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, "SELECT '9007199254740993' AS duplicate, NULL AS duplicate;")
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: '9007199254740993', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Show editor and results side by side', exact: true }).click()
    await expect(page.locator('.query-panels:visible')).toHaveAttribute('data-layout', 'side-by-side')
    await page.getByRole('separator', { name: 'Resize query editor' }).press('ArrowLeft')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.settings.editorWidthPercent,
      )
      .toBe(45)
    await page.getByRole('button', { name: 'Stack editor above results', exact: true }).click()

    let dialog = await openManager(page)
    await dialog.getByRole('button', { name: 'Rename Query 1', exact: true }).click()
    const rename = page.getByRole('dialog', { name: 'Rename tab', exact: true })
    await rename.getByRole('textbox').fill('Precision draft')
    await rename.getByRole('button', { name: 'Rename tab', exact: true }).click()
    await dialog.getByRole('button', { name: 'Pin Precision draft', exact: true }).click()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Close Precision draft', exact: true }).click()
    await expect(page.getByText('Unpin this tab before closing it.', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: /Precision draft/ })).toHaveCount(1)

    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, "SELECT '9007199254740992' AS duplicate, '' AS duplicate;")
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: '9007199254740992', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Compare loaded results', exact: true }).click()
    const comparison = page.getByRole('dialog', { name: 'Compare loaded results', exact: true })
    await expect(comparison.getByRole('status')).toContainText('2 different cells in 2 compared cells')
    await expect(comparison.getByText('string: "9007199254740993"', { exact: true })).toBeVisible()
    await comparison.getByRole('button', { name: 'Close comparison', exact: true }).click()
    await page.getByRole('button', { name: 'Close Query 2', exact: true }).click()
    dialog = await openManager(page)
    await dialog.getByRole('button', { name: 'Reopen Query 2', exact: true }).click()
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
    const before = await page.evaluate(() => window.harbor.bootstrap())
    const oldTabIds = before.workspace.tabs.map((tab) => tab.id)
    dialog = await openManager(page)
    await dialog.getByLabel('New workspace name', { exact: true }).fill('Investigation')
    await dialog.getByRole('button', { name: 'Create and switch', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab')).toHaveCount(0)
    dialog = await openManager(page)
    await dialog.getByRole('button', { name: 'Open Default workspace', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab')).toHaveCount(2)
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
    const after = await page.evaluate(() => window.harbor.bootstrap())
    expect(after.history).toHaveLength(before.history.length)
    expect(after.workspace.tabs.every((tab) => !oldTabIds.includes(tab.id))).toBe(true)
    expect(after.workspace.tabs[0]).toMatchObject({
      title: 'Precision draft',
      pinned: true,
      sql: "SELECT '9007199254740993' AS duplicate, NULL AS duplicate;",
    })
    expect(after.workspace.archivedWorkspaces[0].name).toBe('Investigation')
    expect(JSON.stringify(after.workspace)).not.toContain('affectedRows')
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page.getByRole('tab', { name: /Precision draft/ })).toHaveCount(1)
    await expect(page.getByText('Ready when you are', { exact: true })).toBeVisible()
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})

test('workspace switch reviews and rolls back real transactions and restored table tabs require explicit load', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-workspace-transaction-'))
  let desktop: ElectronApplication | undefined
  try {
    const launched = await fixture(userData)
    desktop = launched.desktop
    const { page, profile } = launched
    await page.getByRole('button', { name: 'records', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'ordinary', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, "INSERT INTO records VALUES(2,'must roll back');")
    await page.getByRole('button', { name: 'Begin', exact: true }).click()
    await expect(page.getByRole('contentinfo').getByText('Transaction open', { exact: true })).toBeVisible()
    await page.keyboard.press(shortcutKeys('run-current', primary))
    await expect(page.getByText('1 affected', { exact: true })).toBeVisible()
    const dialog = await openManager(page)
    await dialog.getByLabel('New workspace name', { exact: true }).fill('Other work')
    await dialog.getByRole('button', { name: 'Create and switch', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Review workspace switch', exact: true })
    await expect(review).toContainText('rolls back open transactions in Query 1')
    await review.getByRole('button', { name: 'Discard changes and switch', exact: true }).click()
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab')).toHaveCount(0)
    const count = await page.evaluate(async (connectionId) => {
      const sessionId = crypto.randomUUID()
      try {
        return (
          await window.harbor.query({
            connectionId,
            sessionId,
            requestId: crypto.randomUUID(),
            privateSession: true,
            sql: 'SELECT COUNT(*) AS count FROM records',
            maxRows: 100,
          })
        ).sets[0].rows[0][0]
      } finally {
        await window.harbor.closeSession({ connectionId, sessionId })
      }
    }, profile.id)
    expect(String(count)).toBe('1')
    await openManager(page)
    await dialog.getByRole('button', { name: 'Open Default workspace', exact: true }).click()
    await page.getByRole('tab', { name: 'records', exact: true }).click()
    await expect(page.getByText('Restored tab · no query executed', { exact: true })).toBeVisible()
    await expect(page.locator('.table-scroll:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open table view', exact: true }).click()
    // A restored table SQL snapshot opens as a draft; fetching requires the existing Reload action.
    await expect(page.getByText('Transaction open', { exact: true })).toHaveCount(0)
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
            (tab) => tab.table === 'records',
          )?.sql,
      )
      .toContain('SELECT')
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})

test('private closed drafts and tab metadata never return to persisted workspaces', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-workspace-private-'))
  let desktop: ElectronApplication | undefined
  try {
    const launched = await fixture(userData)
    desktop = launched.desktop
    const { page } = launched
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await typeSql(page, 'SELECT 1 AS ordinary_draft;')
    await page.keyboard.press(shortcutKeys('settings', primary))
    const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true })
    await settings.getByRole('checkbox', { name: /^Private session/ }).check()
    await expect
      .poll(
        async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.settings.privateSession,
      )
      .toBe(true)
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    const editor = page.locator('.monaco-editor:visible textarea').first()
    await editor.focus()
    await editor.press(shortcutKeys('editor-select-all', primary))
    await editor.pressSequentially('SELECT private_value_never_persist;')
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText(
      'private_value_never_persist',
    )
    await page.getByRole('button', { name: 'Close Query 1', exact: true }).click()
    const dialog = await openManager(page)
    await expect(dialog.getByRole('button', { name: 'Create and switch', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Reopen Query 1', exact: true }).click()
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText(
      'private_value_never_persist',
    )
    expect(JSON.stringify((await page.evaluate(() => window.harbor.bootstrap())).workspace)).not.toContain(
      'private_value_never_persist',
    )
    await page.keyboard.press(shortcutKeys('settings', primary))
    await settings.getByRole('checkbox', { name: /^Private session/ }).click()
    await page
      .getByRole('dialog', { name: 'End this private session?', exact: true })
      .getByRole('button', { name: 'Discard private edits and resume', exact: true })
      .click()
    await expect
      .poll(
        async () => (await page.evaluate(() => window.harbor.bootstrap())).workspace.settings.privateSession,
      )
      .toBe(false)
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('ordinary_draft')
    expect(JSON.stringify((await page.evaluate(() => window.harbor.bootstrap())).workspace)).not.toContain(
      'private_value_never_persist',
    )
  } finally {
    if (desktop) {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop.close()
    }
    await rm(userData, { recursive: true, force: true })
  }
})
