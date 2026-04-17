import { describe, expect, it } from 'vitest'
import { formatRateLimitLabel } from '../utils/rate-limit-labels'

const fakeT = (key: string): string => {
  const map: Record<string, string> = {
    'rateLimitType.fiveHour': '5h session',
    'rateLimitType.sevenDay': 'Weekly',
  }
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
})
