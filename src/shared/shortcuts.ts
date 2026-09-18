export type ShortcutPlatform = 'darwin' | 'win32' | 'linux'
type Binding = { key: string; modifier: 'primary' | 'control'; shift?: boolean }
type ShortcutDefinition = Binding & { macKey?: string; scope: 'application' | 'editor' }

// Keep physical keys and platform overrides here. Menus, hints, keyboard handlers,
// Monaco bindings and desktop tests all derive their shortcuts from this catalog.
export const shortcuts = {
  'new-connection': { key: 'n', modifier: 'primary', shift: true, scope: 'application' },
  'new-query': { key: 't', modifier: 'primary', scope: 'application' },
  'import-sql': { key: 'o', modifier: 'primary', scope: 'application' },
  'save-query': { key: 's', modifier: 'primary', scope: 'application' },
  'close-tab': { key: 'w', modifier: 'primary', scope: 'application' },
  'command-palette': { key: 'k', modifier: 'primary', scope: 'application' },
  settings: { key: ',', modifier: 'primary', scope: 'application' },
  'run-current': { key: 'Enter', modifier: 'primary', scope: 'application' },
  'run-script': { key: 'Enter', modifier: 'primary', shift: true, scope: 'application' },
  'cancel-query': { key: '.', modifier: 'primary', scope: 'application' },
  'next-tab': { key: 'Tab', modifier: 'control', scope: 'application' },
  'previous-tab': { key: 'Tab', modifier: 'control', shift: true, scope: 'application' },
  'editor-select-all': { key: 'a', modifier: 'primary', scope: 'editor' },
  'editor-start': { key: 'Home', macKey: 'ArrowUp', modifier: 'primary', scope: 'editor' },
  'editor-end': { key: 'End', macKey: 'ArrowDown', modifier: 'primary', scope: 'editor' },
  'editor-select-end': {
    key: 'End',
    macKey: 'ArrowDown',
    modifier: 'primary',
    shift: true,
    scope: 'editor',
  },
} as const satisfies Record<string, ShortcutDefinition>

export type ShortcutAction = keyof typeof shortcuts
export function shortcutPlatform(platform: string): ShortcutPlatform {
  return /mac|darwin|iphone|ipad/i.test(platform) ? 'darwin' : /win/i.test(platform) ? 'win32' : 'linux'
}
export function shortcutBinding(action: ShortcutAction, platform: ShortcutPlatform): Binding {
  const definition: ShortcutDefinition = shortcuts[action]
  return {
    key: platform === 'darwin' ? definition.macKey || definition.key : definition.key,
    modifier: definition.modifier,
    shift: definition.shift,
  }
}
export function shortcutLabel(action: ShortcutAction, platform: ShortcutPlatform): string {
  const binding = shortcutBinding(action, platform)
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key.replace('Arrow', '')
  return [
    binding.modifier === 'primary' && platform === 'darwin' ? 'Command' : 'Ctrl',
    ...(binding.shift ? ['Shift'] : []),
    key,
  ].join('+')
}
export function shortcutAccelerator(action: ShortcutAction, platform: ShortcutPlatform): string {
  return shortcutLabel(action, platform).replace(/^Ctrl/, 'Control')
}
export function shortcutKeys(action: ShortcutAction, platform: ShortcutPlatform): string {
  const binding = shortcutBinding(action, platform)
  return [
    binding.modifier === 'primary' && platform === 'darwin' ? 'Meta' : 'Control',
    ...(binding.shift ? ['Shift'] : []),
    binding.key,
  ].join('+')
}
type KeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
export function matchesShortcut(
  event: KeyEvent,
  action: ShortcutAction,
  platform: ShortcutPlatform,
): boolean {
  const binding = shortcutBinding(action, platform)
  const meta = binding.modifier === 'primary' && platform === 'darwin'
  return (
    event.key.toLowerCase() === binding.key.toLowerCase() &&
    event.metaKey === meta &&
    event.ctrlKey === !meta &&
    event.shiftKey === !!binding.shift &&
    !event.altKey
  )
}
export function applicationShortcut(event: KeyEvent, platform: ShortcutPlatform): ShortcutAction | undefined {
  return (Object.keys(shortcuts) as ShortcutAction[]).find(
    (action) => shortcuts[action].scope === 'application' && matchesShortcut(event, action, platform),
  )
}
