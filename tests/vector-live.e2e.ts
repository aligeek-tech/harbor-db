import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { vectorConfirmation } from '../src/shared/vector'
import { waitForElectronWorkspace } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.HARBOR_VECTOR_MILVUS_PORT || 0)

test.skip(!port, 'Set HARBOR_VECTOR_MILVUS_PORT for the disposable live Milvus fixture.')
test('Milvus catalog, bounded search, hidden vectors, and reviewed mutation work in Electron', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'harbor-milvus-desktop-'))
  let desktop: ElectronApplication | undefined
  try {
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
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({
      id: 'live-milvus-ui',
      name: 'Live Milvus acceptance',
      engine: 'milvus',
      host: '127.0.0.1',
      port,
      database: 'default',
      readOnly: false,
      tls: { enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    })
    const status = await page.evaluate(async (value) => {
      await window.harbor.saveProfile({ profile: value, rememberPassword: false })
      return window.harbor.connect({ id: value.id })
    }, profile)
    expect(status).toMatchObject({ state: 'connected', version: 'Milvus REST v2' })
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByText('Live Milvus acceptance vector workspace', { exact: true })).toBeVisible()
    await expect(page.getByText(/harbor_articles.*3 dimensions.*COSINE/s)).toBeVisible()

    const queryVector = page.locator('label').filter({ hasText: 'Query vector' }).locator('textarea')
    const filter = page.locator('label').filter({ hasText: 'Provider filter JSON' }).locator('textarea')
    await queryVector.fill('[1, 0, 0]')
    await filter.fill('{"expression":"category == \\"docs\\""}')
    await page.getByRole('button', { name: 'Bounded search', exact: true }).click()
    await expect(page.getByText('2 hits', { exact: false })).toBeVisible()
    await expect(page.locator('pre').filter({ hasText: 'alpha' })).toContainText('beta')
    await expect(page.locator('pre').filter({ hasText: 'alpha' })).not.toContainText('"vector"')

    await page.getByText('Reviewed point mutation', { exact: true }).click()
    const target = vectorConfirmation({ connectionId: profile.id, collection: 'harbor_articles' })
    await queryVector.fill('[0.95, 0.05, 0]')
    await page.locator('label').filter({ hasText: 'Point/object ID' }).locator('input').fill('4')
    await page.locator('label').filter({ hasText: 'Payload/metadata JSON' }).locator('textarea').fill('{"title":"temporary-ui","category":"docs"}')
    await page.locator('label').filter({ hasText: 'Type exact target:' }).locator('input').fill(target)
    await page.getByRole('button', { name: 'Upsert one point', exact: true }).click()
    await page.waitForTimeout(750)
    await filter.fill('{"expression":"id == 4"}')
    await page.getByRole('button', { name: 'Bounded search', exact: true }).click()
    await expect(page.getByText('1 hits', { exact: false })).toBeVisible()
    await expect(page.locator('pre').filter({ hasText: 'temporary-ui' })).toBeVisible()

    await page.locator('label').filter({ hasText: 'Point/object ID' }).locator('input').fill('4')
    await page.locator('label').filter({ hasText: 'Type exact target:' }).locator('input').fill(target)
    await page.getByRole('button', { name: 'Delete one point', exact: true }).click()
    await page.waitForTimeout(750)
    await page.getByRole('button', { name: 'Bounded search', exact: true }).click()
    await expect(page.getByText('0 hits', { exact: false })).toBeVisible()
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
