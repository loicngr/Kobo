// src/__tests__/forge/registry.test.ts
import { describe, expect, it } from 'vitest'
import { getForgeProvider, listForges } from '../../server/services/forge/registry.js'

describe('forge registry', () => {
  it('resolves each known forge id to a provider with the matching id', () => {
    expect(getForgeProvider('github').id).toBe('github')
    expect(getForgeProvider('gitlab').id).toBe('gitlab')
    expect(getForgeProvider('none').id).toBe('none')
  })

  it('falls back to the none provider for an unknown id', () => {
    expect(getForgeProvider('bitbucket' as never).id).toBe('none')
  })

  it('listForges returns the selectable forge ids', () => {
    expect(listForges()).toEqual(['github', 'gitlab', 'none'])
  })
})
