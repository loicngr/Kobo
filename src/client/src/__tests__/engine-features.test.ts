import { describe, expect, it } from 'vitest'
import { supportsLiveSteering } from '../constants/engineFeatures'

describe('supportsLiveSteering', () => {
  it('allows forcing a queued message for both live engines', () => {
    expect(supportsLiveSteering('claude-code')).toBe(true)
    expect(supportsLiveSteering('codex')).toBe(true)
  })

  it('does not enable steering for an unknown engine', () => {
    expect(supportsLiveSteering('unknown-engine')).toBe(false)
  })
})
