import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

test('Timescale hypertables and continuous aggregates remain visible while extension internals stay hidden and user routines are paged', async () => {
  test.skip(process.env.HARBOR_TIMESCALE !== '1', 'Requires the isolated PostgreSQL 17 Timescale fixture.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-timescale-ui-'))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const databases = [`ts_ui_alpha_${suffix}`, `ts_ui_beta_${suffix}`]
  const markers = ['hypertable in alpha database', 'hypertable in beta database']
  const credentials = {
    host: '127.0.0.1',
    port: Number(process.env.HARBOR_TIMESCALE_PORT || 15433),
    user: 'harbor',
    password: 'harbor_test',
  }
  const server = profileSchema.parse({
    id: randomUUID(),
    name: 'Timescale server fixture',
    engine: 'postgres',
    host: credentials.host,
    port: credentials.port,
    username: credentials.user,
    database: '',
    schema: 'telemetry',
    environment: 'development',
    readOnly: true,
  })
  const fixed = {
    ...server,
    id: randomUUID(),
    name: 'Timescale fixed database fixture',
    database: databases[0],
  }
  const admin = new Client({ ...credentials, database: 'harbor' })
  const created: string[] = []
  let connected = false
  let desktop: ElectronApplication | undefined
  try {
    await admin.connect()
    connected = true
    for (const [index, database] of databases.entries()) {
      await admin.query(`CREATE DATABASE "${database}"`)
      created.push(database)
      const client = new Client({ ...credentials, database })
      try {
        await client.connect()
        await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb')
        await client.query('CREATE SCHEMA telemetry')
        await client.query(`CREATE TABLE telemetry.z_hypertable (
          time timestamptz NOT NULL, device integer NOT NULL, marker text NOT NULL, value integer,
          PRIMARY KEY (time, device)
        )`)
        await client.query("SELECT create_hypertable('telemetry.z_hypertable', by_range('time'))")
        await client.query(
          "INSERT INTO telemetry.z_hypertable VALUES ('2026-01-01T00:00:00Z', 1, $1, 7), ('2026-01-01T00:10:00Z', 2, $1, 8)",
          [markers[index]],
        )
        await client.query(`CREATE MATERIALIZED VIEW telemetry.z_hourly
          WITH (timescaledb.continuous) AS
          SELECT time_bucket('1 hour', time) AS bucket, marker, count(*) AS samples, sum(value) AS total
          FROM telemetry.z_hypertable GROUP BY bucket, marker WITH NO DATA`)
        await client.query("CALL refresh_continuous_aggregate('telemetry.z_hourly', NULL, NULL)")
        await client.query(
          'CREATE FUNCTION public.user_helper() RETURNS integer LANGUAGE sql AS $$ SELECT 42 $$',
        )
        if (index === 0) {
          // An alphabetic-only 300-object cap previously hid the z_* relations.
          // Keep every routine a user object, so filtering extension members alone
          // cannot make this test pass without priority ordering and pagination.
          await client.query(`DO $$ BEGIN FOR i IN 0..304 LOOP
            EXECUTE format('CREATE FUNCTION telemetry.%I() RETURNS integer LANGUAGE sql AS %L',
              'a_user_fn_' || lpad(i::text, 3, '0'), 'SELECT ' || i);
          END LOOP; END $$`)
        }
        const catalog = await client.query(`SELECT
          (SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_schema='telemetry')::int AS hypertables,
          (SELECT count(*) FROM timescaledb_information.continuous_aggregates WHERE view_schema='telemetry')::int AS aggregates,
          (SELECT count(*) FROM pg_proc p JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
           JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='timescaledb')::int AS extension_functions`)
        expect(catalog.rows[0].hypertables).toBe(1)
        expect(catalog.rows[0].aggregates).toBe(1)
        expect(catalog.rows[0].extension_functions).toBeGreaterThan(20)
      } finally {
        await client.end()
      }
    }

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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
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
          settings: { ...state.workspace.settings, theme: 'dark', sidebarWidth: 360, editorHeight: 180 },
        })
      },
      [server, fixed],
    )
    await page.reload()
    await expect(page).toHaveTitle('Harbor DB')
    expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html$/)
    await expect(page.getByText('Harbor DB', { exact: true }).first()).toBeVisible()
    await expect(page.locator('.statusbar .status-item').first()).toContainText(
      (await page.evaluate(() => window.harbor.bootstrap())).version,
    )
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await inspectElectronSandbox(desktop, page)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    const serverButton = page.getByRole('button', { name: server.name, exact: true })
    const serverTree = serverButton.locator('..').locator('..')
    await serverButton.dblclick()
    await expect(page.getByLabel(`${server.name}: connected`, { exact: true })).toBeVisible()

    for (const [index, database] of databases.entries()) {
      await serverTree.getByRole('button', { name: `Expand database ${database}`, exact: true }).click()
      const databaseTree = serverTree.locator(`[data-database="${database}"]`)
      await databaseTree
        .getByRole('button', { name: `Expand schema telemetry in ${database}`, exact: true })
        .click()
      const telemetry = databaseTree.locator('[data-schema="telemetry"]')
      await expect(telemetry.getByRole('button', { name: 'z_hypertable', exact: true })).toBeVisible()
      await expect(telemetry.getByRole('button', { name: 'z_hourly', exact: true })).toBeVisible()
      if (index === 0) {
        const rows = telemetry.locator('.connection-row > button.object-row')
        expect(
          (await rows.allTextContents())
            .slice(0, 2)
            .map((name) => name.trim())
            .sort(),
        ).toEqual(['z_hourly', 'z_hypertable'])
        await expect(telemetry.getByRole('button', { name: 'a_user_fn_304', exact: true })).toHaveCount(0)
        await telemetry
          .getByRole('button', { name: new RegExp(`^Show \\d+ more objects in ${database}\\.telemetry$`) })
          .click()
        await expect(telemetry.getByRole('button', { name: 'a_user_fn_304', exact: true })).toBeVisible()
      }
      for (const table of ['z_hypertable', 'z_hourly']) {
        await telemetry.getByRole('button', { name: table, exact: true }).click()
        const grid = page.locator('.table-scroll:visible')
        await expect(grid.getByRole('cell', { name: markers[index], exact: true }).first()).toBeVisible()
        await expect(grid.getByRole('cell', { name: markers[1 - index], exact: true })).toHaveCount(0)
        await expect(page.locator('.context-bar')).toContainText(database)
        if (table === 'z_hypertable') {
          await expect(
            page.getByText('Unsorted preview · row order may change', { exact: true }),
          ).toBeVisible()
          await grid.getByRole('button', { name: 'time', exact: true }).click()
          await expect(
            page.getByText('Unsorted preview · row order may change', { exact: true }),
          ).toHaveCount(0)
          await expect(grid.getByRole('cell', { name: markers[index], exact: true }).first()).toBeVisible()
        }
        await expect
          .poll(async () => {
            const state = await page.evaluate(() => window.harbor.bootstrap())
            return state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
          })
          .toMatchObject({ connectionId: server.id, database, schema: 'telemetry', table })
      }
      await databaseTree
        .getByRole('button', { name: `Expand schema public in ${database}`, exact: true })
        .click()
      await expect(databaseTree.getByRole('button', { name: 'user_helper', exact: true })).toBeVisible()
      for (const helper of ['create_hypertable', 'time_bucket', 'drop_chunks'])
        await expect(databaseTree.getByRole('button', { name: helper, exact: true })).toHaveCount(0)
      await expect(
        databaseTree.locator('[data-schema^="_timescaledb"], [data-schema="timescaledb_information"]'),
      ).toHaveCount(0)
      await expect(databaseTree.getByRole('alert')).toHaveCount(0)
      if (index === 0)
        await serverTree.getByRole('button', { name: `Collapse database ${database}`, exact: true }).click()
    }
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/timescale-server-explorer.png' })

    await page.getByRole('button', { name: `Collapse ${server.name}`, exact: true }).click()
    const fixedButton = page.getByRole('button', { name: fixed.name, exact: true })
    const fixedTree = fixedButton.locator('..').locator('..')
    await fixedButton.dblclick()
    await expect(page.getByLabel(`${fixed.name}: connected`, { exact: true })).toBeVisible()
    const fixedSchema = fixedTree.getByRole('button', { name: /^telemetry \d+$/ })
    await expect(fixedSchema).toBeVisible()
    if ((await fixedSchema.getAttribute('aria-expanded')) !== 'true') await fixedSchema.click()
    const telemetry = fixedSchema.locator('..')
    await expect(telemetry.getByRole('button', { name: 'z_hypertable', exact: true })).toBeVisible()
    await expect(telemetry.getByRole('button', { name: 'z_hourly', exact: true })).toBeVisible()
    await expect(telemetry.getByRole('button', { name: 'a_user_fn_304', exact: true })).toHaveCount(0)
    await telemetry
      .getByRole('button', { name: new RegExp(`^Show \\d+ more objects in ${databases[0]}\\.telemetry$`) })
      .click()
    await expect(telemetry.getByRole('button', { name: 'a_user_fn_304', exact: true })).toBeVisible()
    await telemetry.getByRole('button', { name: 'z_hypertable', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: markers[0], exact: true }).first(),
    ).toBeVisible()
    await expect(page.locator('.context-target')).toHaveText(fixed.name)
    await expect(page.locator('.context-bar')).toContainText(databases[0])
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(state.profiles.find((profile) => profile.id === server.id)?.database).toBe('')
    expect(state.profiles.find((profile) => profile.id === fixed.id)?.database).toBe(databases[0])
    expect(
      state.workspace.tabs.filter((tab) => tab.connectionId === server.id && tab.kind === 'table'),
    ).toHaveLength(4)
    expect(errors).toEqual([])
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10000 })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/timescale-fixed-explorer.png' })
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700))
    const previewLabel = page.getByText('Unsorted preview · row order may change', { exact: true })
    await expect(previewLabel).toBeVisible()
    const labelBounds = await previewLabel.boundingBox()
    expect(labelBounds!.y + labelBounds!.height).toBeLessThanOrEqual(700)
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeVisible()
    await page.screenshot({ path: '/tmp/harbor-db-e2e/timescale-preview-compact.png' })
  } finally {
    if (desktop) {
      await desktop.close()
    }
    if (connected) {
      try {
        for (const database of created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    }
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
