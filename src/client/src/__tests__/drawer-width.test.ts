import { cappedDrawerWidth } from 'src/utils/drawer-width'
import { describe, expect, it } from 'vitest'

describe('cappedDrawerWidth', () => {
  it('returns the saved width unchanged on large screens', () => {
    expect(cappedDrawerWidth(300, 1440, false)).toBe(300)
    expect(cappedDrawerWidth(800, 1024, false)).toBe(800)
  })

  it('caps the width to (screenWidth - safe margin) on small screens', () => {
    // phone 390px wide, saved 300 → fits, unchanged
    expect(cappedDrawerWidth(300, 390, true)).toBe(300)
    // saved wider than the viewport minus margin → capped
    expect(cappedDrawerWidth(800, 390, true)).toBe(340) // 390 - 50
    expect(cappedDrawerWidth(500, 360, true)).toBe(310) // 360 - 50
  })

  it('honours a custom safe margin', () => {
    expect(cappedDrawerWidth(800, 400, true, 20)).toBe(380)
  })

  it('never returns a negative width on very small viewports', () => {
    expect(cappedDrawerWidth(300, 40, true)).toBe(0) // 40 - 50 clamped to 0
  })
})
