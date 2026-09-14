import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { profileSchema, type ConnectionProfile } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')

function tree(page: Page, profile: ConnectionProfile) {
  return page.getByRole('button', { name: profile.name, exact: true }).locator('..').locator('..')
}
function grid(page: Page) {
  return page.locator('.table-scroll:visible')
}
async function expectSelectedRows(page: Page, expected: number[]) {
  const results = grid(page)
  await expect(results.locator('tbody input[type="checkbox"]:checked')).toHaveCount(expected.length)
  for (const row of expected) {
    const checkbox = results.getByRole('checkbox', { name: `Select row ${row}`, exact: true })
    await expect(checkbox).toBeChecked()
    await expect(checkbox.locator('..').locator('..')).toHaveClass(/\b(?:selected|checked-row)\b/)
  }
  await expect
    .poll(() =>
      results
        .locator('tbody tr.selected, tbody tr.checked-row, tbody td[aria-selected="true"]')
        .evaluateAll((elements) =>
          elements.every(
            (element) =>
              element.closest('tr')?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
          ),
        ),
    )
    .toBe(true)
  await expect(page.locator('.grid-selection-bar:visible')).toContainText(
    `${expected.length} ${expected.length === 1 ? 'row' : 'rows'} selected`,
  )
  if (expected.length === 0) {
    await expect(results.locator('tbody tr.selected, tbody tr.checked-row')).toHaveCount(0)
    await expect(results.locator('td[aria-selected="true"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  }
}
async function connect(page: Page, profile: ConnectionProfile) {
  await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
  await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
}
async function draft(page: Page, table: string, connectionId: string) {
  return page.evaluate(
    async ({ table, connectionId }) =>
      (await window.harbor.bootstrap()).workspace.tabs.find(
        (tab) => tab.table === table && tab.connectionId === connectionId,
      )?.sql || '',
    { table, connectionId },
  )
}
async function typeSql(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor:visible textarea').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await editor.press('ControlOrMeta+Home')
  await editor.press('ControlOrMeta+Shift+End')
  await editor.pressSequentially(sql)
  return editor
}

for (const engine of ['postgres', 'mariadb'] as const) {
  test(`${engine} table workbench tracks SQL, guards drafts, runs read-only results and reviews selected deletes`, async () => {
    test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated SQL development services.')
    const suffix = `workbench_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const schema = engine === 'postgres' ? suffix : 'harbor'
    const table = engine === 'postgres' ? 'records' : `${suffix}_records`
    const noKey = engine === 'postgres' ? 'without_key' : `${suffix}_without_key`
    const quote = (name: string) => (engine === 'postgres' ? `"${name}"` : `\`${name}\``)
    const target = `${quote(schema)}.${quote(table)}`
    const noKeyTarget = `${quote(schema)}.${quote(noKey)}`
    const userData = await mkdtemp(join(tmpdir(), `harbor-workbench-${engine}-`))
    const profile = profileSchema.parse({
      id: randomUUID(),
      name: `${engine} table workbench`,
      engine,
      host: '127.0.0.1',
      port: engine === 'postgres' ? 15432 : 13306,
      username: 'harbor',
      database: 'harbor',
      schema,
      environment: 'development',
      readOnly: false,
    })
    const readOnly = profileSchema.parse({
      ...profile,
      id: randomUUID(),
      name: `${engine} read-only workbench`,
      readOnly: true,
    })
    let pg: Client | undefined
    let maria: Connection | undefined
    let desktop: ElectronApplication | undefined
    const exec = async (sql: string) => {
      if (pg) await pg.query(sql)
      else await maria!.query(sql)
    }
    const ids = async () => {
      const rows = pg
        ? (await pg.query(`SELECT id FROM ${target} ORDER BY id`)).rows
        : await maria!.query(`SELECT id FROM ${target} ORDER BY id`)
      return rows.map((row: { id: number }) => Number(row.id))
    }
    try {
      if (engine === 'postgres') {
        pg = new Client({
          host: '127.0.0.1',
          port: 15432,
          user: 'harbor',
          password: 'harbor_test',
          database: 'harbor',
        })
        await pg.connect()
        await exec(`CREATE SCHEMA ${quote(schema)}`)
      } else {
        maria = await mariadb.createConnection({
          host: '127.0.0.1',
          port: 13306,
          user: 'harbor',
          password: 'harbor_test',
          database: 'harbor',
        })
      }
      // All identifiers and values are generated here; no existing table is mutated.
      await exec(`CREATE TABLE ${target} (id INTEGER PRIMARY KEY, label VARCHAR(100), bucket VARCHAR(20))`)
      await exec(`CREATE TABLE ${noKeyTarget} (id INTEGER, label VARCHAR(100))`)
      await exec(`INSERT INTO ${noKeyTarget} VALUES (1, 'no key record')`)
      const values = Array.from({ length: 60 }, (_, index) => {
        const id = index + 1
        const label = [5, 17].includes(id) ? `delete-target-${id}` : `row-${String(id).padStart(3, '0')}`
        return `(${id}, '${label}', '${id <= 8 ? 'sample' : 'bulk'}')`
      })
      await exec(`INSERT INTO ${target} VALUES ${values.join(', ')}`)
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
        timeout: 30000,
      })
      const page = await desktop.firstWindow()
      const pageErrors: string[] = []
      const consoleErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      await waitForElectronWorkspace(page)
      await page.evaluate(
        async (profiles) => {
          for (const profile of profiles)
            await window.harbor.saveProfile({
              profile,
              secrets: { password: 'harbor_test' },
              rememberPassword: false,
            })
          const state = await window.harbor.bootstrap()
          await window.harbor.saveWorkspace({
            ...state.workspace,
            tabs: [],
            activeTabId: null,
            expanded: [],
            settings: { ...state.workspace.settings, pageSize: 50, editorHeight: 220, theme: 'dark' },
          })
        },
        [profile, readOnly],
      )
      await page.reload()
      await waitForElectronWorkspace(page)
      await expect(page).toHaveTitle('Harbor DB')
      expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/)
      await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
      await expect(page.locator('vite-error-overlay')).toHaveCount(0)
      await inspectElectronSandbox(desktop, page)
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
      )
      await connect(page, profile)
      await tree(page, profile).getByRole('button', { name: table, exact: true }).click()
      await expect(grid(page).getByRole('cell', { name: 'row-001', exact: true })).toBeVisible()
      await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('SELECT')
      await expect.poll(() => draft(page, table, profile.id)).toContain(target)
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/LIMIT\s+50\s+OFFSET\s+0/i)
      await expectSelectedRows(page, [])

      const cell = (label: string) => grid(page).getByRole('cell', { name: label, exact: true })
      const rowNumber = (row: number) =>
        grid(page)
          .getByRole('checkbox', { name: `Select row ${row}`, exact: true })
          .locator('..')
          .locator('..')
          .locator('.row-number')
      await cell('row-003').click()
      await expectSelectedRows(page, [3])
      await expect(cell('row-003')).toHaveAttribute('aria-selected', 'true')
      await rowNumber(6).click()
      await expectSelectedRows(page, [6])
      await cell('row-009').click({ modifiers: ['ControlOrMeta'] })
      await expectSelectedRows(page, [6, 9])
      await rowNumber(6).click({ modifiers: ['ControlOrMeta'] })
      await expectSelectedRows(page, [9])
      await cell('row-003').click()
      await cell('row-006').click({ modifiers: ['Shift'] })
      await expectSelectedRows(page, [3, 4, 5, 6])
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('')
      await grid(page).focus()
      await grid(page).press('Shift+ArrowDown')
      await expectSelectedRows(page, [3, 4, 5, 6, 7])
      await grid(page).press('Shift+ArrowUp')
      await expectSelectedRows(page, [3, 4, 5, 6])
      await expect(grid(page).locator('td[aria-selected="true"]')).toHaveCount(4)
      for (const label of ['row-003', 'row-004', 'delete-target-5', 'row-006'])
        await expect(cell(label)).toHaveAttribute('aria-selected', 'true')
      await grid(page).getByRole('checkbox', { name: 'Select row 4', exact: true }).uncheck()
      await expectSelectedRows(page, [3, 5, 6])
      await expect(cell('row-004')).toHaveAttribute('aria-selected', 'false')
      await grid(page).getByRole('checkbox', { name: 'Select row 8', exact: true }).check()
      await expectSelectedRows(page, [3, 5, 6, 8])
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('')
      await mkdir('/tmp/harbor-db-e2e', { recursive: true })
      await page.screenshot({ path: `/tmp/harbor-db-e2e/selection-sync-${engine}.png` })
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
      await expectSelectedRows(page, [])

      // Table navigation updates the same displayed and persisted SQL draft.
      const idSort = () => grid(page).getByRole('button', { name: 'id', exact: true })
      await idSort().click()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/ORDER BY.*id.*ASC/i)
      await idSort().click()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/ORDER BY.*id.*DESC/i)
      await expect(grid(page).getByRole('cell', { name: 'row-060', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/OFFSET\s+50/i)
      await expect(grid(page).getByRole('cell', { name: 'row-010', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Previous page', exact: true }).click()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/OFFSET\s+0/i)
      await page.getByRole('button', { name: 'Server-side filter', exact: true }).click()
      await page.getByLabel('Filter column', { exact: true }).selectOption('bucket')
      await page.getByLabel('Filter condition', { exact: true }).selectOption('equals')
      await page.getByLabel('Filter value', { exact: true }).fill('sample')
      await page.getByRole('button', { name: 'Apply filter', exact: true }).click()
      await expect.poll(() => draft(page, table, profile.id)).toContain("'sample'")
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/WHERE/i)
      await expect(grid(page).locator('table')).toHaveAttribute('aria-rowcount', '9')
      await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
      await expect.poll(() => draft(page, table, profile.id)).not.toMatch(/WHERE/i)
      await idSort().click()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/ORDER BY.*id.*ASC/i)

      await grid(page).getByRole('cell', { name: 'row-001', exact: true }).dblclick()
      await page.getByLabel('Cell value', { exact: true }).fill('pending row one')
      await page.getByRole('button', { name: 'Stage change', exact: true }).click()
      await expect(page.locator('.pending-bar:visible')).toContainText('1 changes ready to apply')
      await expect(
        page.locator('.editor-region:visible').getByRole('button', { name: /^Run Ctrl/ }),
      ).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeDisabled()
      await expect(
        page.getByRole('button', { name: 'Explain current statement (does not execute it)', exact: true }),
      ).toBeDisabled()
      const editor = page.locator('.monaco-editor:visible textarea').first()
      await editor.focus()
      await editor.press('ControlOrMeta+Enter')
      await expect(page.locator('.pending-bar:visible')).toContainText('1 changes ready to apply')
      await expect(page.getByRole('button', { name: 'Return to table', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Discard', exact: true }).click()

      const custom = `SELECT id, label FROM ${target} WHERE id IN (1, 2) ORDER BY id;`
      const customEditor = await typeSql(page, custom)
      await expect.poll(() => draft(page, table, profile.id)).toBe(custom)
      await customEditor.press('ControlOrMeta+Enter')
      await expect(page.getByRole('button', { name: 'Return to table', exact: true })).toBeVisible()
      await expect(grid(page).locator('table')).toHaveAttribute('aria-rowcount', '3')
      await grid(page).getByRole('checkbox', { name: 'Select all filtered loaded rows', exact: true }).check()
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toHaveCount(0)
      await grid(page).getByRole('cell', { name: 'row-001', exact: true }).dblclick()
      await expect(page.getByRole('dialog', { name: 'Edit label', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Return to table', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Load table query', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
      await expect.poll(() => draft(page, table, profile.id)).toMatch(/LIMIT\s+50/i)

      // Pointer range selection maps the two filtered rows to original loaded
      // indices 5 and 17, without selecting the intervening hidden records.
      await page.getByLabel('Filter loaded results', { exact: true }).fill('delete-target')
      const selectAll = grid(page).getByRole('checkbox', {
        name: 'Select all filtered loaded rows',
        exact: true,
      })
      await grid(page).getByRole('cell', { name: 'delete-target-5', exact: true }).click()
      await expectSelectedRows(page, [5])
      await expect(selectAll).not.toBeChecked()
      await grid(page)
        .getByRole('cell', { name: 'delete-target-17', exact: true })
        .click({ modifiers: ['Shift'] })
      await expectSelectedRows(page, [5, 17])
      await expect(selectAll).toBeChecked()
      await expect(grid(page).getByRole('checkbox', { name: 'Select row 5', exact: true })).toBeChecked()
      await expect(grid(page).getByRole('checkbox', { name: 'Select row 17', exact: true })).toBeChecked()
      await expect(page.locator('.grid-selection-bar:visible')).toContainText('2 rows selected')
      await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
      let review = page.getByRole('dialog', { name: 'Delete 2 selected rows?', exact: true })
      await expect(review).toContainText('id=5')
      await expect(review).toContainText('id=17')
      await expect(review).toContainText(profile.name)
      await review.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await ids()).toEqual(Array.from({ length: 60 }, (_, index) => index + 1))
      await expect(selectAll).toBeChecked()
      await expect(page.locator('.grid-selection-bar:visible')).toContainText('2 rows selected')
      await mkdir('/tmp/harbor-db-e2e', { recursive: true })
      await page.screenshot({ path: `/tmp/harbor-db-e2e/table-workbench-${engine}.png` })
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700),
      )
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeVisible()
      await page.screenshot({ path: `/tmp/harbor-db-e2e/table-workbench-${engine}-compact.png` })
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
      )
      await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
      review = page.getByRole('dialog', { name: 'Delete 2 selected rows?', exact: true })
      await review.getByRole('button', { name: 'Delete 2 rows', exact: true }).click()
      await expect(review).toHaveCount(0)
      await expect
        .poll(ids)
        .toEqual(Array.from({ length: 60 }, (_, index) => index + 1).filter((id) => ![5, 17].includes(id)))
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()

      await tree(page, profile).getByRole('button', { name: noKey, exact: true }).click()
      await expect(grid(page).getByRole('cell', { name: 'no key record', exact: true })).toBeVisible()
      await grid(page).getByRole('checkbox', { name: 'Select row 1', exact: true }).check()
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
      await expect(page.getByText('Read-only · no reliable primary key', { exact: true })).toBeVisible()
      await connect(page, readOnly)
      await tree(page, readOnly).getByRole('button', { name: table, exact: true }).click()
      await expect(grid(page).getByRole('cell', { name: 'row-001', exact: true })).toBeVisible()
      await grid(page).getByRole('checkbox', { name: 'Select row 1', exact: true }).check()
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
      await expect(page.getByText('Read-only safeguard', { exact: true })).toBeVisible()
      expect(pageErrors).toEqual([])
      expect(consoleErrors).toEqual([])
    } finally {
      if (desktop) {
        await desktop.close()
      }
      if (pg) {
        try {
          await pg.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`)
        } finally {
          await pg.end()
        }
      }
      if (maria) {
        try {
          await maria.query(`DROP TABLE IF EXISTS ${target}, ${noKeyTarget}`)
        } finally {
          await maria.end()
        }
      }
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
