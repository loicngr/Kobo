export type WhipShortcutPlatform = 'mac' | 'other'

export type ShortcutCaptureResult =
  | { status: 'accepted'; shortcut: string }
  | { status: 'cancelled' | 'pending' | 'reserved' }

const MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const
const MODIFIER_KEYS = new Set(['control', 'meta', 'alt', 'shift'])
const RESERVED_SHORTCUTS = new Set(['mod+w', 'mod+shift+w', 'ctrl+w', 'ctrl+shift+w', 'meta+w', 'meta+shift+w'])

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

interface ParsedShortcut {
  modifiers: Set<string>
  key: string
}

function normalizeKey(key: string): string | null {
  const normalized = KEY_ALIASES[key] ?? key.toLowerCase()
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : null
}

function parseShortcut(shortcut: string): ParsedShortcut | null {
  if (RESERVED_SHORTCUTS.has(shortcut)) return null
  const tokens = shortcut.split('+')
  if (tokens.some((token) => token.length === 0)) return null

  const key = tokens.at(-1)
  if (!key || !/^[a-z0-9][a-z0-9_-]*$/.test(key) || MODIFIER_KEYS.has(key) || key === 'mod') return null

  const modifiers = tokens.slice(0, -1)
  let previousIndex = -1
  for (const modifier of modifiers) {
    const index = MODIFIERS.indexOf(modifier as (typeof MODIFIERS)[number])
    if (index <= previousIndex) return null
    previousIndex = index
  }

  return { modifiers: new Set(modifiers), key }
}

export function detectWhipShortcutPlatform(platform = globalThis.navigator?.platform ?? ''): WhipShortcutPlatform {
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other'
}

export function captureWhipShortcut(event: KeyboardEvent, platform: WhipShortcutPlatform): ShortcutCaptureResult {
  if (event.key === 'Escape') return { status: 'cancelled' }
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return { status: 'pending' }

  const key = normalizeKey(event.key)
  if (!key) return { status: 'pending' }

  const modifiers: string[] = []
  const primaryPressed = platform === 'mac' ? event.metaKey : event.ctrlKey
  if (primaryPressed) modifiers.push('mod')
  if (platform === 'mac' && event.ctrlKey) modifiers.push('ctrl')
  if (platform === 'other' && event.metaKey) modifiers.push('meta')
  if (event.altKey) modifiers.push('alt')
  if (event.shiftKey) modifiers.push('shift')

  const shortcut = [...modifiers, key].join('+')
  return RESERVED_SHORTCUTS.has(shortcut) ? { status: 'reserved' } : { status: 'accepted', shortcut }
}

export function matchesWhipShortcut(event: KeyboardEvent, shortcut: string, platform: WhipShortcutPlatform): boolean {
  const parsed = parseShortcut(shortcut)
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
  const parsed = parseShortcut(shortcut)
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
