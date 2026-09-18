import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import cassandra from 'cassandra-driver'
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'
import { cqlConfirmation } from '../src/shared/cql'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Cassandra native form, partition paging, exact values and conditional conflict review', async () => {
  test.skip(process.env.HARBOR_CASSANDRA_FIXTURE !== '1', 'Requires authorized Cassandra fixture')
  const credentials = JSON.parse(await readFile(process.env.HARBOR_CASSANDRA_CREDENTIALS!, 'utf8'))
  const keyspace = 'harbor_ui_' + randomUUID().replaceAll('-', ''),
    directory = await mkdtemp(join(tmpdir(), 'harbor-cql-ui-')),
    root = resolve(import.meta.dirname, '..'),
    control = new cassandra.Client({
      contactPoints: ['127.0.0.1:19042'],
      localDataCenter: 'datacenter1',
      authProvider: new cassandra.auth.PlainTextAuthProvider(credentials.username, credentials.password),
    })
  let desktop: ElectronApplication | undefined
  try {
    await control.execute(
      `CREATE KEYSPACE ${keyspace} WITH replication = {'class':'SimpleStrategy','replication_factor':1}`,
    )
    await control.execute(
      `CREATE TABLE ${keyspace}.records (tenant text, bucket int, seq bigint, version int, exact decimal, PRIMARY KEY ((tenant,bucket),seq))`,
    )
    for (let i = 0; i < 30; i++)
      await control.execute(
        `INSERT INTO ${keyspace}.records (tenant,bucket,seq,version,exact) VALUES ('tenant',1,${i},1,12345678901234567890.123456789)`,
      )
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
    await page.getByRole('button', { name: 'New connection', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await selectDatabaseEngine(dialog, 'Cassandra')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Cassandra native fixture')
    await dialog.getByLabel('Port', { exact: true }).fill('19042')
    await dialog.getByLabel('Username', { exact: true }).fill(credentials.username)
    await dialog.getByLabel('Password', { exact: true }).fill(credentials.password)
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Apache Cassandra 5\.0\./)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Cassandra native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cassandra native fixture', exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: 'Cassandra CQL workspace' })).toBeVisible()
    await expect(page.getByRole('table', { name: 'CQL result table' })).toHaveCount(0)
    await page.getByLabel('CQL keyspace', { exact: true }).fill(keyspace)
    await page.getByLabel('CQL table', { exact: true }).fill('records')
    await page.getByRole('button', { name: 'Inspect CQL table', exact: true }).click()
    await expect(
      page.getByText('Partition key: tenant, bucket · Clustering: seq', { exact: true }),
    ).toBeVisible()
    const parameters = [
      { type: 'text', value: 'tenant' },
      { type: 'int', value: '1' },
    ]
    await page.getByLabel('CQL typed parameters', { exact: true }).fill(JSON.stringify(parameters))
    await page.getByRole('button', { name: 'Run prepared CQL', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '25 rows on page' })).toBeVisible()
    await expect(page.getByRole('table', { name: 'CQL result table' })).toContainText(
      '12345678901234567890.123456789',
    )
    await expect(page.getByLabel('CQL keyspace', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Next CQL page', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '5 rows on page' })).toBeVisible()
    await page.getByRole('button', { name: 'Prepare conditional UPDATE', exact: true }).click()
    const cql = `UPDATE ${keyspace}.records SET version = ? WHERE tenant = ? AND bucket = ? AND seq = ? IF version = ?`,
      draft = JSON.stringify([
        { type: 'int', value: '3' },
        ...parameters,
        { type: 'bigint', value: '0' },
        { type: 'int', value: '1' },
      ])
    await page.getByLabel('CQL statement', { exact: true }).fill(cql)
    await page.getByLabel('CQL typed parameters', { exact: true }).fill(draft)
    await control.execute(
      `UPDATE ${keyspace}.records SET version=2 WHERE tenant='tenant' AND bucket=1 AND seq=0`,
    )
    const state = await page.evaluate(() => window.harbor.bootstrap()),
      profile = state.profiles.find((p) => p.name === 'Cassandra native fixture')!
    await expect(page.getByRole('button', { name: 'Run prepared CQL', exact: true })).toBeDisabled()
    await page
      .getByLabel('Confirm CQL mutation', { exact: true })
      .fill(cqlConfirmation(profile.id, keyspace, 'records'))
    await page.getByRole('button', { name: 'Run prepared CQL', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Condition not met; no mutation applied' }),
    ).toBeVisible()
    await expect(page.getByLabel('CQL typed parameters', { exact: true })).toHaveValue(draft)
    await page
      .getByLabel('CQL typed parameters', { exact: true })
      .fill(
        JSON.stringify([
          { type: 'int', value: '3' },
          ...parameters,
          { type: 'bigint', value: '0' },
          { type: 'int', value: '2' },
        ]),
      )
    await page
      .getByLabel('Confirm CQL mutation', { exact: true })
      .fill(cqlConfirmation(profile.id, keyspace, 'records'))
    await page.getByRole('button', { name: 'Run prepared CQL', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Mutation applied and acknowledged' }),
    ).toBeVisible()
    expect(
      (
        await control.execute(
          `SELECT version FROM ${keyspace}.records WHERE tenant='tenant' AND bucket=1 AND seq=0`,
        )
      ).first().version,
    ).toBe(3)
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(final)).not.toContain(credentials.password)
    expect(JSON.stringify(final)).not.toContain(cql)
    expect(final.history).toHaveLength(0)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('heading', { name: 'Cassandra CQL workspace' }).scrollIntoViewIfNeeded()
    const output =
      '/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/cassandra-fixture'
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: output + '/native-compact.png' })
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await control.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`)
    await control.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
