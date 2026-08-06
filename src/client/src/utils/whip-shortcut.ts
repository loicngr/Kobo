import {
  DEFAULT_WHIP_SHORTCUT,
  isReservedWhipShortcut,
  isValidWhipShortcut,
  parseWhipShortcut,
  WHIP_SHORTCUT_MODIFIERS,
  type WhipShortcutModifier,
} from '../../../shared/whip-shortcut'

export { DEFAULT_WHIP_SHORTCUT, isValidWhipShortcut, parseWhipShortcut }

export type WhipShortcutPlatform = 'mac' | 'other'

export type ShortcutCaptureResult =
  | { status: 'accepted'; shortcut: string }
  | { status: 'cancelled' | 'pending' | 'reserved' }

const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift'])

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  '+': 'plus',
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'quote',
  '[': 'bracketleft',
  ']': 'bracketright',
  '`': 'backquote',
}

function normalizeKey(key: string): string | null {
  const normalized = KEY_ALIASES[key] ?? key.toLowerCase()
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : null
}

export function detectWhipShortcutPlatform(platform = globalThis.navigator?.platform ?? ''): WhipShortcutPlatform {
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other'
}

export function captureWhipShortcut(event: KeyboardEvent, platform: WhipShortcutPlatform): ShortcutCaptureResult {
  if (event.key === 'Escape') return { status: 'cancelled' }
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return { status: 'pending' }

  const key = normalizeKey(event.key)
  if (!key) return { status: 'pending' }

  const pressedModifiers = new Set<WhipShortcutModifier>()
  const primaryPressed = platform === 'mac' ? event.metaKey : event.ctrlKey
  if (primaryPressed) pressedModifiers.add('mod')
  if (platform === 'mac' && event.ctrlKey) pressedModifiers.add('ctrl')
  if (platform === 'other' && event.metaKey) pressedModifiers.add('meta')
  if (event.altKey) pressedModifiers.add('alt')
  if (event.shiftKey) pressedModifiers.add('shift')

  const modifiers = WHIP_SHORTCUT_MODIFIERS.filter((modifier) => pressedModifiers.has(modifier))
  const shortcut = [...modifiers, key].join('+')
  return isReservedWhipShortcut(shortcut) ? { status: 'reserved' } : { status: 'accepted', shortcut }
}

export function matchesWhipShortcut(event: KeyboardEvent, shortcut: string, platform: WhipShortcutPlatform): boolean {
  const parsed = parseWhipShortcut(shortcut)
  const eventKey = normalizeKey(event.key)
  if (!parsed || !eventKey || eventKey !== parsed.key) return false

  const expectsCtrl = parsed.modifiers.has('ctrl') || (platform === 'other' && parsed.modifiers.has('mod'))
  const expectsMeta = parsed.modifiers.has('meta') || (platform === 'mac' && parsed.modifiers.has('mod'))

  return (
    event.ctrlKey === expectsCtrl &&
    event.metaKey === expectsMeta &&
    event.altKey === parsed.modifiers.has('alt') &&
    event.shiftKey === parsed.modifiers.has('shift')
  )
}

function formatKey(key: string): string {
  const labels: Record<string, string> = {
    space: 'Space',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
  }
  return labels[key] ?? key.toUpperCase()
}

export function formatWhipShortcut(shortcut: string, platform: WhipShortcutPlatform): string {
  const parsed = parseWhipShortcut(shortcut)
  if (!parsed) return shortcut

  if (platform === 'mac') {
    const symbols = [
      parsed.modifiers.has('mod') || parsed.modifiers.has('meta') ? '⌘' : '',
      parsed.modifiers.has('ctrl') ? '⌃' : '',
      parsed.modifiers.has('alt') ? '⌥' : '',
      parsed.modifiers.has('shift') ? '⇧' : '',
    ]
    return `${symbols.join('')}${formatKey(parsed.key)}`
  }

  const labels = [
    parsed.modifiers.has('mod') || parsed.modifiers.has('ctrl') ? 'Ctrl' : '',
    parsed.modifiers.has('meta') ? 'Meta' : '',
    parsed.modifiers.has('alt') ? 'Alt' : '',
    parsed.modifiers.has('shift') ? 'Shift' : '',
    formatKey(parsed.key),
  ]
  return labels.filter(Boolean).join('+')
}
