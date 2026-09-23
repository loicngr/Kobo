// src/__tests__/forge/none.test.ts
import { describe, expect, it } from 'vitest'
import { noneProvider } from '../../server/services/forge/none.js'
import { ForgeUnavailableError } from '../../server/services/forge/types.js'

describe('none forge provider', () => {
  it('reports itself unavailable', async () => {
    expect(await noneProvider.isAvailable('/tmp')).toEqual({ available: false })
  })

  it('returns null for getPrStatus', async () => {
    expect(await noneProvider.getPrStatus('/tmp', 'b')).toBeNull()
  })

  it('throws ForgeUnavailableError for createPr', async () => {
    await expect(
      noneProvider.createPr('/tmp', { base: 'main', head: 'b', title: 't', body: '' }),
    ).rejects.toBeInstanceOf(ForgeUnavailableError)
  })

  it('throws ForgeUnavailableError for changePrBase', async () => {
    await expect(noneProvider.changePrBase('/tmp', 'main')).rejects.toBeInstanceOf(ForgeUnavailableError)
  })

  it('declares no capabilities', () => {
    expect(noneProvider.capabilities.canCreatePr).toBe(false)
    expect(noneProvider.capabilities.canChangePrBase).toBe(false)
  })
})
