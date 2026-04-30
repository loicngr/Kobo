import { describe, expect, it } from 'vitest'
import {
  formatRateLimitBucketLabel,
  formatRateLimitLabel,
  formatRateLimitResetAt,
  usagePctColor,
} from '../utils/rate-limit-labels'

const fakeT = (key: string, params?: Record<string, unknown>): string => {
  const map: Record<string, string> = {
    'rateLimitType.fiveHour': '5h session',
    'rateLimitType.sevenDay': 'Weekly',
  }
  if (key === 'stats.usageBucket') return `Bucket ${String(params?.n ?? '?')}`
  if (key === 'stats.resetsAt') return `Reset ${String(params?.value ?? '')}`
  return map[key] ?? key
}

describe('formatRateLimitLabel', () => {
  it('maps five_hour to the localized label', () => {
    expect(formatRateLimitLabel('five_hour', fakeT)).toBe('5h session')
  })

  it('maps seven_day to the localized label', () => {
    expect(formatRateLimitLabel('seven_day', fakeT)).toBe('Weekly')
  })

  it('returns unknown labels unchanged (forward-compat)', () => {
    expect(formatRateLimitLabel('daily', fakeT)).toBe('daily')
    expect(formatRateLimitLabel('', fakeT)).toBe('')
  })

  it('formats reset timestamps as a 24h local time, not a raw ISO string', () => {
    const formatted = formatRateLimitResetAt('2026-04-24T06:00:00.000Z', { timeZone: 'Europe/Paris' })
    expect(formatted).toBe('08:00')
  })

  it('formats text-detected buckets with the reset time in the label', () => {
    const label = formatRateLimitBucketLabel(
      {
        id: 'text-detected',
        usedPct: 100,
        resetAt: '2026-04-23T06:00:00.000Z',
      },
      0,
      fakeT,
    )
    expect(label.startsWith('Reset ')).toBe(true)
  })
})

describe('usagePctColor', () => {
  it('returns positive for 0%', () => expect(usagePctColor(0)).toBe('positive'))
  it('returns positive for 49%', () => expect(usagePctColor(49)).toBe('positive'))
  it('returns warning for exactly 50%', () => expect(usagePctColor(50)).toBe('warning'))
  it('returns warning for 74%', () => expect(usagePctColor(74)).toBe('warning'))
  it('returns orange for exactly 75%', () => expect(usagePctColor(75)).toBe('orange'))
  it('returns orange for 89%', () => expect(usagePctColor(89)).toBe('orange'))
  it('returns negative for exactly 90%', () => expect(usagePctColor(90)).toBe('negative'))
  it('returns negative for 100%', () => expect(usagePctColor(100)).toBe('negative'))
  it('clamps below-range to positive', () => expect(usagePctColor(-5)).toBe('positive'))
  it('clamps above-range to negative', () => expect(usagePctColor(150)).toBe('negative'))
})
