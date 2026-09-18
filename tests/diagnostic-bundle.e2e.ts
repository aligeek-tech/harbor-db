import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { profileSchema, savedQuerySchema } from '../src/shared/contracts'
import { diagnosticBundleSchema } from '../src/shared/diagnostic-bundle'
import { waitForElectronWorkspace } from './electron-runtime'

const root = resolve(import.meta.dirname, '..')

test('diagnostic export saves exactly the reviewed aggregate bundle without workspace canaries', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'harbor-diagnostics-'))
  const exportPath = join(userData, 'reviewed-diagnostics.json')
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
      id: 'diagnostic-private-profile',
      name: 'CANARY_PROFILE_CUSTOMER_PRODUCTION',
      engine: 'postgres',
      host: 'db.private.example',
      port: 5432,
      username: 'private-owner@example.com',
    })
    const savedQuery = savedQuerySchema.parse({
      id: 'diagnostic-private-query',
      name: 'CANARY_SAVED_QUERY_PRIVATE',
      engine: 'postgres',
      connectionId: profile.id,
      sql: "SELECT 'CANARY_SQL_PRIVATE'",
      folder: '',
      tags: [],
      parameterDefinitions: [],
      updatedAt: '2026-09-18T12:00:00.000Z',
    })
    await page.evaluate(async ({ profile, savedQuery }) => {
      await window.harbor.saveProfile({ profile, rememberPassword: false })
      await window.harbor.saveQuery(savedQuery)
      const state = await window.harbor.bootstrap()
      await window.harbor.saveWorkspace({
        ...state.workspace,
        tabs: [
          {
            id: 'diagnostic-private-tab',
            connectionId: profile.id,
            kind: 'query',
            title: 'CANARY_TAB_PRIVATE',
            sql: "SELECT 'CANARY_DRAFT_PRIVATE'",
          },
        ],
        activeTabId: 'diagnostic-private-tab',
      })
    }, { profile, savedQuery })
    await page.reload()
    await waitForElectronWorkspace(page)
    await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Make yourself at home', exact: true })
    await expect(settings).toContainText('Updates are manual downloads')
    await settings.getByRole('button', { name: 'Review diagnostic bundle', exact: true }).click()
    const preview = settings.getByLabel('Diagnostic bundle preview', { exact: true })
    await expect(preview).toBeVisible()
    const reviewed = await preview.inputValue()
    const parsed = diagnosticBundleSchema.parse(JSON.parse(reviewed))
    expect(parsed.storage.counts).toMatchObject({ profiles: 1, savedQueries: 1, openTabs: 1 })
    expect(parsed.distribution).toMatchObject({
      automaticUpdates: false,
      updatePolicy: 'manual-download',
      signatureVerification: 'unknown',
      notarizationVerification: 'unknown',
    })
    for (const canary of [
      'diagnostic-private-profile',
      'CANARY_PROFILE_CUSTOMER_PRODUCTION',
      'db.private.example',
      'private-owner@example.com',
      'diagnostic-private-query',
      'CANARY_SAVED_QUERY_PRIVATE',
      'CANARY_SQL_PRIVATE',
      'diagnostic-private-tab',
      'CANARY_TAB_PRIVATE',
      'CANARY_DRAFT_PRIVATE',
      userData,
    ])
      expect(reviewed).not.toContain(canary)

    await desktop.evaluate(({ dialog }, path) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath: path }
      }
    }, exportPath)
    await settings.getByRole('button', { name: 'Export reviewed bundle', exact: true }).click()
    await expect(page.getByText('Reviewed diagnostic bundle exported', { exact: true })).toBeVisible()
    expect(await readFile(exportPath, 'utf8')).toBe(`${reviewed}\n`)
  } finally {
    await desktop?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
