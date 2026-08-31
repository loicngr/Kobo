import { describe, expect, it } from 'vitest'
import { BUSY_STATUSES, isAgentStatusStale, isBusyStatus, shouldWarnAgentNotRunning } from '../utils/workspace-status'

describe('isBusyStatus', () => {
  it('returns true for every status in BUSY_STATUSES', () => {
    for (const status of BUSY_STATUSES) {
      expect(isBusyStatus(status)).toBe(true)
    }
  })

  it('returns false for terminal / idle statuses', () => {
    for (const status of ['created', 'idle', 'completed', 'error', 'quota']) {
      expect(isBusyStatus(status)).toBe(false)
    }
  })

  it('returns false for null / undefined / empty string (defensive)', () => {
    expect(isBusyStatus(null)).toBe(false)
    expect(isBusyStatus(undefined)).toBe(false)
    expect(isBusyStatus('')).toBe(false)
  })

  it('exposes brainstorming and extracting as busy — guards the regression where the banner hid them', () => {
    expect(BUSY_STATUSES).toContain('brainstorming')
    expect(BUSY_STATUSES).toContain('extracting')
    expect(BUSY_STATUSES).toContain('executing')
  })
})

describe('isAgentStatusStale', () => {
  it('is stale when status claims busy but no controller is confirmed running', () => {
    expect(isAgentStatusStale('executing', false)).toBe(true)
  })

  it('is not stale when status claims busy and a controller is confirmed running', () => {
    expect(isAgentStatusStale('executing', true)).toBe(false)
  })

  it('is not stale for a non-busy status regardless of controller presence', () => {
    expect(isAgentStatusStale('idle', false)).toBe(false)
    expect(isAgentStatusStale('completed', false)).toBe(false)
  })
})

describe('shouldWarnAgentNotRunning', () => {
  it('does not warn for a busy status when liveness has not been loaded yet', () => {
    // This is the exact false-positive this helper exists to fix: a message
    // just flipped `status` to busy over WebSocket, and the liveness read
    // confirming it is still an HTTP round trip away.
    expect(shouldWarnAgentNotRunning('executing', false, false)).toBe(false)
  })

  it('warns for a busy status once liveness has loaded and confirms no controller', () => {
    expect(shouldWarnAgentNotRunning('executing', true, false)).toBe(true)
  })

  it('does not warn for a busy status when a controller is confirmed present', () => {
    expect(shouldWarnAgentNotRunning('executing', true, true)).toBe(false)
    // A controller entry is itself a positive confirmation, even if the
    // "loaded" marker somehow lagged behind it.
    expect(shouldWarnAgentNotRunning('executing', false, true)).toBe(false)
  })

  it('never warns for a terminal status regardless of whether liveness has loaded', () => {
    expect(shouldWarnAgentNotRunning('idle', false, false)).toBe(false)
    expect(shouldWarnAgentNotRunning('idle', true, false)).toBe(false)
    expect(shouldWarnAgentNotRunning('completed', true, false)).toBe(false)
  })
})
