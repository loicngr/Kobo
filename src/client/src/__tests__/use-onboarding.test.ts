import { beforeEach, describe, expect, it } from 'vitest'
import { isOnboardingDone, markOnboardingDone, SETTINGS_SECTIONS } from '../composables/use-onboarding'

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

describe('onboarding tour sections', () => {
  it('walks every settings section the nav actually lists', () => {
    // La visite énumérait douze sections là où la navigation en compte
    // quatorze : `sentry` et `forge` étaient absents.
    expect(SETTINGS_SECTIONS).toContain('sentry')
    expect(SETTINGS_SECTIONS).toContain('forge')
    expect(SETTINGS_SECTIONS).toHaveLength(14)
  })
})
