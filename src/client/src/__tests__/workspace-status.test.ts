import { describe, expect, it } from 'vitest'
import { BUSY_STATUSES, isBusyStatus } from '../utils/workspace-status'

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
