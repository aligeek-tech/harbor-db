import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BSON, MongoClient } from 'mongodb'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')
test('MongoDB browser sorts, queries, saves drafts and reviews document writes', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires local MongoDB fixture.')
  const database = `harbor_ui_${randomUUID().replaceAll('-', '')}`
  const userData = await mkdtemp(join(tmpdir(), 'harbor-mongo-ui-'))
  const control = new MongoClient('mongodb://127.0.0.1:17017', {
    auth: { username: 'harbor', password: 'harbor_test' },
    authSource: 'admin',
  })
  await control.connect()
  const records = control.db(database).collection('records')
  await records.insertMany([
    {
      label: 'Alpha',
      score: 1,
      date: new Date('2026-01-01'),
      large: BSON.Long.fromString('9223372036854775807'),
    },
    { label: 'Zulu', score: 99 },
  ])
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'Local MongoDB fixture',
    engine: 'mongodb',
    host: '127.0.0.1',
    port: 17017,
    username: 'harbor',
    database,
    readOnly: false,
  })
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
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await waitForElectronWorkspace(page)
    await page.evaluate(async (profile) => {
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
        settings: { ...state.workspace.settings, theme: 'dark' },
      })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page).toHaveTitle('Harbor DB')
    expect(page.url()).toMatch(/^file:.*out\/renderer\/index\.html$/)
    await inspectElectronSandbox(desktop, page)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await page.locator('.mongo-collections').getByRole('button', { name: 'records', exact: true }).click()
    const grid = page.locator('.mongo-workspace .table-scroll')
    await expect(grid.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible()
    await grid.getByRole('button', { name: 'Sort score descending', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]').first()).toContainText('Zulu')
    await grid.getByRole('button', { name: 'Sort score ascending', exact: true }).click()
    await expect(grid.locator('tbody tr[aria-rowindex]').first()).toContainText('Alpha')
    await grid.getByRole('cell', { name: 'Alpha', exact: true }).dblclick()
    const editor = page.getByLabel('MongoDB document', { exact: true })
    const document = JSON.parse(await editor.inputValue())
    expect(document.large.$numberLong).toBe('9223372036854775807')
    document.label = 'Edited Alpha'
    await editor.fill(JSON.stringify(document, null, 2))
    await page.screenshot({ path: '/tmp/harbor-db-e2e/mongodb-document.png' })
    await page.getByRole('button', { name: 'Save document', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Replace this document?', exact: true })
      .getByRole('button', { name: 'Apply document', exact: true })
      .click()
    await expect(grid.getByRole('cell', { name: 'Edited Alpha', exact: true })).toBeVisible()
    expect((await records.findOne({ label: 'Edited Alpha' }))?.large.toString()).toBe('9223372036854775807')
    await page.getByRole('button', { name: 'Insert document', exact: true }).click()
    await editor.fill('{"label":"New document","score":50}')
    await page.getByRole('button', { name: 'Save document', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Insert this document?', exact: true })
      .getByRole('button', { name: 'Apply document', exact: true })
      .click()
    await expect(grid.getByRole('cell', { name: 'New document', exact: true })).toBeVisible()
    await grid.getByRole('cell', { name: 'New document', exact: true }).dblclick()
    await page
      .getByRole('dialog', { name: 'Edit document', exact: true })
      .getByRole('button', { name: 'Delete document', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Delete this document?', exact: true })
      .getByRole('button', { name: 'Delete document', exact: true })
      .click()
    await expect(grid.getByRole('cell', { name: 'New document', exact: true })).toHaveCount(0)
    expect(await records.countDocuments()).toBe(2)
    const query = page.getByLabel('MongoDB query', { exact: true }).filter({ visible: true })
    await query.fill('{"score":{"$gte":90}}')
    await query.press('ControlOrMeta+Enter')
    await expect(grid.getByRole('cell', { name: 'Zulu', exact: true })).toBeVisible()
    await expect(grid.getByRole('cell', { name: 'Edited Alpha', exact: true })).toHaveCount(0)
    await page
      .getByLabel('MongoDB query mode', { exact: true })
      .filter({ visible: true })
      .selectOption('aggregate')
    await query.fill('[{"$group":{"_id":null,"total":{"$sum":1}}}]')
    await page.getByRole('button', { name: 'Run query', exact: true }).filter({ visible: true }).click()
    await expect(
      page.getByText('Aggregation results are read-only', { exact: true }).filter({ visible: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Save query', exact: true }).click()
    const save = page.getByRole('dialog', { name: 'Save query', exact: true })
    await save.getByRole('textbox').fill('MongoDB count')
    await save.getByRole('button', { name: 'Save query', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await window.harbor.bootstrap()).savedQueries.some(
            (q) => q.name === 'MongoDB count' && q.collection === 'records' && q.mongoMode === 'aggregate',
          ),
        ),
      )
      .toBe(true)
    await page.getByRole('button', { name: /Saved queries/ }).click()
    await page
      .getByRole('button', { name: 'Open saved query MongoDB count without executing', exact: true })
      .click()
    await expect(
      page.getByLabel('MongoDB collection', { exact: true }).filter({ visible: true }),
    ).toHaveValue('records')
    await expect(
      page.getByLabel('MongoDB query mode', { exact: true }).filter({ visible: true }),
    ).toHaveValue('aggregate')
    await page.getByRole('button', { name: 'Run query', exact: true }).filter({ visible: true }).click()
    await expect(
      page.getByText('Aggregation results are read-only', { exact: true }).filter({ visible: true }),
    ).toBeVisible()
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/mongodb-dark.png' })
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700))
    await expect(
      page.getByRole('button', { name: 'Run query', exact: true }).filter({ visible: true }),
    ).toBeVisible()
    await page.screenshot({ path: '/tmp/harbor-db-e2e/mongodb-compact.png' })
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox', { name: 'Search actions and database objects' }).fill('Switch light')
    await page.getByRole('option', { name: /Switch light/ }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page.getByLabel('MongoDB database', { exact: true }).filter({ visible: true })).toHaveCSS(
      'color',
      'rgb(32, 41, 56)',
    )
    await page.screenshot({ path: '/tmp/harbor-db-e2e/mongodb-light-compact.png' })
    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(connection, 'MongoDB')
    await connection.getByText('Use a connection URL', { exact: true }).click()
    await connection
      .getByLabel('Connection URL', { exact: true })
      .fill(`mongodb://harbor:harbor_test@127.0.0.1:17017/${database}?authSource=admin`)
    await connection.getByRole('button', { name: 'Parse', exact: true }).click()
    await connection.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(connection.getByRole('status')).toContainText('Connection successful')
    await page.screenshot({ path: '/tmp/harbor-db-e2e/mongodb-connection.png' })
    await page.keyboard.press('Escape')
    await expect(connection).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await desktop.close()
    await control.db(database).dropDatabase()
    await control.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
