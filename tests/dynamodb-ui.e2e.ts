import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'
import { dynamoConfirmation } from '../src/shared/dynamodb'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('DynamoDB native form, partition paging, explicit scan and conditional conflict review', async () => {
  test.skip(process.env.HARBOR_DYNAMODB_FIXTURE !== '1', 'Requires authorized DynamoDB Local fixture')
  const name = 'Harbor_UI_' + randomUUID().replaceAll('-', ''),
    credentials = { accessKeyId: 'HarborUIFixtureKey', secretAccessKey: randomUUID() },
    control = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:18000',
      credentials,
      maxAttempts: 1,
      ignoreConfiguredEndpointUrls: true,
    }),
    directory = await mkdtemp(join(tmpdir(), 'harbor-dynamo-ui-')),
    root = resolve(import.meta.dirname, '..')
  let desktop: ElectronApplication | undefined
  try {
    await control.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    )
    for (let i = 0; i < 30; i++)
      await control.send(
        new PutItemCommand({
          TableName: name,
          Item: {
            pk: { S: 'group' },
            sk: { N: String(i) },
            version: { N: '1' },
            exact: { N: '9007199254740993' },
            name: { S: 'original' },
          },
        }),
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
    await selectDatabaseEngine(dialog, 'DynamoDB')
    await dialog.getByLabel('Connection name', { exact: true }).fill('DynamoDB native fixture')
    await dialog.getByLabel('DynamoDB access key ID', { exact: true }).fill(credentials.accessKeyId)
    await dialog.getByLabel('DynamoDB secret access key', { exact: true }).fill(credentials.secretAccessKey)
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · DynamoDB Local/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('DynamoDB native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'DynamoDB native fixture', exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: 'DynamoDB item workspace' })).toBeVisible()
    await expect(page.locator('div[aria-label="DynamoDB items"]')).toHaveCount(0)
    await page.getByLabel('DynamoDB table', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Inspect DynamoDB table', exact: true }).click()
    await expect(page.getByText('Partition key: pk (S) · Sort key: sk (N)', { exact: true })).toBeVisible()
    await expect(page.getByLabel('DynamoDB read mode', { exact: true })).toHaveValue('query')
    await page.getByLabel('DynamoDB read mode', { exact: true }).selectOption('scan')
    await expect(page.getByRole('button', { name: 'Run DynamoDB read', exact: true })).toBeDisabled()
    await page.getByLabel('DynamoDB read mode', { exact: true }).selectOption('query')
    await page.getByLabel('DynamoDB partition value', { exact: true }).fill('{"S":"group"}')
    await page.getByRole('button', { name: 'Run DynamoDB read', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '25 items returned' })).toBeVisible()
    await expect(page.locator('div[aria-label="DynamoDB items"]')).toContainText('9007199254740993')
    await expect(page.getByLabel('DynamoDB table', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Next DynamoDB page', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '5 items returned' })).toBeVisible()
    await page.getByRole('button', { name: 'Prepare item 1 for review', exact: true }).click()
    await page.getByText('Reviewed conditional item mutation', { exact: true }).click()
    const state = await page.evaluate(() => window.harbor.bootstrap()),
      profile = state.profiles.find((profile) => profile.name === 'DynamoDB native fixture')!,
      primary = JSON.parse(await page.getByLabel('DynamoDB Primary key', { exact: true }).inputValue())
    await control.send(
      new UpdateItemCommand({
        TableName: name,
        Key: primary,
        UpdateExpression: 'SET #version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': { N: '2' } },
      }),
    )
    const draft = '{ "name": {"S":"reviewed change"}, "version":{"N":"3"} }'
    await page.getByLabel('DynamoDB Item or attributes to set', { exact: true }).fill(draft)
    await expect(
      page.getByRole('button', { name: 'Apply conditional DynamoDB mutation', exact: true }),
    ).toBeDisabled()
    await page
      .getByLabel('Confirm DynamoDB mutation', { exact: true })
      .fill(dynamoConfirmation(profile.id, name))
    await page.getByRole('button', { name: 'Apply conditional DynamoDB mutation', exact: true }).click()
    await expect(page.getByText(/DynamoDB condition failed/)).toBeVisible()
    await expect(page.getByLabel('DynamoDB Item or attributes to set', { exact: true })).toHaveValue(draft)
    await page.getByLabel('DynamoDB Expected attributes', { exact: true }).fill('{"version":{"N":"2"}}')
    await page
      .getByLabel('Confirm DynamoDB mutation', { exact: true })
      .fill(dynamoConfirmation(profile.id, name))
    await page.getByRole('button', { name: 'Apply conditional DynamoDB mutation', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Native conditional write acknowledged' }),
    ).toBeVisible()
    expect(
      (await control.send(new GetItemCommand({ TableName: name, Key: primary, ConsistentRead: true }))).Item
        ?.name?.S,
    ).toBe('reviewed change')
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('heading', { name: 'DynamoDB item workspace' }).scrollIntoViewIfNeeded()
    const output =
      '/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/dynamodb-fixture'
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: output + '/native-compact.png' })
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(final)).not.toContain(credentials.secretAccessKey)
    expect(JSON.stringify(final)).not.toContain(credentials.accessKeyId)
    expect(JSON.stringify(final)).not.toContain('reviewed change')
    expect(final.history).toHaveLength(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await control.send(new DeleteTableCommand({ TableName: name }))
    control.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
