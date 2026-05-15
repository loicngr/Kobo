import { beforeEach, describe, expect, it } from 'vitest'
import { isOnboardingDone, markOnboardingDone } from '../composables/use-onboarding'

describe('onboarding flag', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reports not-done on a fresh install', () => {
    expect(isOnboardingDone()).toBe(false)
  })

  it('reports done after markOnboardingDone()', () => {
    markOnboardingDone()
    expect(isOnboardingDone()).toBe(true)
  })

  it('persists the flag under a stable localStorage key', () => {
    markOnboardingDone()
    expect(localStorage.getItem('kobo:onboarding-done')).toBe('1')
  })
})
