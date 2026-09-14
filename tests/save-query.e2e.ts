import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')
async function typeSql(page: Page, sql: string) {
  const editor = page.locator('.monaco-editor:visible textarea').first()
  await editor.focus()
  await editor.press('ControlOrMeta+Home')
  await editor.press('ControlOrMeta+Shift+End')
  await editor.pressSequentially(sql)
  return editor
}
async function finishSave(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Save query', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Save query', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('table and ordinary SQL save, reopen without execution, survive restart, and show readable Run shortcuts', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated PostgreSQL development service.')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-save-query-'))
  const schema = `save_query_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'Saved SQL regression',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 15432,
    username: 'harbor',
    database: 'harbor',
    schema,
    readOnly: true,
  })
  const tableName = 'Saved table SQL'
  const ordinaryName = 'Saved ordinary SQL'
  const ordinarySql = "SELECT 'saved ordinary query' AS marker, 42 AS answer;"
  const pg = new Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'harbor',
    password: 'harbor_test',
    database: 'harbor',
  })
  let connected = false
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  async function launch() {
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
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.waitForFunction(() => !!window.harbor)
    await expect(page).toHaveTitle('Harbor DB')
    await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await inspectElectronSandbox(desktop, page)
    return page
  }
  try {
    await pg.connect()
    connected = true
    await pg.query(`CREATE SCHEMA "${schema}"`)
    await pg.query(`CREATE TABLE "${schema}".records (id INT PRIMARY KEY, label TEXT)`)
    await pg.query(`INSERT INTO "${schema}".records VALUES (1, 'saved fixture row')`)
    let page = await launch()
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
        expanded: [],
        settings: { ...state.workspace.settings, theme: 'light', editorHeight: 220 },
      })
    }, profile)
    await page.reload()
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    const tree = page.getByRole('button', { name: profile.name, exact: true }).locator('..').locator('..')
    await tree.getByRole('button', { name: 'records', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: 'saved fixture row', exact: true }),
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
            (tab) => tab.kind === 'table',
          )?.sql,
      )
      .toContain(`"${schema}"."records"`)
    const before = await page.evaluate(() => window.harbor.bootstrap())
    const tableSql = before.workspace.tabs.find((tab) => tab.kind === 'table')!.sql
    const historyIds = before.history.map((entry) => entry.id)
    await page.getByRole('button', { name: 'Save query · Ctrl+S', exact: true }).click()
    await finishSave(page, tableName)
    await expect(
      page.getByRole('tab').filter({ has: page.getByText('records', { exact: true }) }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
        (tab) => tab.kind === 'table',
      )?.title,
    ).toBe('records')
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.harbor.bootstrap())).savedQueries.map((query) => ({
          name: query.name,
          sql: query.sql,
          connectionId: query.connectionId,
        })),
      )
      .toContainEqual({ name: tableName, sql: tableSql, connectionId: profile.id })

    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const editor = await typeSql(page, ordinarySql)
    await editor.press('ControlOrMeta+s')
    await finishSave(page, ordinaryName)
    const saved = await page.evaluate(() => window.harbor.bootstrap())
    expect(saved.savedQueries).toHaveLength(2)
    expect(saved.savedQueries.find((query) => query.name === ordinaryName)).toMatchObject({
      sql: ordinarySql,
      connectionId: profile.id,
      engine: 'postgres',
    })
    expect(saved.history.map((entry) => entry.id)).toEqual(historyIds)

    for (const [name, sql] of [
      [tableName, tableSql],
      [ordinaryName, ordinarySql],
    ]) {
      await page.getByRole('button', { name: /^Saved queries/ }).click()
      await page
        .getByRole('button', { name: `Open saved query ${name} without executing`, exact: true })
        .click()
      await expect(page.getByRole('heading', { name: 'Ready when you are', exact: true })).toBeVisible()
      await expect(page.locator('.context-target')).toHaveText(profile.name)
      await expect
        .poll(async () => {
          const state = await page.evaluate(() => window.harbor.bootstrap())
          return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)?.sql
        })
        .toBe(sql)
      expect((await page.evaluate(() => window.harbor.bootstrap())).history.map((entry) => entry.id)).toEqual(
        historyIds,
      )
    }

    const contrast: Array<Record<string, unknown>> = []
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
      await page.getByLabel(theme === 'dark' ? 'Dark theme' : 'Light theme', { exact: true }).click()
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
      for (const width of [1440, 1024]) {
        await desktop!.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]!.setContentSize(width, width === 1440 ? 900 : 700),
          width,
        )
        const run = page
          .locator('.editor-region:visible')
          .getByRole('button', { name: /^Run(?: Ctrl Enter)?$/ })
        await expect(run).toBeEnabled()
        await expect(run).toBeVisible()
        const kbd = run.locator('kbd')
        if (width === 1440) await expect(kbd).toBeVisible()
        else await expect(kbd).toBeHidden()
        for (const hovered of [false, true]) {
          if (hovered) await run.hover()
          else await page.locator('.brand').hover()
          const metrics = await run.evaluate((button, useShortcut) => {
            const element = useShortcut ? button.querySelector('kbd')! : button
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const context = canvas.getContext('2d', { willReadFrequently: true })!
            const color = (css: string) => {
              context.clearRect(0, 0, 1, 1)
              context.fillStyle = css
              context.fillRect(0, 0, 1, 1)
              return Array.from(context.getImageData(0, 0, 1, 1).data).map((value, index) =>
                index === 3 ? value / 255 : value,
              )
            }
            const composite = (top: number[], bottom: number[]) =>
              top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]))
            const ancestors: Element[] = []
            for (let node: Element | null = element; node; node = node.parentElement) ancestors.push(node)
            let background = [255, 255, 255]
            for (const node of ancestors.reverse())
              background = composite(color(getComputedStyle(node).backgroundColor), background)
            const style = getComputedStyle(element)
            const foreground = composite(color(style.color), background)
            const luminance = (rgb: number[]) =>
              rgb
                .map((value) => {
                  const channel = value / 255
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
                })
                .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
            const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
            return {
              foreground,
              background,
              ratio: (levels[0] + 0.05) / (levels[1] + 0.05),
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              target: useShortcut ? 'Ctrl Enter shortcut' : 'Run label; shortcut hidden by compact layout',
            }
          }, width === 1440)
          expect(
            metrics.ratio,
            `${theme} ${width}px ${hovered ? 'hover' : 'normal'} contrast`,
          ).toBeGreaterThanOrEqual(4.5)
          contrast.push({ theme, width, hovered, ...metrics })
          await page.screenshot({
            path: `/tmp/harbor-db-e2e/run-shortcut-${theme}-${width}${hovered ? '-hover' : ''}.png`,
          })
        }
      }
    }
    await writeFile('/tmp/harbor-db-e2e/run-shortcut-contrast.json', JSON.stringify(contrast, null, 2))
    await desktop!.close()
    desktop = undefined
    page = await launch()
    const restored = await page.evaluate(() => window.harbor.bootstrap())
    expect(
      restored.savedQueries.map((query) => ({
        name: query.name,
        sql: query.sql,
        connectionId: query.connectionId,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: tableName, sql: tableSql, connectionId: profile.id },
        { name: ordinaryName, sql: ordinarySql, connectionId: profile.id },
      ]),
    )
    expect(restored.history.map((entry) => entry.id)).toEqual(historyIds)
    await page.getByRole('button', { name: /^Saved queries/ }).click()
    await expect(
      page.getByRole('button', { name: `Open saved query ${tableName} without executing`, exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: `Open saved query ${ordinaryName} without executing`, exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Ready when you are', exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('saved ordinary query')
    expect((await page.evaluate(() => window.harbor.bootstrap())).history.map((entry) => entry.id)).toEqual(
      historyIds,
    )
    expect((await pg.query(`SELECT * FROM "${schema}".records`)).rows).toEqual([
      { id: 1, label: 'saved fixture row' },
    ])
    expect(errors).toEqual([])
  } finally {
    if (desktop) {
      const closed = desktop.waitForEvent('close')
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => desktop?.process().kill('SIGTERM'))
      await closed
    }
    if (connected) {
      try {
        await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await pg.end()
      }
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
