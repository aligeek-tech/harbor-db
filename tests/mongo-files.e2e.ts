import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { BSON, MongoClient } from 'mongodb'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { mongoFileConfirmation } from '../src/shared/mongo-files'
import { waitForElectronWorkspace } from './electron-runtime'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('MongoDB native document file export, canonical preview and reviewed import preserve BSON', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires isolated MongoDB fixture.')
  const directory = await mkdtemp(join(tmpdir(), 'harbor-mongo-file-ui-')),
    root = resolve(import.meta.dirname, '..'),
    database = 'harbor_mongo_file_ui_' + randomUUID().replaceAll('-', '')
  const profile = profileSchema.parse({
    id: randomUUID(),
    name: 'Document file fixture',
    engine: 'mongodb',
    host: '127.0.0.1',
    port: 17017,
    username: 'harbor',
    database,
    readOnly: false,
  })
  const control = new MongoClient('mongodb://127.0.0.1:17017', {
    auth: { username: 'harbor', password: 'harbor_test' },
    authSource: 'admin',
    promoteValues: false,
  })
  const document = {
    _id: new BSON.ObjectId(),
    exact: BSON.Long.fromString('9223372036854775807'),
    amount: BSON.Decimal128.fromString('1234567890.123456789'),
    binary: new BSON.Binary(Buffer.from([0, 255, 128])),
    label: 'private synthetic document payload',
  }
  const path = join(directory, 'documents.jsonl')
  let desktop: ElectronApplication | undefined
  try {
    await control.connect()
    await control.db(database).createCollection('source')
    await control.db(database).createCollection('destination')
    await control.db(database).collection('source').insertOne(document)
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
    await page.evaluate(async (profile) => {
      await window.harbor.saveProfile({
        profile,
        secrets: { password: 'harbor_test' },
        rememberPassword: false,
      })
      await window.harbor.connect({ id: profile.id, secrets: { password: 'harbor_test' } })
    }, profile)
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await page.getByRole('button', { name: 'source', exact: true }).click()
    await page.getByRole('button', { name: 'Document files…', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'MongoDB document files', exact: true })
    await expect(
      dialog.getByRole('button', { name: 'Choose destination and start export…', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /I consent to rerunning/ }).check()
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, path)
    await dialog.getByRole('button', { name: 'Choose destination and start export…', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('export completed')
    expect((await readFile(path, 'utf8')).trim()).toBe(BSON.EJSON.stringify(document, { relaxed: false }))
    await dialog.getByRole('button', { name: 'Close document files', exact: true }).click()
    await page.getByRole('button', { name: 'destination', exact: true }).click()
    await page.getByRole('button', { name: 'Document files…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'MongoDB document files', exact: true })
    await dialog.getByLabel('Document file operation', { exact: true }).selectOption('import')
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
    await dialog.getByRole('button', { name: 'Choose and preview Extended JSON file…', exact: true }).click()
    await expect(dialog.getByLabel('Extended JSON preview', { exact: true })).toContainText(
      '"$numberLong":"9223372036854775807"',
    )
    expect(Number(await control.db(database).collection('destination').countDocuments())).toBe(0)
    await expect(
      dialog.getByRole('button', { name: 'Start reviewed document import', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /I accept individual document commits/ }).check()
    await dialog
      .getByLabel('Confirm document import target', { exact: true })
      .fill(mongoFileConfirmation({ connectionId: profile.id, database, collection: 'destination' }))
    await dialog.getByRole('button', { name: 'Start reviewed document import', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'import completed · 1 documents read · 1 acknowledged inserts · 0 uncertain',
    )
    expect(
      BSON.EJSON.stringify(
        await control.db(database).collection('destination').findOne({ _id: document._id }),
        { relaxed: false },
      ),
    ).toBe(BSON.EJSON.stringify(document, { relaxed: false }))
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(dialog.getByRole('button', { name: 'Close document files', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close document files', exact: true }).click()
    expect(JSON.stringify(await page.evaluate(() => window.harbor.bootstrap()))).not.toContain(document.label)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await control.db(database).dropDatabase()
    await control.close()
    await rm(directory, { recursive: true, force: true })
  }
})
