import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

test('Redis key UI scans, stages, detects conflicts, edits collections, preserves tabs, and enforces read-only', async () => {
  test.skip(process.env.HARBOR_INTEGRATION !== '1', 'Requires the isolated Redis development service.')
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-redis-ui-'))
  const prefix = `harbor-ui:${randomUUID().slice(0, 8)}:`
  const profiles = [false, true].map((readOnly) =>
    profileSchema.parse({
      id: randomUUID(),
      name: readOnly ? 'Redis UI read-only' : 'Redis UI development',
      engine: 'redis',
      host: '127.0.0.1',
      port: 16379,
      redisDb: 15,
      readOnly,
      autoReconnect: true,
      environment: 'development',
    }),
  )
  const writable = profiles[0]!
  const original = '{"user_id":2481,"name":"Maya Chen","theme":"dark","notifications":true}'
  const updated = '{"user_id":2481,"name":"Maya Chen","theme":"light","notifications":true}'
  const fixtureNames = ['session', 'settings', 'new-key']
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
      timeout: 30000,
    })
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    await page.emulateMedia({ colorScheme: 'dark' })
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 900)
    })
    await page.evaluate(
      async ({ profiles, prefix, original }) => {
        for (const profile of profiles)
          await window.harbor.saveProfile({
            profile,
            secrets: { password: 'harbor_test' },
            rememberPassword: false,
          })
        const connectionId = profiles[0]!.id
        const status = await window.harbor.connect({ id: connectionId, secrets: { password: 'harbor_test' } })
        if (status.state !== 'connected') throw new Error(status.error)
        await window.harbor.redisMutate({
          connectionId,
          keyBase64: btoa(`${prefix}session`),
          action: 'set',
          value: original,
          ttl: 300,
        })
        await window.harbor.redisMutate({
          connectionId,
          keyBase64: btoa(`${prefix}settings`),
          action: 'hset',
          field: 'theme',
          value: 'dark',
        })
        await window.harbor.redisMutate({
          connectionId,
          keyBase64: btoa(`${prefix}settings`),
          action: 'hset',
          field: 'language',
          value: 'en-US',
        })
      },
      { profiles, prefix, original },
    )
    await page.reload()
    await expect(page.getByRole('button', { name: writable.name, exact: true })).toBeVisible()
    await expect(page.getByLabel(`${writable.name}: connected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: writable.name, exact: true }).click()
    await page.getByRole('button', { name: 'Browse keys', exact: true }).click()
    await page.getByLabel('Redis key pattern', { exact: true }).fill(`${prefix}*`)
    await page.getByRole('button', { name: 'Scan matching keys', exact: true }).click()
    const session = page
      .getByRole('button')
      .filter({ has: page.locator('strong', { hasText: `${prefix}session` }) })
    await expect(session).toBeVisible()
    await session.click()
    const rawValue = page.getByLabel('Raw string value', { exact: true })
    await expect(rawValue).toHaveValue(original)
    await rawValue.fill(updated)
    await expect(page.getByText('1 value change ready to apply')).toBeVisible()
    await page.locator('.toolbar:visible').getByRole('button', { name: 'Console', exact: true }).click()
    await expect(page.locator('.monaco-editor:visible')).toBeVisible()
    await page.getByRole('tab').filter({ hasText: 'Keys' }).first().click()
    await expect(rawValue).toHaveValue(updated)
    await expect(page.getByText('1 value change ready to apply')).toBeVisible()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByText('1 value change ready to apply')).toHaveCount(0)
    const applied = await page.evaluate(
      async ({ id, key }) =>
        window.harbor.redisInspect({
          connectionId: id,
          keyBase64: btoa(key),
          cursor: '0',
          offset: 0,
          count: 100,
        }),
      { id: writable.id, key: `${prefix}session` },
    )
    expect(applied.value).toBe(updated)
    expect(applied.key.ttl).toBeGreaterThan(0)
    expect(applied.key.ttl).toBeLessThanOrEqual(300)

    await rawValue.fill('stale edit stays local')
    await page.evaluate(
      async ({ id, key }) =>
        window.harbor.redisMutate({
          connectionId: id,
          keyBase64: btoa(key),
          action: 'set',
          value: 'changed by another client',
        }),
      { id: writable.id, key: `${prefix}session` },
    )
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'CONFLICT' })).toBeVisible()
    await expect(rawValue).toHaveValue('stale edit stays local')
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh Redis keys and selected value', exact: true }).click()
    await expect(rawValue).toHaveValue('changed by another client')

    await page
      .getByRole('button')
      .filter({ has: page.locator('strong', { hasText: `${prefix}settings` }) })
      .click()
    await expect(page.getByRole('columnheader', { name: 'Field', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Change collection', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Field', { exact: true }).fill('timezone')
    await dialog.getByLabel('Value', { exact: true }).fill('UTC')
    await dialog.getByRole('button', { name: 'Apply change', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('cell', { name: 'timezone', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'UTC', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close toast', exact: true })).toHaveCount(0, {
      timeout: 8000,
    })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/redis.png' })
    await page.emulateMedia({ colorScheme: 'light' })
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1024, 700)
    })
    await expect(page.getByRole('button', { name: 'Change collection', exact: true })).toBeVisible()
    await page.screenshot({ path: '/tmp/harbor-db-e2e/redis-light-compact.png' })

    const readonly = profiles[1]!
    await page.getByRole('button', { name: readonly.name, exact: true }).click()
    const readonlyGroup = page.locator('.connection-row').filter({ hasText: readonly.name }).locator('..')
    await readonlyGroup.getByRole('button', { name: 'Browse keys', exact: true }).click()
    const readonlyWorkspace = page
      .locator('.query-workspace:visible')
      .filter({ has: page.locator('.redis-layout:visible') })
      .last()
    await expect(readonlyWorkspace.getByRole('button', { name: 'New key', exact: true })).toBeDisabled()
    await readonlyWorkspace.getByLabel('Redis key pattern', { exact: true }).fill(`${prefix}*`)
    await readonlyWorkspace.getByRole('button', { name: 'Scan matching keys', exact: true }).click()
    await readonlyWorkspace
      .getByRole('button')
      .filter({ has: page.locator('strong', { hasText: `${prefix}session` }) })
      .click()
    await expect(readonlyWorkspace.getByLabel('Raw string value', { exact: true })).toHaveAttribute(
      'readonly',
      '',
    )
    await expect(readonlyWorkspace.getByRole('button', { name: 'Set TTL', exact: true })).toBeDisabled()
    await expect(readonlyWorkspace.getByRole('button', { name: 'Delete key', exact: true })).toBeDisabled()
    const rejected = await page.evaluate(
      async ({ id, key }) => {
        try {
          await window.harbor.redisMutate({ connectionId: id, keyBase64: btoa(key), action: 'delete' })
          return ''
        } catch (cause) {
          return String(cause)
        }
      },
      { id: readonly.id, key: `${prefix}session` },
    )
    expect(rejected).toMatch(/read-only|guarded browsing|enable writes/i)
    const retained = await page.evaluate(
      async ({ id, key }) =>
        window.harbor.redisInspect({
          connectionId: id,
          keyBase64: btoa(key),
          cursor: '0',
          offset: 0,
          count: 10,
        }),
      { id: readonly.id, key: `${prefix}session` },
    )
    expect(retained.value).toBe('changed by another client')
  } finally {
    if (desktop) {
      const page = await desktop.firstWindow().catch(() => undefined)
      await page
        ?.evaluate(
          async ({ id, prefix, names }) => {
            await window.harbor.connect({ id, secrets: { password: 'harbor_test' } })
            for (const name of names)
              await window.harbor.redisMutate({
                connectionId: id,
                keyBase64: btoa(`${prefix}${name}`),
                action: 'delete',
              })
            for (const profile of (await window.harbor.bootstrap()).profiles)
              await window.harbor.disconnect(profile.id)
          },
          { id: writable.id, prefix, names: fixtureNames },
        )
        .catch(() => {})
      await desktop.close().catch(() => desktop?.process().kill('SIGTERM'))
    }
    await rm(userData, { recursive: true, force: true })
  }
})
