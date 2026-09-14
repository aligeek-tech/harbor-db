import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import mariadb, { type Connection } from 'mariadb'
import { profileSchema, tabSchema, type ConnectionProfile } from '../src/shared/contracts'

const root = resolve(import.meta.dirname, '..')
const fixture = `ui_${randomUUID().replaceAll('-', '').slice(0, 16)}`
const mariaTable = `${fixture}_records`
const password = 'harbor_test'
const targetQuery = "SELECT version() AS engine_name, 'syntax' AS literal_text;"
const pgProfile = profileSchema.parse({
  id: `${fixture}-pg`,
  name: 'UI PostgreSQL',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 15432,
  username: 'harbor',
  database: 'harbor',
  schema: fixture,
  readOnly: false,
})
const mariaProfile = profileSchema.parse({
  id: `${fixture}-maria`,
  name: 'UI MariaDB',
  engine: 'mariadb',
  host: '127.0.0.1',
  port: 13306,
  username: 'harbor',
  database: 'harbor',
  schema: 'harbor',
  readOnly: false,
})
const readOnlyProfile = profileSchema.parse({
  ...pgProfile,
  id: `${fixture}-read`,
  name: 'UI Read Only',
  readOnly: true,
})
const profiles = [pgProfile, mariaProfile, readOnlyProfile]
let pg: Client
let maria: Connection
let desktop: ElectronApplication | undefined
let page: Page
let userData: string
let pageErrors: string[]

function connectionTree(profile: ConnectionProfile) {
  return page.getByRole('button', { name: profile.name, exact: true }).locator('..').locator('..')
}
function grid() {
  return page.locator('.table-scroll:visible')
}
async function expectSyntax(language: string) {
  await expect(page.locator('[data-mode-id]:visible')).toHaveAttribute('data-mode-id', language)
  await expect
    .poll(() =>
      page
        .locator('.monaco-editor:visible .view-line span')
        .evaluateAll(
          (spans) =>
            new Set(
              spans
                .filter((span) => span.childElementCount === 0 && span.textContent?.trim())
                .map((span) => getComputedStyle(span).color),
            ).size,
        ),
    )
    .toBeGreaterThan(1)
  const dark = await page.locator('html').evaluate((html) => html.classList.contains('dark'))
  await expect(
    page.locator('.monaco-editor:visible .view-lines').getByText("'syntax'", { exact: true }),
  ).toHaveCSS('color', dark ? 'rgb(141, 206, 181)' : 'rgb(38, 113, 90)')
}
function tableTab(profile: ConnectionProfile, table: string) {
  return page
    .getByRole('tab')
    .filter({ has: page.getByText(table, { exact: true }) })
    .and(
      page.getByTitle(
        `${table} · ${profile.name}${profile.engine === 'postgres' ? ` · ${profile.database}` : ''}`,
        { exact: true },
      ),
    )
}
async function connect(profile: ConnectionProfile) {
  await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
  await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
}
async function openTable(profile: ConnectionProfile, table: string) {
  await connectionTree(profile).getByRole('button', { name: table, exact: true }).click()
  await expect(tableTab(profile, table)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
}
async function stageLabel(before: string, after: string) {
  await grid().getByRole('cell', { name: before, exact: true }).dblclick()
  await expect(page.getByRole('dialog', { name: 'Edit label', exact: true })).toBeVisible()
  await page.getByLabel('Cell value', { exact: true }).fill(after)
  await page.getByRole('button', { name: 'Stage change', exact: true }).click()
  await expect(page.locator('.pending-bar:visible')).toContainText('1 changes ready to apply')
  await expect(grid().getByRole('cell', { name: after, exact: true })).toBeVisible()
}
async function apply() {
  await page.getByRole('button', { name: 'Review & apply', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply changes', exact: true }).click()
  await expect(page.locator('.pending-bar:visible')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
}

test.describe('real SQL editing in Electron', () => {
  test.skip(
    process.env.HARBOR_INTEGRATION !== '1',
    'Set HARBOR_INTEGRATION=1 with development PostgreSQL and MariaDB running.',
  )
  test.beforeAll(async () => {
    pg = new Client({ host: '127.0.0.1', port: 15432, database: 'harbor', user: 'harbor', password })
    await pg.connect()
    maria = await mariadb.createConnection({
      host: '127.0.0.1',
      port: 13306,
      database: 'harbor',
      user: 'harbor',
      password,
    })
    // Fixture identifiers contain only a fixed prefix and generated hexadecimal digits.
    await pg.query(`CREATE SCHEMA "${fixture}"`)
    await pg.query(
      `CREATE TABLE "${fixture}".records (id integer PRIMARY KEY, label varchar(200) NOT NULL, amount numeric(30,9) NOT NULL, data bytea, note text)`,
    )
    await pg.query(
      `CREATE TABLE "${fixture}".imports (id integer PRIMARY KEY, label varchar(200) NOT NULL, note text)`,
    )
    await maria.query(
      `CREATE TABLE \`${mariaTable}\` (id integer PRIMARY KEY, label varchar(200) NOT NULL, amount decimal(30,9) NOT NULL, data blob, note text) ENGINE=InnoDB`,
    )
  })
  test.afterAll(async () => {
    if (pg) {
      await pg.query(`DROP SCHEMA IF EXISTS "${fixture}" CASCADE`)
      await pg.end()
    }
    if (maria) {
      await maria.query(`DROP TABLE IF EXISTS \`${mariaTable}\``)
      await maria.end()
    }
  })
  test.beforeEach(async () => {
    await pg.query(`TRUNCATE "${fixture}".records, "${fixture}".imports`)
    await pg.query(
      `INSERT INTO "${fixture}".records VALUES (1, 'postgres-original', 9007199254740993.123456789, $1, NULL), (2, 'second record', 12.500000000, NULL, '')`,
      [Buffer.from([0, 255, 128])],
    )
    await maria.query(`DELETE FROM \`${mariaTable}\``)
    await maria.query(
      `INSERT INTO \`${mariaTable}\` VALUES (1, 'maria-original', 9007199254740993.123456789, ?, NULL)`,
      [Buffer.from([0, 255, 128])],
    )
    userData = await mkdtemp(join(tmpdir(), 'harbor-sql-ui-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    )
    desktop = await _electron.launch({
      args: [root],
      cwd: root,
      chromiumSandbox: true,
      env: { ...env, HARBOR_USER_DATA: userData },
      timeout: 30000,
    })
    page = await desktop.firstWindow()
    pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForFunction(() => !!window.harbor)
    await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
    const drafts = [
      tabSchema.parse({
        id: `${fixture}-query-pg`,
        connectionId: pgProfile.id,
        title: 'PostgreSQL target',
        kind: 'query',
        sql: targetQuery,
      }),
      tabSchema.parse({
        id: `${fixture}-query-maria`,
        connectionId: mariaProfile.id,
        title: 'MariaDB target',
        kind: 'query',
        sql: targetQuery,
      }),
    ]
    // Set up persisted profiles and draft documents via the real validated bridge. All
    // operations being tested below are actual pointer/keyboard UI interactions.
    await page.evaluate(
      async ({ profiles, password, drafts }) => {
        for (const profile of profiles)
          await window.harbor.saveProfile({ profile, secrets: { password }, rememberPassword: false })
        const state = await window.harbor.bootstrap()
        await window.harbor.saveWorkspace({
          ...state.workspace,
          tabs: drafts,
          activeTabId: drafts[0]!.id,
          expanded: [],
        })
      },
      { profiles, password, drafts },
    )
    await page.reload()
    await expect(page.getByRole('button', { name: pgProfile.name, exact: true })).toBeVisible()
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
  })
  test.afterEach(async () => {
    if (desktop) {
      // Exit the isolated test process even after an assertion leaves staged edits.
      // This cannot affect the user's ordinary Harbor profile or other E2E processes.
      const closed = desktop.waitForEvent('close')
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => desktop?.process().kill('SIGTERM'))
      await closed
      desktop = undefined
    }
    if (userData) await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('stage, preserve, discard and commit PostgreSQL and MariaDB edits; inspect structure and read-only data', async () => {
    const testInfo = test.info()
    await connect(pgProfile)
    await connect(mariaProfile)
    await openTable(pgProfile, 'records')
    await expect(grid().getByRole('cell', { name: '9007199254740993.123456789', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Structure', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Table structure', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: '⌘ id', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'bytea', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Data', exact: true }).click()
    await stageLabel('postgres-original', 'staged across navigation')
    await page.getByRole('button', { name: /^Saved queries/ }).click()
    await page.getByRole('tab').filter({ hasText: 'PostgreSQL target' }).click()
    await page.getByRole('button', { name: mariaProfile.name, exact: true }).click()
    await tableTab(pgProfile, 'records').click()
    await expect(page.locator('.context-target')).toHaveText(pgProfile.name)
    await expect(grid().getByRole('cell', { name: 'staged across navigation', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.pending-bar:visible')).toContainText('1 changes ready to apply')
    expect((await pg.query(`SELECT label FROM "${fixture}".records WHERE id=1`)).rows[0].label).toBe(
      'postgres-original',
    )
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(grid().getByRole('cell', { name: 'postgres-original', exact: true })).toBeVisible()
    await stageLabel('postgres-original', 'postgres-applied')
    await apply()
    expect((await pg.query(`SELECT label FROM "${fixture}".records WHERE id=1`)).rows[0].label).toBe(
      'postgres-applied',
    )

    await grid().getByRole('cell', { name: '0x00ff80', exact: true }).dblclick()
    await expect(page.getByLabel('Cell value', { exact: true })).toHaveValue('AP+A')
    await page.getByLabel('Cell value', { exact: true }).fill('AP+B')
    await page.getByRole('button', { name: 'Stage change', exact: true }).click()
    await apply()
    expect((await pg.query(`SELECT data FROM "${fixture}".records WHERE id=1`)).rows[0].data).toEqual(
      Buffer.from([0, 255, 129]),
    )
    await page.getByRole('button', { name: 'Count rows', exact: true }).click()
    await expect(page.getByText('Exact total: 2', { exact: true })).toBeVisible()
    await expect(grid().getByRole('cell', { name: 'postgres-applied', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('sql-table-edits.png') })

    await openTable(mariaProfile, mariaTable)
    await stageLabel('maria-original', 'maria-discarded')
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    expect((await maria.query(`SELECT label FROM \`${mariaTable}\` WHERE id=1`))[0].label).toBe(
      'maria-original',
    )
    await stageLabel('maria-original', 'maria-applied')
    await apply()
    expect((await maria.query(`SELECT label FROM \`${mariaTable}\` WHERE id=1`))[0].label).toBe(
      'maria-applied',
    )

    await connect(readOnlyProfile)
    await openTable(readOnlyProfile, 'records')
    await expect(page.getByText('Read-only safeguard', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Insert row', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import CSV', exact: true })).toHaveCount(0)
    await grid().getByRole('cell', { name: 'postgres-applied', exact: true }).dblclick()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test('map CSV columns, preserve NULL versus empty text, and roll back all rows on a conflict', async () => {
    const testInfo = test.info()
    await connect(pgProfile)
    await openTable(pgProfile, 'imports')
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click()
    await page
      .getByLabel('CSV text', { exact: true })
      .fill('record_name,record_id,note\n"csv one",101,\\N\n"csv two",102,""\n')
    await page.locator('#csv-map-0').selectOption('label')
    await page.locator('#csv-map-1').selectOption('id')
    await page.locator('#csv-map-2').selectOption('note')
    await expect(page.getByRole('button', { name: 'Review & import', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('csv-mapping-preview.png') })
    await page.getByRole('button', { name: 'Review & import', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Import 2 rows?', exact: true })
      .getByRole('button', { name: 'Import 2 rows', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(grid().getByRole('cell', { name: 'csv one', exact: true })).toBeVisible()
    expect((await pg.query(`SELECT id,label,note FROM "${fixture}".imports ORDER BY id`)).rows).toEqual([
      { id: 101, label: 'csv one', note: null },
      { id: 102, label: 'csv two', note: '' },
    ])

    await page.getByRole('button', { name: 'Import CSV', exact: true }).click()
    await page
      .getByLabel('CSV text', { exact: true })
      .fill('id,label\n103,must roll back\n101,duplicate key\n')
    await page.getByRole('button', { name: 'Review & import', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Import 2 rows?', exact: true })
      .getByRole('button', { name: 'Import 2 rows', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Import CSV into imports', exact: true })).toContainText(
      'duplicate key',
    )
    expect((await pg.query(`SELECT id FROM "${fixture}".imports ORDER BY id`)).rows).toEqual([
      { id: 101 },
      { id: 102 },
    ])
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(pageErrors).toEqual([])
  })

  test('sidebar selection cannot retarget an existing query tab to the other SQL engine', async () => {
    const testInfo = test.info()
    await connect(pgProfile)
    await connect(mariaProfile)
    await page.getByRole('tab').filter({ hasText: 'PostgreSQL target' }).click()
    await page.getByRole('button', { name: mariaProfile.name, exact: true }).click()
    await expect(page.locator('.context-target')).toHaveText(pgProfile.name)
    await expectSyntax('harbor-pgsql')
    await page.getByRole('button', { name: 'Run script', exact: true }).click()
    await expect(grid().getByRole('cell', { name: /^PostgreSQL 17/ })).toBeVisible()
    await expect(page.locator('.results-footer:visible')).not.toContainText('affected')
    await page.getByRole('tab').filter({ hasText: 'MariaDB target' }).click()
    await page.getByRole('button', { name: pgProfile.name, exact: true }).click()
    await expect(page.locator('.context-target')).toHaveText(mariaProfile.name)
    await expectSyntax('harbor-mysql')
    await page.getByRole('button', { name: 'Run script', exact: true }).click()
    await expect(grid().getByRole('cell', { name: /MariaDB/ })).toBeVisible()
    await expect(page.locator('.results-footer:visible')).not.toContainText('affected')
    const history = (await page.evaluate(() => window.harbor.bootstrap())).history.filter(
      (row) => row.sql === targetQuery,
    )
    expect(history.map((row) => row.connectionId).sort()).toEqual([pgProfile.id, mariaProfile.id].sort())
    await page.screenshot({ path: testInfo.outputPath('sql-query-target-context.png') })
    expect(pageErrors).toEqual([])
  })
})
