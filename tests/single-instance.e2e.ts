import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectElectronSandbox, waitForElectronWorkspace } from './electron-runtime'

test('a second launch exits without creating a window and restores the existing workspace', async () => {
  const root = resolve(import.meta.dirname, '..')
  const temporary = await mkdtemp(join(tmpdir(), 'harbor-single-instance-'))
  const primaryExecutable = process.env.HARBOR_PRIMARY_EXECUTABLE
  const secondaryExecutable = process.env.HARBOR_SECONDARY_EXECUTABLE
  const packaged = !!primaryExecutable
  if (packaged && !secondaryExecutable) throw new Error('Both package executable paths are required.')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'HARBOR_USER_DATA'].includes(entry[0]),
    ),
  )
  Object.assign(
    env,
    packaged ? { XDG_CONFIG_HOME: temporary } : { HARBOR_USER_DATA: join(temporary, 'profile') },
  )
  const observer = join(temporary, 'observe-startup.cjs')
  // Observe real startup without replacing the lock, dialogs, or shutdown behavior.
  await writeFile(
    observer,
    "require('electron').app.on('browser-window-created', () => process.stderr.write('HARBOR_SECONDARY_WINDOW_CREATED\\n'))\n",
  )
  let desktop: ElectronApplication | undefined
  let secondary: ChildProcess | undefined
  try {
    desktop = await _electron.launch({
      ...(packaged ? { executablePath: primaryExecutable, args: [] } : { args: [root] }),
      chromiumSandbox: true,
      cwd: root,
      env,
    })
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await waitForElectronWorkspace(page)
    await expect(page).toHaveTitle('Harbor DB')
    expect(page.url()).toMatch(
      packaged ? /^file:.*app\.asar.*index\.html$/ : /^file:.*out\/renderer\/index\.html$/,
    )
    await inspectElectronSandbox(desktop, page)
    const before = await page.evaluate(() => window.harbor.bootstrap())
    const nativeWindow = await desktop.browserWindow(page)
    const handoffs: string[] = []
    desktop.on('console', (message) => handoffs.push(message.text()))
    await desktop.evaluate(({ app }) => {
      app.on('second-instance', () => console.log('HARBOR_SECOND_INSTANCE_RECEIVED'))
    })
    await nativeWindow.evaluate((window) => window.hide())
    await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(false)

    let stderr = ''
    secondary = spawn(
      secondaryExecutable || createRequire(import.meta.url)('electron'),
      packaged ? [] : ['-r', observer, root],
      { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    secondary.stderr!.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          secondary?.kill('SIGKILL')
          reject(new Error(`Second launch did not exit within 15 seconds. ${stderr}`))
        }, 15000)
        secondary!.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        secondary!.once('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      },
    )
    expect(result).toEqual({ code: 0, signal: null })
    expect(stderr).not.toMatch(/HARBOR_SECONDARY_WINDOW_CREATED|ERR_FAILED|Error loading app|FATAL/)
    await expect.poll(() => handoffs).toContain('HARBOR_SECOND_INSTANCE_RECEIVED')
    await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(true)
    expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(page.locator('.statusbar')).toBeVisible()
    const after = await page.evaluate(() => window.harbor.bootstrap())
    expect(after.profiles).toEqual(before.profiles)
    expect(after.workspace).toEqual(before.workspace)
    expect(errors).toEqual([])
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await mkdir('/tmp/harbor-db-e2e', { recursive: true })
    await page.screenshot({ path: '/tmp/harbor-db-e2e/single-instance.png' })
  } finally {
    if (secondary && secondary.exitCode === null && secondary.signalCode === null) secondary.kill('SIGKILL')
    try {
      if (desktop) await desktop.close()
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
})
