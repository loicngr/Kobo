import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

// Mutable reactive stand-in for $q.screen; each test controls lt.sm and lt.md.
const screen = reactive({ lt: { sm: false, md: false } })
vi.mock('quasar', () => ({ useQuasar: () => ({ screen }) }))

import { useIsMobile } from '../composables/use-is-mobile'

describe('useIsMobile', () => {
  it('is false when screen.lt.sm is false', () => {
    screen.lt.sm = false
    const { isMobile } = useIsMobile()
    expect(isMobile.value).toBe(false)
  })

  it('is true when screen.lt.sm is true', () => {
    screen.lt.sm = true
    const { isMobile } = useIsMobile()
    expect(isMobile.value).toBe(true)
  })

  it('tracks screen.lt.sm reactively', () => {
    screen.lt.sm = false
    const { isMobile } = useIsMobile()
    expect(isMobile.value).toBe(false)
    screen.lt.sm = true
    expect(isMobile.value).toBe(true)
  })
})

describe('useIsMobile - isDrawerCollapsed', () => {
  it('is false when screen.lt.md is false', () => {
    screen.lt.md = false
    const { isDrawerCollapsed } = useIsMobile()
    expect(isDrawerCollapsed.value).toBe(false)
  })

  it('is true when screen.lt.md is true', () => {
    screen.lt.md = true
    const { isDrawerCollapsed } = useIsMobile()
    expect(isDrawerCollapsed.value).toBe(true)
  })

  it('tracks screen.lt.md reactively', () => {
    screen.lt.md = false
    const { isDrawerCollapsed } = useIsMobile()
    expect(isDrawerCollapsed.value).toBe(false)
    screen.lt.md = true
    expect(isDrawerCollapsed.value).toBe(true)
  })
})
