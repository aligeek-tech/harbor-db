import { _electron, expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForElectronWorkspace } from './electron-runtime'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

test('native desktop keyboard dialogs and WCAG checks in light and dark themes', async () => {
  const root = resolve(import.meta.dirname, '..')
  const userData = await mkdtemp(join(tmpdir(), 'harbor-a11y-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  )
  const desktop = await _electron.launch({
    chromiumSandbox: true,
    args: [root],
    cwd: root,
    env: { ...env, HARBOR_USER_DATA: userData },
  })
  try {
    const page = await desktop.firstWindow()
    await waitForElectronWorkspace(page)
    const violations: unknown[] = []
    const check = async (view: string) => {
      expect(page.frames()).toHaveLength(1)
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect?.getComputedTiming().iterations === Infinity,
          ),
      )
      const result = await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      violations.push(
        ...result.violations.map((v) => ({
          view,
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        })),
      )
    }
    for (const theme of ['light', 'dark'] as const) {
      await page.getByRole('button', { name: 'Settings & preferences', exact: true }).click()
      await page.getByLabel(theme === 'light' ? 'Light theme' : 'Dark theme', { exact: true }).click()
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
      await check(`${theme} settings`)
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await check(`${theme} welcome`)
      await page.keyboard.press(shortcutKeys('new-connection', shortcutPlatform(process.platform)))
      const dialog = page.getByRole('dialog', { name: 'New connection', exact: true })
      await expect(dialog).toBeVisible()
      await check(`${theme} connection form`)
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.keyboard.press(shortcutKeys('command-palette', shortcutPlatform(process.platform)))
      const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
      await expect(palette).toBeVisible()
      await check(`${theme} palette`)
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
    }
    expect(violations).toEqual([])
  } finally {
    await desktop.close()
    await rm(userData, { recursive: true, force: true })
  }
})
