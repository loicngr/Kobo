import { describe, expect, it } from 'vitest'
import { cronExpressionFromPicker } from '../utils/cron-expression'

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
