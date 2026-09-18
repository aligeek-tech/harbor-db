import { selectDatabaseEngine } from './electron-runtime'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import neo4j from 'neo4j-driver'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { waitForElectronWorkspace } from './electron-runtime'
import { neoConfirmation } from '../src/shared/neo4j'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test('Neo4j form, typed Cypher pages, graph property inspection and reviewed native mutation', async () => {
  const fixture = process.env.HARBOR_NEO4J_FIXTURE_DIR
  test.skip(!fixture, 'Requires authorized Neo4j fixture')
  const password = /^NEO4J_AUTH=neo4j\/(.+)$/m.exec(await readFile(fixture + '/fixture.env', 'utf8'))![1]!,
    tag = 'harbor_ui_' + randomUUID().replaceAll('-', ''),
    directory = await mkdtemp(join(tmpdir(), 'harbor-neo-ui-')),
    root = resolve(import.meta.dirname, '..'),
    control = neo4j.driver('bolt://127.0.0.1:17687', neo4j.auth.basic('neo4j', password), {
      disableAutoCommitRetries: true,
      maxTransactionRetryTime: 0,
      telemetryDisabled: true,
    })
  const native = async (query: string) => {
    const session = control.session({ database: 'neo4j' })
    try {
      return await session.run(query, { tag })
    } finally {
      await session.close()
    }
  }
  let desktop: ElectronApplication | undefined
  try {
    await native(
      'CREATE(a:HarborFixture {tag:$tag, exact:9007199254740993}), (b:HarborFixture {tag:$tag}) CREATE (a)-[:LINK]->(b)',
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
    await selectDatabaseEngine(dialog, 'Neo4j')
    await dialog.getByLabel('Connection name', { exact: true }).fill('Neo4j native fixture')
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await dialog.getByLabel('Port', { exact: true }).fill('17687')
    await expect(dialog.getByLabel('Username', { exact: true })).toHaveValue('neo4j')
    await expect(dialog.getByLabel('Database', { exact: true })).toHaveValue('neo4j')
    await dialog.getByLabel('Password', { exact: true }).fill(password)
    await dialog.getByLabel('Read-only safeguard', { exact: true }).uncheck()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText(/Connection successful · Neo4j 5.26.30/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await expect(page.getByLabel('Neo4j native fixture: connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Neo4j native fixture', exact: true }).dblclick()
    await expect(page.getByRole('heading', { name: 'Neo4j Cypher workspace', exact: true })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Neo4j result table' })).toHaveCount(0)
    const cypher = page.getByRole('textbox', { name: 'Neo4j Cypher', exact: true }),
      parameters = page.getByLabel('Neo4j typed parameters', { exact: true })
    await cypher.fill('UNWIND range(1,30) AS x RETURN x, $exact AS exact')
    await parameters.fill(JSON.stringify([{ name: 'exact', type: 'integer', value: '9223372036854775807' }]))
    await page.getByRole('button', { name: 'Run Cypher', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '25 rows on page' })).toBeVisible()
    await expect(cypher).toBeDisabled()
    await expect(page.getByLabel('Neo4j database', { exact: true })).toBeDisabled()
    await expect(page.getByRole('table', { name: 'Neo4j result table' })).toContainText('9223372036854775807')
    await page.getByRole('button', { name: 'Next Cypher page', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '5 rows on page' })).toBeVisible()
    await cypher.fill('UNWIND range(1,10000) AS x UNWIND range(1,10000) AS y RETURN sum(x*y)')
    await page.getByRole('button', { name: 'Run Cypher', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel Cypher', exact: true }).click()
    await expect(page.getByText(/Neo4j query cancelled/)).toBeVisible()
    await cypher.fill('MATCH p=(n:HarborFixture {tag:$tag})-[r]-(m) RETURN p LIMIT 25')
    await parameters.fill(JSON.stringify([{ name: 'tag', type: 'string', value: tag }]))
    await page.getByRole('button', { name: 'Run Cypher', exact: true }).click()
    await page.getByRole('button', { name: 'Graph results', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Bounded Neo4j graph', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Inspect Neo4j relationship/ }).first().click()
    await expect(page.getByLabel('Neo4j relationship inspector')).toContainText('LINK')
    await page
      .getByRole('button', { name: /^Inspect Neo4j node/ })
      .first()
      .click()
    await expect(page.getByLabel('Neo4j property inspector')).toBeVisible()
    await page.getByRole('button', { name: 'Prepare one-hop expansion', exact: true }).click()
    await expect(cypher).toHaveValue(/LIMIT 50/)
    await expect(page.getByRole('status').filter({ hasText: 'no expansion has run yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Run Cypher', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Read complete' })).toBeVisible()
    await page.getByLabel('Neo4j execution mode', { exact: true }).selectOption('mutation')
    await cypher.fill('CREATE(n:HarborFixture {tag:$tag, exact:$exact}) RETURN n')
    await parameters.fill(
      JSON.stringify([
        { name: 'tag', type: 'string', value: tag },
        { name: 'exact', type: 'integer', value: '9007199254740993' },
      ]),
    )
    await expect(page.getByRole('button', { name: 'Run Cypher', exact: true })).toBeDisabled()
    const state = await page.evaluate(() => window.harbor.bootstrap()),
      profile = state.profiles.find((profile) => profile.name === 'Neo4j native fixture')!
    await page
      .getByLabel('Confirm Neo4j mutation', { exact: true })
      .fill(neoConfirmation(profile.id, 'neo4j'))
    await page.getByRole('button', { name: 'Run Cypher', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Mutation committed and acknowledged' }),
    ).toBeVisible()
    expect(
      (await native('MATCH(n:HarborFixture {tag:$tag}) RETURN count(n) AS count')).records[0]!.get(
        'count',
      ).toString(),
    ).toBe('3')
    await page
      .getByRole('button', { name: /^Inspect Neo4j node/ })
      .first()
      .click()
    await expect(page.getByLabel('Neo4j property inspector')).toContainText('9007199254740993')
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.getByRole('button', { name: 'Graph results', exact: true })).toBeVisible()
    await page.screenshot({ path: fixture + '/native-compact.png' })
    const final = await page.evaluate(() => window.harbor.bootstrap())
    expect(JSON.stringify(final)).not.toContain(password)
    expect(JSON.stringify(final)).not.toContain(tag)
    expect(final.history).toHaveLength(0)
  } finally {
    await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await desktop?.close()
    await native('MATCH(n:HarborFixture {tag:$tag}) DETACH DELETE n')
    await control.close()
    await rm(directory, { recursive: true, force: true })
  }
})
