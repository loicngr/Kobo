import { describe, expect, it } from 'vitest'
import { compareVersions } from '../utils/compare-versions'

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.7.14', '1.7.14')).toBe(0)
  })

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.8.0', '1.7.99')).toBeGreaterThan(0)
    expect(compareVersions('1.7.15', '1.7.14')).toBeGreaterThan(0)
    expect(compareVersions('1.7.13', '1.7.14')).toBeLessThan(0)
  })

  it('treats missing segments as 0', () => {
    expect(compareVersions('1.7', '1.7.0')).toBe(0)
    expect(compareVersions('1.7.1', '1.7')).toBeGreaterThan(0)
  })

  it('reduces non-numeric suffixes to their leading integer', () => {
    expect(compareVersions('1.7.14-beta', '1.7.14')).toBe(0)
    expect(compareVersions('1.7.15-rc1', '1.7.14')).toBeGreaterThan(0)
  })
})
