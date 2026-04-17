import { describe, expect, it } from 'vitest'
import { normalizeRateLimitUsage } from '../utils/rate-limit-normalizer'

const TIMESTAMP = '2026-04-17T12:00:00Z'
const NOW_MS = new Date(TIMESTAMP).getTime()

describe('normalizeRateLimitUsage', () => {
  describe('Claude rate_limit_info format', () => {
    it('extracts usedPct from utilization on a warning event', () => {
      const snap = normalizeRateLimitUsage(
        {
          status: 'allowed_warning',
          resetsAt: 1776434400,
          rateLimitType: 'seven_day',
          utilization: 0.93,
          isUsingOverage: false,
          surpassedThreshold: 0.75,
        },
        TIMESTAMP,
      )
      expect(snap).not.toBeNull()
      expect(snap?.buckets).toHaveLength(1)
      expect(snap?.buckets[0].id).toBe('seven_day')
      expect(snap?.buckets[0].usedPct).toBe(93)
    })

    it('produces a 0% bucket when status is allowed and utilization is absent', () => {
      const snap = normalizeRateLimitUsage(
        {
          status: 'allowed',
          resetsAt: 1776441600,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          isUsingOverage: false,
        },
        TIMESTAMP,
      )
      expect(snap).not.toBeNull()
      expect(snap?.buckets).toHaveLength(1)
      expect(snap?.buckets[0].id).toBe('five_hour')
      expect(snap?.buckets[0].usedPct).toBe(0)
    })

    it('parses resetsAt as unix timestamp (number in seconds)', () => {
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
      )
      // 1776441600 * 1000 = 2026-04-17T16:00:00.000Z UTC
      expect(snap?.buckets[0].resetAt).toBe('2026-04-17T16:00:00.000Z')
    })

    it('accepts resetsAt as ISO string (backward compat)', () => {
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: '2026-04-17T16:00:00.000Z', rateLimitType: 'five_hour' },
        TIMESTAMP,
      )
      expect(snap?.buckets[0].resetAt).toBe('2026-04-17T16:00:00.000Z')
    })

    it('always refreshes updatedAt to the event timestamp', () => {
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
      )
      expect(snap?.updatedAt).toBe(TIMESTAMP)
    })

    it('uses rateLimitType as the bucket label when no explicit label is provided', () => {
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
      )
      expect(snap?.buckets[0].label).toBe('five_hour')
    })

    it('prefers an explicit label over rateLimitType', () => {
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour', label: 'Custom' },
        TIMESTAMP,
      )
      expect(snap?.buckets[0].label).toBe('Custom')
    })
  })

  describe('merging with existing snapshot', () => {
    it('replaces the bucket of the same rateLimitType', () => {
      const existing = {
        updatedAt: '2026-04-17T11:00:00Z',
        buckets: [{ id: 'five_hour', usedPct: 20, resetAt: '2026-04-17T18:00:00.000Z' }],
      }
      const snap = normalizeRateLimitUsage(
        { status: 'allowed_warning', resetsAt: 1776441600, rateLimitType: 'five_hour', utilization: 0.9 },
        TIMESTAMP,
        existing,
        NOW_MS,
      )
      expect(snap?.buckets).toHaveLength(1)
      expect(snap?.buckets[0].usedPct).toBe(90)
    })

    it('preserves buckets of other rateLimitTypes', () => {
      const existing = {
        updatedAt: '2026-04-17T11:00:00Z',
        buckets: [{ id: 'seven_day', usedPct: 93, resetAt: '2026-04-17T20:00:00.000Z' }],
      }
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
        existing,
        NOW_MS,
      )
      const ids = snap?.buckets.map((b) => b.id).sort()
      expect(ids).toEqual(['five_hour', 'seven_day'])
    })

    it('drops buckets whose resetAt has passed', () => {
      const existing = {
        updatedAt: '2026-04-16T11:00:00Z',
        buckets: [{ id: 'seven_day', usedPct: 93, resetAt: '2026-04-17T10:00:00.000Z' }], // expired (before NOW_MS=12:00)
      }
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
        existing,
        NOW_MS,
      )
      const ids = snap?.buckets.map((b) => b.id)
      expect(ids).toEqual(['five_hour'])
    })

    it('keeps buckets whose resetAt is in the future', () => {
      const existing = {
        updatedAt: '2026-04-17T11:00:00Z',
        buckets: [{ id: 'seven_day', usedPct: 93, resetAt: '2026-04-18T20:00:00.000Z' }], // future
      }
      const snap = normalizeRateLimitUsage(
        { status: 'allowed', resetsAt: 1776441600, rateLimitType: 'five_hour' },
        TIMESTAMP,
        existing,
        NOW_MS,
      )
      expect(snap?.buckets.some((b) => b.id === 'seven_day' && b.usedPct === 93)).toBe(true)
    })
  })

  describe('fallback shapes (robustness across payload shapes)', () => {
    it('still extracts from legacy info.buckets array with used_percent', () => {
      const snap = normalizeRateLimitUsage(
        {
          buckets: [{ id: 'legacy-1', label: 'Daily', used_percent: 42, reset_at: '2026-04-18T00:00:00.000Z' }],
        },
        TIMESTAMP,
      )
      expect(snap?.buckets).toHaveLength(1)
      expect(snap?.buckets[0].usedPct).toBe(42)
      expect(snap?.buckets[0].label).toBe('Daily')
    })

    it('returns null when info carries no rateLimitType and no derivable usage', () => {
      const snap = normalizeRateLimitUsage({ unknown: 'payload' }, TIMESTAMP)
      expect(snap).toBeNull()
    })
  })
})
