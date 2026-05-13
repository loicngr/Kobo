import { describe, expect, it } from 'vitest'
import { pickReadableForeground } from '../utils/color'

describe('pickReadableForeground', () => {
  it('returns light text on a dark background', () => {
    expect(pickReadableForeground('1e3a8a')).toBe('#ffffff')
    expect(pickReadableForeground('000000')).toBe('#ffffff')
  })
  it('returns dark text on a light background', () => {
    expect(pickReadableForeground('ffeb3b')).toBe('#1a1a1a')
    expect(pickReadableForeground('ffffff')).toBe('#1a1a1a')
  })
  it('tolerates a leading hash and uppercase', () => {
    expect(pickReadableForeground('#D73A4A')).toBe('#ffffff')
  })
  it('falls back to light text on a malformed input', () => {
    expect(pickReadableForeground('zzz')).toBe('#ffffff')
  })
})
