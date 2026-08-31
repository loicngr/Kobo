import { describe, expect, it, vi } from 'vitest'
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

describe('fuzzyRankTop', () => {
  const corpus = [
    'src/server/routes/git.ts',
    'src/client/src/utils/fuzzy-match.ts',
    'src/client/src/components/GitPanel.vue',
    'docs/git.md',
    'README.md',
    'src/__tests__/routes-git.test.ts',
  ]

  it('returns exactly what fuzzyRank would return, truncated', async () => {
    const { fuzzyRank, fuzzyRankTop } = await import('../utils/fuzzy-match')
    for (const query of ['git', 'gt', 'srcgit', 'md', '']) {
      expect(fuzzyRankTop(query, corpus, 3)).toEqual(fuzzyRank(query, corpus).slice(0, 3))
    }
  })

  it('keeps the earlier item on a score tie, like the stable sort did', async () => {
    const { fuzzyRank, fuzzyRankTop } = await import('../utils/fuzzy-match')
    const ties = ['aa/x.ts', 'bb/x.ts', 'cc/x.ts']
    expect(fuzzyRankTop('x', ties, 2)).toEqual(fuzzyRank('x', ties).slice(0, 2))
  })

  it('scores every item exactly once — a single pass, no sort', async () => {
    const { fuzzyMatch, fuzzyRankTop } = await import('../utils/fuzzy-match')
    const items = Array.from({ length: 5000 }, (_, i) => `src/pkg/module-${i}/index.ts`)
    const score = vi.fn(fuzzyMatch)

    fuzzyRankTop('index', items, 50, score)

    // The old path scored every item, wrapped each one in an object, then
    // sorted the whole list before slicing fifty. One call per item and no
    // second traversal is the whole point.
    expect(score).toHaveBeenCalledTimes(items.length)
  })

  it('never returns more than the limit', async () => {
    const { fuzzyRankTop } = await import('../utils/fuzzy-match')
    const items = Array.from({ length: 200 }, (_, i) => `file-${i}.ts`)
    expect(fuzzyRankTop('file', items, 50)).toHaveLength(50)
  })

  it('returns an empty list for a non-zero corpus and a zero limit', async () => {
    const { fuzzyRankTop } = await import('../utils/fuzzy-match')
    expect(fuzzyRankTop('a', ['abc'], 0)).toEqual([])
  })

  it('drops non-matching items', async () => {
    const { fuzzyRankTop } = await import('../utils/fuzzy-match')
    expect(fuzzyRankTop('zzz', corpus, 10)).toEqual([])
  })
})
