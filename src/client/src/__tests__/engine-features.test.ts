import { describe, expect, it } from 'vitest'
import { supportsLiveSteering, supportsSubagentStop } from '../constants/engineFeatures'

describe('supportsLiveSteering', () => {
  it('allows forcing a queued message for both live engines', () => {
    expect(supportsLiveSteering('claude-code')).toBe(true)
    expect(supportsLiveSteering('codex')).toBe(true)
  })

  it('does not enable steering for an unknown engine', () => {
    expect(supportsLiveSteering('unknown-engine')).toBe(false)
  })
})

describe('supportsSubagentStop', () => {
  it('is only supported by Claude Code', () => {
    expect(supportsSubagentStop('claude-code')).toBe(true)
    expect(supportsSubagentStop('codex')).toBe(false)
  })

  it('is not offered for an unknown or missing engine', () => {
    expect(supportsSubagentStop('unknown-engine')).toBe(false)
    expect(supportsSubagentStop(undefined)).toBe(false)
  })
})

import * as features from '../constants/engineFeatures'

it('exposes only native execution capabilities for Mistral Vibe', () => {
  expect(features.supportsSubagents('mistral-vibe')).toBe(false)
  expect(features.supportsQuotaStatus('mistral-vibe')).toBe(false)
  expect(features.supportsLiveSteering('mistral-vibe')).toBe(false)
  expect(features.supportsSubagentStop('mistral-vibe')).toBe(false)
  expect(features.supportsReadOnly('mistral-vibe')).toBe(false)
  expect(features.supportsSkills('mistral-vibe')).toBe(false)
})
