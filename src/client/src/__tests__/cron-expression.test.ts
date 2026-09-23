import { describe, expect, it } from 'vitest'
import { cronDaysHasMonthBoundaryDrift, cronExpressionFromPicker } from '../utils/cron-expression'

describe('cronExpressionFromPicker', () => {
  it('builds an every-N-minutes expression', () => {
    expect(cronExpressionFromPicker('minutes', 15)).toBe('*/15 * * * *')
  })

  it('builds an every-N-hours expression', () => {
    expect(cronExpressionFromPicker('hours', 2)).toBe('0 */2 * * *')
  })

  it('builds an every-N-days expression', () => {
    expect(cronExpressionFromPicker('days', 1)).toBe('0 0 */1 * *')
  })

  it('clamps N to a minimum of 1 and floors fractions', () => {
    expect(cronExpressionFromPicker('minutes', 0)).toBe('*/1 * * * *')
    expect(cronExpressionFromPicker('minutes', 2.9)).toBe('*/2 * * * *')
  })
})

describe('cronDaysHasMonthBoundaryDrift', () => {
  it('is false for an exact daily interval', () => {
    expect(cronDaysHasMonthBoundaryDrift(1)).toBe(false)
  })

  it('is true for any interval greater than 1, since day-of-month resets every month', () => {
    expect(cronDaysHasMonthBoundaryDrift(2)).toBe(true)
    expect(cronDaysHasMonthBoundaryDrift(3)).toBe(true)
    expect(cronDaysHasMonthBoundaryDrift(7)).toBe(true)
  })
})
