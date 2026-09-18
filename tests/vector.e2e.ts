import { createServer, type Server } from 'node:http'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')

test('Qdrant vector workspace discovers a collection and performs one bounded search', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-vector-desktop-'))
  let desktop: ElectronApplication | undefined
  let server: Server | undefined
  try {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/') response.end(JSON.stringify({ version: '1.14.1' }))
      else if (request.url === '/collections')
        response.end(JSON.stringify({ result: { collections: [{ name: 'articles' }] } }))
      else if (request.url === '/collections/articles')
        response.end(JSON.stringify({ result: { status: 'green', points_count: 1, indexed_vectors_count: 1, segments_count: 1, config: { params: { vectors: { size: 3, distance: 'Cosine' } } } } }))
      else if (request.url === '/collections/articles/points/query') {
        let bytes = ''
        request.on('data', (chunk) => { bytes += String(chunk) })
        request.on('end', () => {
          const body = JSON.parse(bytes) as { limit: number; with_vector: boolean }
          expect(body).toMatchObject({ limit: 50, with_vector: false })
          response.end(JSON.stringify({ result: { points: [{ id: 'article-1', score: 0.99, payload: { title: 'Bounded result' }, vector: [1, 2, 3] }] } }))
        })
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' })) }
    })
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Vector fixture did not bind.')
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await _electron.launch({ chromiumSandbox: true, args: [root], cwd: root, env: { ...env, HARBOR_USER_DATA: userData } })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const profile = profileSchema.parse({ id: 'vector-qdrant', name: 'Local Qdrant fixture', engine: 'qdrant', host: '127.0.0.1', port: address.port, readOnly: true, tls: { enabled: false, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' } })
    const status = await page.evaluate(async (value) => {
      await window.harbor.saveProfile({ profile: value, rememberPassword: false })
      return window.harbor.connect({ id: value.id })
    }, profile)
    expect(status).toMatchObject({ state: 'connected', version: '1.14.1' })
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
    await expect(page.getByText('Local Qdrant fixture vector workspace', { exact: true })).toBeVisible()
    await expect(page.getByText(/articles.*3 dimensions.*Cosine/s)).toBeVisible()
    await page.getByRole('button', { name: 'Bounded search', exact: true }).click()
    await expect(page.getByText('1 hits', { exact: false })).toBeVisible()
    await expect(page.getByText('Bounded result', { exact: false })).toBeVisible()
    await expect(page.getByText('1, 2, 3', { exact: false })).toHaveCount(0)
    await page.getByText('Reviewed point mutation', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Upsert one point', exact: true })).toBeDisabled()
  } finally {
    await desktop?.close()
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()) || resolveClose())
    await rm(userData, { recursive: true, force: true })
  }
})
