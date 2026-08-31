// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isTypingTarget, type PaletteEntry, rankCommands } from '../utils/command-palette'

const noop = () => {}
const entries: PaletteEntry[] = [
  { id: 'focus-chat', label: 'Focus the chat input', icon: 'chat', run: noop },
  { id: 'open-settings', label: 'Open settings', icon: 'settings', run: noop },
  { id: 'ws-a', label: 'Refonte du panneau git', icon: 'folder', hint: 'feature/git-panel-refactor', run: noop },
  { id: 'ws-b', label: 'Migration Codex', icon: 'folder', hint: 'feature/codex-app-server', run: noop },
]

describe('rankCommands', () => {
  it('returns everything, in source order, for an empty query', () => {
    expect(rankCommands('', entries).map((e) => e.id)).toEqual(['focus-chat', 'open-settings', 'ws-a', 'ws-b'])
    expect(rankCommands('   ', entries).map((e) => e.id)).toEqual(['focus-chat', 'open-settings', 'ws-a', 'ws-b'])
  })

  it('matches on the hint, not only on the label', () => {
    expect(rankCommands('refactor', entries).map((e) => e.id)).toEqual(['ws-a'])
  })

  it('is fuzzy, not a substring test', () => {
    expect(rankCommands('opnst', entries).map((e) => e.id)).toContain('open-settings')
  })

  it('is case-insensitive', () => {
    expect(rankCommands('SETTINGS', entries).map((e) => e.id)).toContain('open-settings')
  })

  it('ranks a label hit above a hint-only hit', () => {
    expect(rankCommands('codex', entries).map((e) => e.id)[0]).toBe('ws-b')
  })

  it('returns an empty list when nothing matches', () => {
    expect(rankCommands('zzzz', entries)).toEqual([])
  })
})

describe('isTypingTarget', () => {
  it('detects an input', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
  })

  it('detects a textarea', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
  })

  it('detects a contenteditable element', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(isTypingTarget(div)).toBe(true)
  })

  it('ignores a plain element and a null target', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
