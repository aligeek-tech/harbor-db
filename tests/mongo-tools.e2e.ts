import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MongoClient } from 'mongodb'
import { waitForElectronWorkspace } from './electron-runtime'

test.use({ trace: 'off' })
const fixture = process.env.HARBOR_MONGO_RS_TEST_DIR
const root = resolve(import.meta.dirname, '..')
test('MongoDB native replica configuration, topology, pipeline draft and reviewed index lifecycle', async () => {
  test.skip(!fixture, 'Requires the separately provisioned authenticated TLS replica set.')
  const database = `harbor_mongo_ui_${randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(join(tmpdir(), 'harbor-mongo-tools-ui-'))
  const password = (await readFile(join(fixture!, 'credentials.private.env'), 'utf8')).trim().split('=', 2)[1]
  const ca = await readFile(join(fixture!, 'tls-ca.pem'), 'utf8')
  const control = new MongoClient('mongodb://localhost:27117,localhost:27118,localhost:27119/', {
    auth: { username: 'harbor_rs_admin', password },
    authSource: 'admin',
    replicaSet: 'harbor_rs',
    tls: true,
    tlsCAFile: join(fixture!, 'tls-ca.pem'),
    retryReads: false,
    retryWrites: false,
  })
  let desktop: ElectronApplication | undefined
  let completed = false
  try {
    await control.connect()
    await control
      .db(database)
      .collection('records')
      .insertMany(
        [
          { rank: 1, category: 'a' },
          { rank: 2, category: 'b' },
          { rank: 3, category: 'b' },
        ],
        { writeConcern: { w: 'majority' } },
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
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await waitForElectronWorkspace(page)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await page.getByRole('button', { name: 'New connection', exact: true }).click()
    const connection = page.getByRole('dialog', { name: 'New connection', exact: true })
    await selectDatabaseEngine(connection, 'MongoDB')
    await connection.getByLabel('Connection name', { exact: true }).fill('Mongo replica native UI')
    await connection.getByLabel('Host', { exact: true }).fill('localhost')
    await connection.getByLabel('Port', { exact: true }).fill('27117')
    await connection.getByLabel('Username', { exact: true }).fill('harbor_rs_admin')
    await connection
      .getByLabel('Password', { exact: true })
      .fill(password)
      .catch(() => {
        throw new Error('Could not enter disposable credential in its masked field.')
      })
    await connection.getByLabel('Database', { exact: true }).fill(database)
    await connection.getByLabel('MongoDB replica set', { exact: true }).fill('harbor_rs')
    await connection.getByLabel('Authentication mechanism', { exact: true }).selectOption('SCRAM-SHA-256')
    for (const [index, port] of [27118, 27119].entries()) {
      await connection.getByRole('button', { name: 'Add MongoDB seed', exact: true }).click()
      await connection.getByLabel(`MongoDB seed ${index + 1} host`, { exact: true }).fill('localhost')
      await connection.getByLabel(`MongoDB seed ${index + 1} port`, { exact: true }).fill(String(port))
    }
    await connection.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await connection.getByText('TLS / SSL encryption', { exact: true }).click()
    await connection.getByLabel('Use TLS', { exact: true }).check()
    await expect(
      connection.getByLabel('Verify server certificate and hostname', { exact: true }),
    ).toBeChecked()
    await connection.getByLabel('CA certificate', { exact: true }).fill(ca)
    await connection.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(connection.getByText(/Connection successful/)).toBeVisible({ timeout: 15000 })
    await connection.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(connection).toHaveCount(0)
    await expect(page.getByLabel('Mongo replica native UI: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Mongo replica native UI', exact: true }).dblclick()
    await page.locator('.mongo-collections').getByRole('button', { name: 'records', exact: true }).click()
    const workspace = page.locator('.mongo-workspace').filter({ visible: true })
    await workspace.getByRole('button', { name: 'Topology', exact: true }).click()
    const topology = page.getByRole('dialog', { name: 'MongoDB topology', exact: true })
    await expect(topology.getByRole('cell', { name: /RSPrimary/ })).toBeVisible()
    await expect(topology.getByRole('cell', { name: /RSSecondary/ })).toHaveCount(2)
    await expect(topology).toContainText('harbor_rs')
    await page.screenshot({ path: test.info().outputPath('mongo-topology.png') })
    await topology.locator('.dialog-actions').getByRole('button', { name: 'Close', exact: true }).click()
    await workspace.getByRole('button', { name: 'Build pipeline', exact: true }).click()
    const pipeline = page.getByRole('dialog', { name: 'Aggregation pipeline builder', exact: true })
    await pipeline.getByRole('button', { name: 'Add stage', exact: true }).click()
    await pipeline.getByLabel('Stage 1 body', { exact: true }).fill('{"rank":{"$gte":2}}')
    await pipeline.getByRole('button', { name: 'Add stage', exact: true }).click()
    await pipeline.getByLabel('Stage 2 operator', { exact: true }).fill('$group')
    await pipeline.getByLabel('Stage 2 body', { exact: true }).fill('{"_id":"$category","total":{"$sum":1}}')
    await pipeline.getByRole('button', { name: 'Move stage 2 up', exact: true }).click()
    await expect(pipeline.getByLabel('Stage 1 operator', { exact: true })).toHaveValue('$group')
    await pipeline.getByRole('button', { name: 'Move stage 1 down', exact: true }).click()
    await expect(pipeline.getByLabel('Stage 1 operator', { exact: true })).toHaveValue('$match')
    await pipeline.getByRole('button', { name: 'Add stage', exact: true }).click()
    await pipeline.getByLabel('Stage 3 operator', { exact: true }).fill('$limit')
    await pipeline.getByLabel('Stage 3 body', { exact: true }).fill('1')
    await pipeline.getByLabel('Enable stage 3', { exact: true }).uncheck()
    await expect(pipeline.getByLabel('Pipeline preview', { exact: true })).not.toContainText('$limit')
    await page.screenshot({ path: test.info().outputPath('mongo-pipeline.png') })
    await pipeline.getByRole('button', { name: 'Apply pipeline draft', exact: true }).click()
    await expect(workspace.getByLabel('MongoDB query mode', { exact: true })).toHaveValue('aggregate')
    await expect(workspace.locator('.table-scroll')).toHaveCount(0)
    await workspace.getByRole('button', { name: 'Run query', exact: true }).click()
    await expect(
      workspace.locator('.table-scroll').getByRole('cell', { name: '2', exact: true }),
    ).toBeVisible()
    await workspace.getByRole('button', { name: 'Indexes', exact: true }).click()
    const indexes = page.getByRole('dialog', { name: 'MongoDB indexes', exact: true })
    await expect(
      indexes.getByRole('button', { name: 'Review dropping index _id_', exact: true }),
    ).toBeDisabled()
    await indexes.getByLabel('MongoDB index name', { exact: true }).fill('ui_compound')
    await indexes.getByLabel('Index field 1', { exact: true }).fill('category')
    await indexes.getByRole('button', { name: 'Add ordered field', exact: true }).click()
    await indexes.getByLabel('Index field 2', { exact: true }).fill('rank')
    await indexes.getByLabel('Index direction 2', { exact: true }).selectOption('-1')
    await indexes.getByRole('button', { name: 'Review index creation', exact: true }).click()
    await expect(indexes.getByLabel('Index operation preview', { exact: true })).toContainText(
      '"category":1,"rank":-1',
    )
    await expect(
      indexes.getByRole('button', { name: 'Execute reviewed index change', exact: true }),
    ).toBeDisabled()
    await indexes
      .getByLabel('Confirm MongoDB index target', { exact: true })
      .fill(`CREATE INDEX ${database}.records/ui_compound`)
    await indexes.getByRole('button', { name: 'Execute reviewed index change', exact: true }).click()
    await expect(
      indexes.getByRole('button', { name: 'Review dropping index ui_compound', exact: true }),
    ).toBeVisible()
    expect(
      (await control.db(database).collection('records').listIndexes().toArray()).find(
        (index) => index.name === 'ui_compound',
      )?.key,
    ).toEqual({ category: 1, rank: -1 })
    await page.screenshot({ path: test.info().outputPath('mongo-indexes.png') })
    await indexes.getByRole('button', { name: 'Review dropping index ui_compound', exact: true }).click()
    await indexes
      .getByLabel('Confirm MongoDB index target', { exact: true })
      .fill(`DROP INDEX ${database}.records/ui_compound`)
    await control.db(database).collection('records').createIndex({ rank: 1 }, { name: 'concurrent' })
    await indexes.getByRole('button', { name: 'Execute reviewed index change', exact: true }).click()
    await expect(indexes.getByRole('alert')).toContainText('changed after review')
    expect(
      (await control.db(database).collection('records').listIndexes().toArray()).some(
        (index) => index.name === 'ui_compound',
      ),
    ).toBe(true)
    await indexes.getByRole('button', { name: 'Refresh indexes', exact: true }).click()
    await indexes.getByRole('button', { name: 'Review dropping index ui_compound', exact: true }).click()
    await indexes
      .getByLabel('Confirm MongoDB index target', { exact: true })
      .fill(`DROP INDEX ${database}.records/ui_compound`)
    await indexes.getByRole('button', { name: 'Execute reviewed index change', exact: true }).click()
    await expect(
      indexes.getByRole('button', { name: 'Review dropping index ui_compound', exact: true }),
    ).toHaveCount(0)
    await indexes.locator('.dialog-actions').getByRole('button', { name: 'Close', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 700))
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox', { name: 'Search actions and database objects' }).fill('Switch light')
    await page.getByRole('option', { name: /Switch light \/ dark theme/ }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await workspace.getByRole('button', { name: 'Topology', exact: true }).click()
    await expect(topology).toContainText('harbor_rs')
    await expect(topology.getByRole('button', { name: 'Refresh topology', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('mongo-topology-compact-dark.png') })
    await page.keyboard.press('Escape')
    await expect(topology).toHaveCount(0)
    const state = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(state)).not.toContain(password)
    expect(state.profiles[0].mongo.seeds).toHaveLength(2)
    expect(state.history).toHaveLength(0)
    expect(errors).toEqual([])
    completed = true
  } finally {
    if (!completed) await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close().catch(() => {})
    await control
      .db(database)
      .dropDatabase()
      .catch(() => {})
    await control.close()
    await rm(directory, { recursive: true, force: true })
  }
})
