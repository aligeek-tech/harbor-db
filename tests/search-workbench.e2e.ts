import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { SearchHttp, searchJson } from '../src/main/engines/search-http'
import { openTransport } from '../src/main/engines/transport'
import { waitForElectronWorkspace } from './electron-runtime'

// Credentials are disposable but never belong in Playwright traces or action logs.
test.use({ trace: 'off' })
const root = resolve(import.meta.dirname, '..')
const privateFile = process.env.HARBOR_SEARCH_TEST_ENV_FILE
async function review(page: Page, operation: 'create' | 'replace' | 'delete', index: string, id: string) {
  const dialog = page.getByRole('dialog', { name: `Review ${operation} document`, exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Confirmation', { exact: true }).fill(`${operation.toUpperCase()} ${index}/${id}`)
  await dialog
    .getByRole('button', { name: operation === 'delete' ? 'Delete document' : 'Apply document', exact: true })
    .click()
}
for (const product of ['elasticsearch', 'opensearch'] as const) {
  test(`${product} native search, exact documents, snapshot paging and reviewed concurrency`, async () => {
    test.skip(!privateFile, 'Requires the separately provisioned disposable authenticated search fixtures.')
    const directory = await mkdtemp(join(tmpdir(), `harbor-${product}-desktop-`))
    const index = `harbor_ui_${randomUUID().replaceAll('-', '')}`
    const name = product === 'elasticsearch' ? 'Elasticsearch native fixture' : 'OpenSearch native fixture'
    const label = product === 'elasticsearch' ? 'Elasticsearch' : 'OpenSearch'
    const key =
      product === 'elasticsearch' ? 'HARBOR_ELASTIC_TEST_PASSWORD' : 'HARBOR_OPENSEARCH_TEST_PASSWORD'
    const password = (await readFile(privateFile!, 'utf8'))
      .split('\n')
      .find((line) => line.startsWith(key + '='))
      ?.slice(key.length + 1)
    if (!password) throw new Error('Missing disposable search fixture credential.')
    const profile = profileSchema.parse({
      id: randomUUID(),
      name,
      engine: product,
      host: '127.0.0.1',
      port: product === 'elasticsearch' ? 19200 : 19201,
      username: product === 'elasticsearch' ? 'elastic' : 'admin',
      readOnly: false,
      tls: { enabled: product === 'opensearch', rejectUnauthorized: false },
    })
    const transport = await openTransport(profile)
    const admin = new SearchHttp(profile, transport, { password })
    let desktop: ElectronApplication | undefined
    let created = false
    let completed = false
    try {
      await admin.request('PUT', '/' + index, {
        settings: { number_of_shards: 2, number_of_replicas: 0 },
        mappings: {
          properties: { rank: { type: 'integer' }, group: { type: 'keyword' }, huge: { type: 'long' } },
        },
        aliases: { [index + '_alias']: {} },
      })
      created = true
      for (let rank = 0; rank < 6; rank++)
        await admin.request(
          'PUT',
          `/${index}/_doc/${rank}?refresh=true`,
          searchJson(`{"rank":${rank},"group":"${rank % 2 ? 'odd' : 'even'}","huge":9223372036854775807}`),
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
        timeout: 30000,
      })
      const page = await desktop.firstWindow()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await waitForElectronWorkspace(page)
      await page.getByRole('button', { name: 'New connection', exact: true }).click()
      const connection = page.getByRole('dialog', { name: 'New connection', exact: true })
      await selectDatabaseEngine(connection, label)
      await connection.getByLabel('Connection name', { exact: true }).fill(name)
      await connection.getByLabel('Host', { exact: true }).fill('127.0.0.1')
      await connection.getByLabel('Port', { exact: true }).fill(String(profile.port))
      await expect(connection.getByLabel('Search authentication', { exact: true })).toHaveValue('basic')
      await expect(connection.getByLabel('Username', { exact: true })).toHaveValue(profile.username)
      await connection
        .getByLabel('Password', { exact: true })
        .fill(password)
        .catch(() => {
          throw new Error('Could not enter the disposable credential in its masked field.')
        })
      await connection.getByLabel('Read-only safeguard', { exact: true }).uncheck()
      await connection.getByText('TLS / SSL encryption', { exact: true }).click()
      if (product === 'elasticsearch') await connection.getByLabel('Use TLS', { exact: true }).uncheck()
      else await connection.getByLabel('Verify server certificate and hostname', { exact: true }).uncheck()
      await connection.getByRole('button', { name: 'Test connection', exact: true }).click()
      await expect(connection.getByText(/Connection successful/)).toBeVisible({ timeout: 15000 })
      await connection.getByRole('button', { name: 'Save and connect', exact: true }).click()
      await expect(connection).toHaveCount(0)
      await expect(page.getByLabel(`${name}: connected`, { exact: true })).toBeVisible()
      if (!(await page.getByRole('button', { name: 'Browse indices & search', exact: true }).isVisible()))
        await page.getByRole('button', { name, exact: true }).click()
      await page.getByRole('button', { name: 'Browse indices & search', exact: true }).click()
      const workspace = page.getByLabel(`${label} search workspace`, { exact: true })
      await expect(workspace.getByLabel('Search results', { exact: true })).toHaveCount(0)
      await workspace.getByRole('button', { name: 'Load indices', exact: true }).click()
      await expect(workspace.getByLabel('Search indices', { exact: true })).toContainText(index)
      await workspace.getByLabel('Search index or pattern', { exact: true }).fill(index)
      await workspace.getByRole('button', { name: 'Mappings & aliases', exact: true }).click()
      await expect(page.getByLabel('Index mapping JSON', { exact: true })).toContainText(
        '"huge":{"type":"long"}',
      )
      await expect(page.getByLabel('Index alias JSON', { exact: true })).toContainText(index + '_alias')
      await page.getByRole('button', { name: 'Close mappings', exact: true }).click()
      const dsl =
        '{"query":{"match_all":{}},"sort":[{"rank":"asc"}],"aggs":{"groups":{"terms":{"field":"group","size":5}}}}'
      await workspace.getByLabel('Search JSON DSL', { exact: true }).fill(dsl)
      await workspace.getByLabel('Search hits per page', { exact: true }).fill('2')
      await workspace.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(workspace.getByLabel('Search results', { exact: true })).toContainText(
        'Page 1 · 2 loaded hits',
      )
      await expect(workspace.getByLabel('Search aggregation JSON', { exact: true })).toContainText(
        '"doc_count":3',
      )
      await expect(
        workspace.getByRole('button', { name: `Open document ${index}/0`, exact: true }),
      ).toContainText('9223372036854775807')
      await page.screenshot({ path: test.info().outputPath('search-workbench.png') })
      await workspace.getByRole('button', { name: 'Next page', exact: true }).click()
      await expect(workspace.getByLabel('Search results', { exact: true })).toContainText(
        'Page 2 · 2 loaded hits',
      )
      await workspace.getByRole('button', { name: `Open document ${index}/2`, exact: true }).click()
      const document = page.getByRole('dialog', { name: `Live document · ${index}`, exact: true })
      await expect(document.getByLabel('Search document JSON', { exact: true })).toHaveValue(
        /9223372036854775807/,
      )
      await document
        .getByLabel('Search document JSON', { exact: true })
        .fill('{"rank":2,"group":"edited","huge":9223372036854775807}')
      await admin.request('PUT', `/${index}/_doc/2?refresh=true`, { rank: 2, group: 'concurrent' })
      await document.getByRole('button', { name: 'Review replacement', exact: true }).click()
      await review(page, 'replace', index, '2')
      await expect(document.getByRole('alert').filter({ hasText: 'Conflict' })).toBeVisible()
      await expect(document.getByRole('button', { name: 'Review replacement', exact: true })).toBeDisabled()
      await page.screenshot({ path: test.info().outputPath('search-conflict.png') })
      await document.getByRole('button', { name: 'Reload document', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Reload and discard document draft?', exact: true })
        .getByRole('button', { name: 'Reload document', exact: true })
        .click()
      await expect(document.getByLabel('Search document JSON', { exact: true })).toHaveValue(
        '{"rank":2,"group":"concurrent"}',
      )
      await document
        .getByLabel('Search document JSON', { exact: true })
        .fill('{"rank":2,"group":"reviewed","huge":9223372036854775807}')
      await document.getByRole('button', { name: 'Review replacement', exact: true }).click()
      await review(page, 'replace', index, '2')
      await expect(document).toHaveCount(0)
      await expect(workspace.getByRole('status').filter({ hasText: 'updated:' })).toBeVisible()
      await workspace.getByRole('button', { name: 'Create document', exact: true }).click()
      const create = page.getByRole('dialog', { name: `Create document · ${index}`, exact: true })
      await create.getByLabel('Search document ID', { exact: true }).fill('reviewed-new')
      await create
        .getByLabel('Search document JSON', { exact: true })
        .fill('{"rank":99,"group":"new","huge":9223372036854775807}')
      await create.getByRole('button', { name: 'Review create', exact: true }).click()
      await review(page, 'create', index, 'reviewed-new')
      await expect(create).toHaveCount(0)
      await workspace
        .getByLabel('Search JSON DSL', { exact: true })
        .fill('{"query":{"ids":{"values":["reviewed-new"]}}}')
      await workspace.getByRole('button', { name: 'Search', exact: true }).click()
      await workspace
        .getByRole('button', { name: `Open document ${index}/reviewed-new`, exact: true })
        .click()
      await document.getByRole('button', { name: 'Review delete', exact: true }).click()
      await review(page, 'delete', index, 'reviewed-new')
      await expect(document).toHaveCount(0)
      await expect(workspace.getByRole('status').filter({ hasText: 'deleted:' })).toBeVisible()
      await workspace.getByLabel('Search JSON DSL', { exact: true }).fill(dsl)
      await workspace.getByRole('button', { name: 'Save DSL', exact: true }).click()
      const save = page.getByRole('dialog', { name: 'Save query', exact: true })
      await save.getByLabel('Name', { exact: true }).fill('Saved native search')
      await save.getByRole('button', { name: 'Save query', exact: true }).click()
      await expect(save).toHaveCount(0)
      const saved = await page.evaluate(() => window.harbor.bootstrap())
      expect(saved.savedQueries.find((query) => query.name === 'Saved native search')).toMatchObject({
        engine: product,
        searchIndex: index,
        searchPageSize: 2,
        sql: dsl,
      })
      expect(saved.history).toHaveLength(0)
      expect(JSON.stringify(saved)).not.toContain(password)
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.harbor.bootstrap())).workspace.tabs.find(
              (tab) => tab.kind === 'search',
            )?.sql,
        )
        .toBe(dsl)
      await page.reload()
      await waitForElectronWorkspace(page)
      await expect(page.getByText('Restored tab · no query executed', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open search workspace', exact: true })).toBeDisabled()
      await page.getByRole('button', { name, exact: true }).dblclick()
      await expect(page.getByLabel(`${name}: connected`, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Open search workspace', exact: true }).click()
      await expect(page.getByLabel('Search JSON DSL', { exact: true })).toHaveValue(dsl)
      await expect(page.getByLabel('Search results', { exact: true })).toHaveCount(0)
      await expect(page.getByLabel('Search indices', { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
      completed = true
    } finally {
      if (!completed) await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await desktop?.close().catch(() => {})
      if (created) await admin.request('DELETE', '/' + index)
      admin.close()
      await transport.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
