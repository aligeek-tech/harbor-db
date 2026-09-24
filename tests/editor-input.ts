import { expect, type Page } from '@playwright/test'
import { shortcutKeys, shortcutPlatform } from '../src/shared/shortcuts'

/** Use real keyboard input; never replace Monaco models or inject workspace state. */
export async function typeSql(page: Page, sql: string, bulkInput = false) {
  const editor = page.locator('.monaco-editor:visible textarea').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await expect(editor).toBeFocused()
  await editor.press(shortcutKeys('editor-select-all', shortcutPlatform(process.platform)))
  // Bulk input models paste/IME entry for long fixtures without changing the model
  // directly or counting thousands of automation key events as application latency.
  if (bulkInput) await page.keyboard.insertText(sql)
  else await editor.pressSequentially(sql)
  // Monaco's textarea deliberately exposes only a small accessibility window.
  // Read its complete onChange value through the existing persisted workspace API
  // and require exact equality before callers can execute or save the draft.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { workspace } = await window.harbor.bootstrap()
        return workspace.tabs.find((tab) => tab.id === workspace.activeTabId)?.sql
      }),
    )
    .toBe(sql)
  return editor
}
