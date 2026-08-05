import { describe, expect, it } from 'vitest'
import {
  captureWhipShortcut,
  detectWhipShortcutPlatform,
  formatWhipShortcut,
  matchesWhipShortcut,
} from '../utils/whip-shortcut'

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...init })
}

describe('whip shortcut capture', () => {
  it('normalizes the primary modifier to mod on each platform', () => {
    expect(captureWhipShortcut(keyEvent('X', { metaKey: true, shiftKey: true }), 'mac')).toEqual({
      status: 'accepted',
      shortcut: 'mod+shift+x',
    })
    expect(captureWhipShortcut(keyEvent('x', { ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      status: 'accepted',
      shortcut: 'mod+shift+x',
    })
  })

  it('accepts a single non-modifier key', () => {
    expect(captureWhipShortcut(keyEvent('k'), 'other')).toEqual({ status: 'accepted', shortcut: 'k' })
  })

  it('uses Escape to cancel and waits through modifier-only input', () => {
    expect(captureWhipShortcut(keyEvent('Escape'), 'other')).toEqual({ status: 'cancelled' })
    expect(captureWhipShortcut(keyEvent('Shift', { shiftKey: true }), 'other')).toEqual({ status: 'pending' })
  })

  it.each([
    ['other', { ctrlKey: true }],
    ['mac', { metaKey: true }],
    ['other', { ctrlKey: true, shiftKey: true }],
    ['mac', { metaKey: true, shiftKey: true }],
  ] as const)('rejects browser close shortcuts on %s', (platform, modifiers) => {
    expect(captureWhipShortcut(keyEvent('w', modifiers), platform)).toEqual({ status: 'reserved' })
  })
})

describe('whip shortcut matching', () => {
  it('maps mod to the current platform primary modifier', () => {
    expect(matchesWhipShortcut(keyEvent('x', { metaKey: true, shiftKey: true }), 'mod+shift+x', 'mac')).toBe(true)
    expect(matchesWhipShortcut(keyEvent('x', { ctrlKey: true, shiftKey: true }), 'mod+shift+x', 'other')).toBe(true)
  })

  it('requires the exact key and modifier set', () => {
    expect(matchesWhipShortcut(keyEvent('x', { ctrlKey: true }), 'mod+shift+x', 'other')).toBe(false)
    expect(
      matchesWhipShortcut(keyEvent('x', { ctrlKey: true, shiftKey: true, altKey: true }), 'mod+shift+x', 'other'),
    ).toBe(false)
    expect(matchesWhipShortcut(keyEvent('k'), 'j', 'other')).toBe(false)
  })

  it('never matches a reserved or malformed persisted shortcut', () => {
    expect(matchesWhipShortcut(keyEvent('w', { ctrlKey: true }), 'mod+w', 'other')).toBe(false)
    expect(matchesWhipShortcut(keyEvent('x', { ctrlKey: true }), 'mod++x', 'other')).toBe(false)
  })
})

describe('whip shortcut presentation', () => {
  it('detects macOS independently of case', () => {
    expect(detectWhipShortcutPlatform('MacIntel')).toBe('mac')
    expect(detectWhipShortcutPlatform('macOS')).toBe('mac')
    expect(detectWhipShortcutPlatform('Win32')).toBe('other')
  })

  it('formats the portable shortcut for each platform', () => {
    expect(formatWhipShortcut('mod+shift+x', 'mac')).toBe('⌘⇧X')
    expect(formatWhipShortcut('mod+shift+x', 'other')).toBe('Ctrl+Shift+X')
    expect(formatWhipShortcut('alt+k', 'mac')).toBe('⌥K')
    expect(formatWhipShortcut('k', 'other')).toBe('K')
  })
})
