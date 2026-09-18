import { shortcutLabel, shortcutPlatform, type ShortcutAction } from '@shared/shortcuts'

export const platform = shortcutPlatform(navigator.platform)
export const shortcutHint = (action: ShortcutAction) => shortcutLabel(action, platform)
