import { expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'

/** The preload bridge appears before the initial loadFile and renderer bootstrap finish. */
export async function waitForElectronWorkspace(page: Page) {
  await page.waitForFunction(() => !!window.harbor)
  await page.waitForLoadState('load')
  await expect(page.locator('.statusbar')).toBeVisible()
}

/** Inspect the running process; BrowserWindow preferences alone do not prove kernel isolation. */
export async function inspectElectronSandbox(desktop: ElectronApplication, page: Page) {
  const window = await desktop.browserWindow(page)
  const rendererPid = await window.evaluate((window) => window.webContents.getOSProcessId())
  const launch = await desktop.evaluate(({ app }) => ({
    mainPid: process.pid,
    disabledSwitches: [
      'no-sandbox',
      'disable-setuid-sandbox',
      'disable-seccomp-filter-sandbox',
      'disable-gpu-sandbox',
      'single-process',
      'no-zygote',
    ].filter((name) => app.commandLine.hasSwitch(name)),
    passwordStore: app.commandLine.getSwitchValue('password-store'),
    mockKeychain: app.commandLine.hasSwitch('use-mock-keychain'),
  }))
  expect(launch.disabledSwitches).toEqual([])
  if (process.platform !== 'linux') return { ...launch, kernel: null }

  const [rendererStatus, mainStatus, rendererCommand, appArmorProfile] = await Promise.all([
    readFile(`/proc/${rendererPid}/status`, 'utf8'),
    readFile(`/proc/${launch.mainPid}/status`, 'utf8'),
    readFile(`/proc/${rendererPid}/cmdline`, 'utf8'),
    readFile(`/proc/${launch.mainPid}/attr/current`, 'utf8'),
  ])
  const field = (status: string, name: string) =>
    status
      .split('\n')
      .find((line) => line.startsWith(`${name}:`))
      ?.split(':')[1]
      ?.trim() || ''
  const namespaceDepth = (status: string) => field(status, 'NSpid').split(/\s+/).filter(Boolean).length
  const kernel = {
    appArmorProfile: appArmorProfile.trim(),
    noNewPrivileges: field(rendererStatus, 'NoNewPrivs'),
    seccomp: field(rendererStatus, 'Seccomp'),
    seccompFilters: Number(field(rendererStatus, 'Seccomp_filters')),
    rendererPidNamespaceDepth: namespaceDepth(rendererStatus),
    mainPidNamespaceDepth: namespaceDepth(mainStatus),
    rendererDisablesSandbox: rendererCommand
      .split('\0')
      .some((arg) => ['--no-sandbox', '--disable-seccomp-filter-sandbox'].includes(arg)),
  }
  expect(kernel.noNewPrivileges).toBe('1')
  expect(kernel.seccomp).toBe('2')
  expect(kernel.seccompFilters).toBeGreaterThan(0)
  expect(kernel.rendererPidNamespaceDepth).toBeGreaterThan(kernel.mainPidNamespaceDepth)
  expect(kernel.rendererDisablesSandbox).toBe(false)
  return { ...launch, kernel }
}

/** Select through the searchable engine popup, preserving real form interaction. */
export async function selectDatabaseEngine(scope: Page | Locator, name: string) {
  await scope.getByRole('button', { name: /^Database engine:/ }).click()
  const page = 'page' in scope ? scope.page() : scope
  await page.getByRole('textbox', { name: 'Search databases', exact: true }).fill(name)
  await page.getByRole('radio', { name, exact: true }).click()
}
