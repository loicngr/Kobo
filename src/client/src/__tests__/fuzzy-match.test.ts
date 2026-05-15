import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyRank } from '../utils/fuzzy-match'

describe('fuzzyMatch', () => {
  it('returns 0 for an empty query (matches everything)', () => {
    expect(fuzzyMatch('', 'anything')).toBe(0)
  })

  it('matches a contiguous substring', () => {
    expect(fuzzyMatch('file', 'file.txt')).not.toBeNull()
  })

  it('matches a non-contiguous subsequence (fzf-style)', () => {
    // f…b…t — characters in order, not adjacent
    expect(fuzzyMatch('fbt', 'file-by-tag.ts')).not.toBeNull()
  })

  it('returns null when a character is missing', () => {
    expect(fuzzyMatch('xyz', 'file.txt')).toBeNull()
  })

  it('returns null when characters appear out of order', () => {
    // 'file.txt' has no 'f' after the last 't', so 'tf' cannot match in order
    expect(fuzzyMatch('tf', 'file.txt')).toBeNull()
  })

  it('scores a contiguous match higher than a scattered one', () => {
    const contiguous = fuzzyMatch('comp', 'components.ts') as number
    const scattered = fuzzyMatch('comp', 'c-o-m-p-x.ts') as number
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('FILE', 'file.txt')).not.toBeNull()
  })
})

describe('fuzzyRank', () => {
  it('filters out non-matches and ranks the rest best-first', () => {
    const ranked = fuzzyRank('idx', ['src/index.ts', 'README.md', 'src/utils/index.ts'])
    expect(ranked).not.toContain('README.md')
    expect(ranked).toContain('src/index.ts')
    // The shorter, tighter path should rank ahead.
    expect(ranked[0]).toBe('src/index.ts')
  })

  it('returns every item for an empty query', () => {
    const items = ['a.ts', 'b.ts']
    expect(fuzzyRank('', items)).toHaveLength(2)
  })
})
