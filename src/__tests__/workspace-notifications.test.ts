import { describe, expect, it } from 'vitest'
import {
  allowsBrowser,
  allowsSound,
  allowsToast,
  DEFAULT_WORKSPACE_NOTIFICATION_PREFS as DEFAULT,
  hasAnyMute,
  isDefaultWorkspaceNotificationPrefs,
  normalizeWorkspaceNotificationPrefs,
  showsDrawerSignals,
  withAllMuted,
} from '../shared/workspace-notifications.js'

describe('normalizeWorkspaceNotificationPrefs', () => {
  it.each([undefined, null, 'x', 3, ['muteSound']])('returns the default for %j', (value) => {
    expect(normalizeWorkspaceNotificationPrefs(value)).toEqual(DEFAULT)
  })

  it('keeps known boolean keys and drops unknown ones', () => {
    expect(normalizeWorkspaceNotificationPrefs({ muteSound: true, keepQuestions: true, other: true })).toEqual({
      ...DEFAULT,
      muteSound: true,
      keepQuestions: true,
    })
  })

  it('does not accept "true" or 1 as true', () => {
    expect(normalizeWorkspaceNotificationPrefs({ muteSound: 'true', muteToast: 1 })).toEqual(DEFAULT)
  })
})

describe('predicates', () => {
  it('isDefault / hasAnyMute', () => {
    expect(isDefaultWorkspaceNotificationPrefs(DEFAULT)).toBe(true)
    expect(isDefaultWorkspaceNotificationPrefs({ ...DEFAULT, keepQuestions: true })).toBe(false)
    expect(hasAnyMute({ ...DEFAULT, keepQuestions: true })).toBe(false)
    expect(hasAnyMute({ ...DEFAULT, muteDrawer: true })).toBe(true)
  })

  it('withAllMuted keeps keepQuestions', () => {
    const on = withAllMuted({ ...DEFAULT, keepQuestions: true }, true)
    expect(on).toEqual({ muteBrowser: true, muteSound: true, muteToast: true, muteDrawer: true, keepQuestions: true })
    expect(withAllMuted(on, false)).toEqual({ ...DEFAULT, keepQuestions: true })
  })
})

describe('allows helpers', () => {
  it.each([
    [false, false, false, true],
    [false, true, true, true],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, true],
  ])('muted=%s keepQuestions=%s question=%s -> sound/toast %s', (muted, keep, question, expected) => {
    const p = { ...DEFAULT, muteSound: muted, muteToast: muted, keepQuestions: keep }
    expect(allowsSound(p, question)).toBe(expected)
    expect(allowsToast(p, question)).toBe(expected)
  })

  it('allowsBrowser is never restored by keepQuestions', () => {
    expect(allowsBrowser({ ...DEFAULT, muteBrowser: true, keepQuestions: true })).toBe(false)
    expect(allowsBrowser(DEFAULT)).toBe(true)
  })

  it('showsDrawerSignals follows muteDrawer', () => {
    expect(showsDrawerSignals({ ...DEFAULT, muteDrawer: true })).toBe(false)
  })

  it('all helpers are true for undefined prefs', () => {
    expect(allowsSound(undefined, false)).toBe(true)
    expect(allowsToast(undefined, true)).toBe(true)
    expect(allowsBrowser(undefined)).toBe(true)
    expect(showsDrawerSignals(undefined)).toBe(true)
  })
})
