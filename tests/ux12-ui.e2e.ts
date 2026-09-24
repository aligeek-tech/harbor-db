import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

const root = resolve(import.meta.dirname, '..')

test('large catalog and wide large-value result remain responsive in the actual desktop UI', async () => {
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'harbor-ux12-ui-'))
  let desktop: ElectronApplication | undefined
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await _electron.launch({ chromiumSandbox: true, args: [root], cwd: root, env: { ...env, HARBOR_USER_DATA: userData } })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: 'ux12-wide-catalog', name: 'UX12 large catalog', engine: 'duckdb', host: '127.0.0.1', port: 1,
      schema: 'main', readOnly: false, duckdb: { path: join(userData, 'ux12.duckdb'), mode: 'open' },
    })
    await page.evaluate(async ({ value, batches }) => {
      await window.harbor.saveProfile({ profile: { ...value, duckdb: { ...value.duckdb!, mode: 'create' } }, rememberPassword: false })
      await window.harbor.connect({ id: value.id })
      const sessionId = crypto.randomUUID()
      try {
        for (const sql of batches)
          await window.harbor.query({ connectionId: value.id, sessionId, requestId: crypto.randomUUID(), sql, maxRows: 1, privateSession: true })
      } finally { await window.harbor.closeSession({ connectionId: value.id, sessionId }) }
      await window.harbor.disconnect(value.id)
      await window.harbor.saveProfile({ profile: value, rememberPassword: false })
    }, { value: profile, batches: Array.from({ length: 5 }, (_, batch) => Array.from({ length: 100 }, (_, offset) => { const index = batch * 100 + offset; return `CREATE TABLE catalog_${String(index).padStart(3, '0')} (id BIGINT, label VARCHAR);` }).join('\n')) })
    await page.reload(); await waitForElectronWorkspace(page)
    const catalogStarted = performance.now()
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
    const filter = page.getByPlaceholder('Filter connections & objects…', { exact: true })
    await filter.fill('catalog_499')
    await expect(page.getByRole('button', { name: 'catalog_499', exact: true })).toBeVisible()
    const catalogMs = performance.now() - catalogStarted
    expect(catalogMs).toBeLessThan(5_000)
    await filter.fill('')

    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    const columns = ["repeat('L', 65536) AS large_cell", ...Array.from({ length: 30 }, (_, index) => `repeat('w${index}', 128) AS wide_${index}`)]
    await typeSql(page, `SELECT ${columns.join(', ')} FROM range(200);`, true)
    await page.evaluate(() => {
      const state = { last: performance.now(), maxDelay: 0, ticks: 0, timer: 0 }
      state.timer = window.setInterval(() => { const now = performance.now(); state.maxDelay = Math.max(state.maxDelay, now - state.last - 10); state.last = now; state.ticks++ }, 10)
      ;(window as unknown as { __ux12?: typeof state }).__ux12 = state
    })
    const queryStarted = performance.now()
    await page.keyboard.press(shortcutKeys('run-current', shortcutPlatform(process.platform)))
    const footer = page.locator('.results-footer:visible')
    await expect(footer).toContainText('rows')
    const queryMs = performance.now() - queryStarted
    const responsiveness = await page.evaluate(() => {
      const state = (window as unknown as { __ux12: { timer: number; maxDelay: number; ticks: number } }).__ux12
      clearInterval(state.timer)
      return { maxDelay: state.maxDelay, ticks: state.ticks }
    })
    expect(queryMs).toBeLessThan(8_000)
    expect(responsiveness.ticks).toBeGreaterThan(0)
    expect(responsiveness.maxDelay).toBeLessThan(250)
    await expect(footer).toContainText('Display limit reached · execution semantics unchanged')
    const settingsStarted = performance.now()
    await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Make yourself at home', exact: true })).toBeVisible()
    expect(performance.now() - settingsStarted).toBeLessThan(1_000)
    console.log(JSON.stringify({ catalogMs: Math.round(catalogMs), queryMs: Math.round(queryMs), maxEventLoopDelayMs: Number(responsiveness.maxDelay.toFixed(2)), eventLoopTicks: responsiveness.ticks }))
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
