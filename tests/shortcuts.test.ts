import { describe, expect, it } from 'vitest'
import {
  applicationShortcut,
  matchesShortcut,
  shortcutAccelerator,
  shortcutKeys,
  shortcutLabel,
  shortcutPlatform,
  type ShortcutPlatform,
} from '../src/shared/shortcuts'

describe.each(['darwin', 'win32', 'linux'] as const)('%s shortcuts', (platform: ShortcutPlatform) => {
  const mac = platform === 'darwin'
  const event = (key: string, shiftKey = false) => ({
    key,
    shiftKey,
    metaKey: mac,
    ctrlKey: !mac,
    altKey: false,
  })
  it('maps execution, save, search and tab creation consistently', () => {
    for (const [key, action] of [
      ['Enter', 'run-current'],
      ['s', 'save-query'],
      ['k', 'command-palette'],
      ['t', 'new-query'],
      ['w', 'close-tab'],
    ] as const) {
      expect(applicationShortcut(event(key), platform)).toBe(action)
      expect(shortcutLabel(action, platform)).toBe(
        `${mac ? 'Command' : 'Ctrl'}+${key.length === 1 ? key.toUpperCase() : key}`,
      )
      expect(shortcutAccelerator(action, platform)).toBe(
        `${mac ? 'Command' : 'Control'}+${key.length === 1 ? key.toUpperCase() : key}`,
      )
    }
    expect(applicationShortcut(event('Enter', true), platform)).toBe('run-script')
    expect(applicationShortcut({ ...event('s'), altKey: true }, platform)).toBeUndefined()
    expect(applicationShortcut({ ...event('s'), metaKey: !mac, ctrlKey: mac }, platform)).toBeUndefined()
  })
  it('keeps Control+Tab navigation separate from the operating system Command+Tab', () => {
    const tab = { key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(applicationShortcut(tab, platform)).toBe('next-tab')
    expect(applicationShortcut({ ...tab, shiftKey: true }, platform)).toBe('previous-tab')
    expect(applicationShortcut({ ...tab, ctrlKey: false, metaKey: true }, platform)).toBeUndefined()
  })
  it('uses Monaco document navigation and select-all on the host platform', () => {
    expect(shortcutKeys('editor-start', platform)).toBe(mac ? 'Meta+ArrowUp' : 'Control+Home')
    expect(shortcutKeys('editor-select-end', platform)).toBe(
      mac ? 'Meta+Shift+ArrowDown' : 'Control+Shift+End',
    )
    expect(shortcutKeys('editor-select-all', platform)).toBe(mac ? 'Meta+a' : 'Control+a')
    expect(matchesShortcut(event(mac ? 'ArrowUp' : 'Home'), 'editor-start', platform)).toBe(true)
    expect(applicationShortcut(event('a'), platform)).toBeUndefined()
  })
})
it('recognizes the renderer and native host platform names', () => {
  expect(shortcutPlatform('MacIntel')).toBe('darwin')
  expect(shortcutPlatform('darwin')).toBe('darwin')
  expect(shortcutPlatform('Win32')).toBe('win32')
  expect(shortcutPlatform('Linux aarch64')).toBe('linux')
})
