import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compatibleSqlPolicies, isCompatibleSqlEngine } from '../src/shared/compatible-sql'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'
import { typeSql } from './editor-input'

test('offline Redshift profile preserves deployment and expiry with visible query cost context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-redshift-offline-ui-'))
  let desktop: ElectronApplication | undefined
  try {
    const root = resolve(import.meta.dirname, '..')
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
    const profile = profileSchema.parse({
      id: 'redshift-offline',
      name: 'Offline warehouse',
      engine: 'redshift',
      host: 'unconfigured.example.invalid',
      port: 5439,
      username: 'db_reader',
      database: 'warehouse',
      tls: { enabled: true, rejectUnauthorized: true },
      redshift: {
        deployment: 'serverless',
        authentication: 'temporary-password',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    })
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({ profile, secrets: {}, rememberPassword: false })
      const state = await window.harbor.bootstrap()
      await window.harbor.saveWorkspace({
        ...state.workspace,
        tabs: [
          {
            id: 'redshift-review',
            connectionId: profile.id,
            database: profile.database,
            kind: 'query',
            title: 'Offline warehouse query',
            sql: 'SELECT 1;',
          },
        ],
        activeTabId: 'redshift-review',
      })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await expect(page.getByLabel('Compatible product query context')).toContainText(
      'Serverless workgroup · Queries consume compute; IAM login unavailable',
    )
    await expect(page.getByRole('button', { name: 'Run script', exact: true })).toBeDisabled()
    const state = await page.evaluate(() => window.harbor.bootstrap())
    const saved = state.profiles.find((item) => item.id === profile.id)
    expect(saved?.redshift).toEqual(profile.redshift)
    expect(saved?.autoReconnect).toBe(false)
    expect(saved?.hasPassword).toBe(false)
    expect(state.history).toEqual([])
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('native compatible product connection, exact query, explicit export and managed preset context', async () => {
  const requested = process.env.HARBOR_COMPATIBLE ?? ''
  test.skip(
    !isCompatibleSqlEngine(requested) || requested === 'redshift',
    'Requires an explicitly selected disposable compatible-product fixture.',
  )
  if (!isCompatibleSqlEngine(requested)) return
  const engine = requested,
    policy = compatibleSqlPolicies[engine],
    mysql = policy.dialect === 'mysql'
  const database = {
    cockroachdb: 'defaultdb',
    yugabytedb: 'yugabyte',
    tidb: 'test',
    vitess: 'harbor',
    redshift: '',
  }[engine]
  const port = { cockroachdb: 26258, yugabytedb: 15435, tidb: 14000, vitess: 15306, redshift: 5439 }[engine]
  const directory = await mkdtemp(join(tmpdir(), 'harbor-compatible-ui-'))
  let desktop: ElectronApplication | undefined
  try {
    const root = resolve(import.meta.dirname, '..')
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
    await page.setViewportSize({ width: 1024, height: 700 })
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const connection = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(connection, policy.name)
    await expect(connection.getByLabel('Compatible product settings')).toContainText(
      'checked on every new session',
    )
    await connection.getByLabel('Connection name', { exact: true }).fill('Compatible UI fixture')
    await connection.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await connection.getByLabel('Port', { exact: true }).fill(String(port))
    await connection
      .getByLabel('Username', { exact: true })
      .fill(engine === 'yugabytedb' ? 'yugabyte' : 'root')
    await connection.getByLabel('Database', { exact: true }).fill(database)
    await expect(connection.getByLabel('Connection name', { exact: true })).toHaveValue(
      'Compatible UI fixture',
    )
    await connection.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(connection).toHaveCount(0)
    await expect(page.getByLabel('Compatible UI fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New query', exact: true }).first().click()
    await expect(page.getByLabel('Compatible product query context')).toContainText(
      `${policy.name} · 127.0.0.1:${port} · ${database}`,
    )
    await typeSql(
      page,
      `SELECT CAST('9007199254740993' AS ${mysql ? 'SIGNED' : 'BIGINT'}) AS duplicate,CAST('12345678901234567890.123456789' AS DECIMAL(38,9)) AS duplicate;`,
    )
    await page.getByRole('button', { name: 'Run script', exact: true }).click()
    await expect(
      page.locator('.table-scroll:visible').getByRole('cell', { name: '9007199254740993', exact: true }),
    ).toBeVisible()
    await expect(
      page
        .locator('.table-scroll:visible')
        .getByRole('cell', { name: '12345678901234567890.123456789', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Full query export', exact: true }).click()
    const exportDialog = page.getByRole('dialog', { name: 'Export a full query result', exact: true })
    await expect(exportDialog).toContainText(
      engine === 'vitess'
        ? 'VTGate'
        : engine === 'tidb'
          ? 'TiDB READ ONLY mode is unavailable'
          : 'product’s native isolation',
    )
    const output = join(directory, 'compatible.jsonl')
    await desktop.evaluate(({ dialog }, filePath) => {
      const previous = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = previous
        return { canceled: false, filePath }
      }
    }, output)
    await exportDialog
      .getByRole('button', { name: 'Review accepted · choose new file and export', exact: true })
      .click()
    await expect(exportDialog.getByRole('status')).toContainText('completed · 1 rows')
    const lines = (await readFile(output, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0].columns.map((column: { name: string }) => column.name)).toEqual([
      'duplicate',
      'duplicate',
    ])
    expect(lines[1]).toEqual(['9007199254740993', '12345678901234567890.123456789'])
    await exportDialog.getByRole('button', { name: 'Close', exact: true }).first().click()
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const preset = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(preset, 'PostgreSQL')
    await preset.getByLabel('Deployment preset', { exact: true }).selectOption('neon')
    await expect(preset.getByLabel('Managed deployment settings')).toContainText(
      'direct endpoint without -pooler',
    )
    await preset.getByLabel('Database credential', { exact: true }).selectOption('temporary-password')
    await expect(
      preset.getByLabel('Credential expiry (UTC ISO timestamp ending in Z)', { exact: true }),
    ).toBeVisible()
    await expect(preset.getByLabel('Database', { exact: true })).toHaveAttribute(
      'placeholder',
      'Required database or keyspace',
    )
    await preset.getByRole('button', { name: 'Close', exact: true }).click()
    const caFile = process.env.HARBOR_MYSQL_TLS_CA
    if (caFile) {
      const managed = profileSchema.parse({
        id: 'managed-ipc-ui',
        name: 'Local managed policy fixture',
        engine: 'mysql',
        host: '127.0.0.1',
        port: 13307,
        database: 'harbor',
        username: 'harbor',
        readOnly: true,
        tls: { enabled: true, rejectUnauthorized: true, ca: await readFile(caFile, 'utf8') },
        managed: { provider: 'cloudsql-mysql' },
      })
      const evidence = await page.evaluate(async (profile) => {
        await window.harbor.saveProfile({
          profile,
          secrets: { password: 'harbor_test' },
          rememberPassword: false,
        })
        const status = await window.harbor.connect({ id: profile.id })
        const databases = await window.harbor.listDatabases(profile.id)
        let denied = ''
        try {
          await window.harbor.listObjects({ connectionId: profile.id, schema: 'information_schema' })
        } catch (error) {
          denied = String(error)
        }
        await window.harbor.disconnect(profile.id)
        return { status: status.state, databases, denied }
      }, managed)
      expect(evidence).toMatchObject({
        status: 'connected',
        databases: ['harbor'],
        denied: expect.stringMatching(/configured schema/),
      })
    }
  } finally {
    await desktop?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
