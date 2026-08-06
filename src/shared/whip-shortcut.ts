export const DEFAULT_WHIP_SHORTCUT = 'mod+shift+x'

export const WHIP_SHORTCUT_MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const
export type WhipShortcutModifier = (typeof WHIP_SHORTCUT_MODIFIERS)[number]

export const RESERVED_WHIP_SHORTCUTS = [
  'mod+w',
  'mod+shift+w',
  'ctrl+w',
  'ctrl+shift+w',
  'meta+w',
  'meta+shift+w',
] as const

export interface ParsedWhipShortcut {
  modifiers: ReadonlySet<WhipShortcutModifier>
  key: string
}

const RESERVED_WHIP_SHORTCUT_SET = new Set<string>(RESERVED_WHIP_SHORTCUTS)
const NON_KEY_TOKENS = new Set<string>(['control', ...WHIP_SHORTCUT_MODIFIERS])

export function isReservedWhipShortcut(value: string): boolean {
  return RESERVED_WHIP_SHORTCUT_SET.has(value)
}

export function parseWhipShortcut(value: unknown): ParsedWhipShortcut | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.toLowerCase()) return null
  if (isReservedWhipShortcut(value)) return null

  const tokens = value.split('+')
  if (tokens.some((token) => token.length === 0)) return null

  const key = tokens.at(-1)
  if (!key || !/^[a-z0-9][a-z0-9_-]*$/.test(key) || NON_KEY_TOKENS.has(key)) return null

  const modifiers = tokens.slice(0, -1)
  const parsedModifiers = new Set<WhipShortcutModifier>()
  let previousIndex = -1
  for (const modifier of modifiers) {
    const index = WHIP_SHORTCUT_MODIFIERS.indexOf(modifier as WhipShortcutModifier)
    if (index <= previousIndex) return null
    previousIndex = index
    parsedModifiers.add(modifier as WhipShortcutModifier)
  }

  return { modifiers: parsedModifiers, key }
}

export function isValidWhipShortcut(value: unknown): value is string {
  return parseWhipShortcut(value) !== null
}
