import { describe, expect, it } from 'vitest'
import { collectTags, matchesTags, parseTagFilter } from '../utils/workspace-tag-filter'

describe('collectTags', () => {
  it('lists distinct tags alphabetically, counted once per workspace', () => {
    expect(
      collectTags([{ tags: ['docs', 'back'] }, { tags: ['docs', 'docs'] }, { tags: [] }, { tags: ['Api'] }]),
    ).toEqual([
      { tag: 'Api', count: 1 },
      { tag: 'back', count: 1 },
      { tag: 'docs', count: 2 },
    ])
  })
})

describe('matchesTags', () => {
  it('keeps everything when nothing is selected', () => {
    expect(matchesTags({ tags: [] }, [])).toBe(true)
  })
  it('matches a workspace carrying at least one selected tag (OR)', () => {
    expect(matchesTags({ tags: ['back'] }, ['docs', 'back'])).toBe(true)
    expect(matchesTags({ tags: ['front'] }, ['docs', 'back'])).toBe(false)
    expect(matchesTags({ tags: [] }, ['docs'])).toBe(false)
  })
})

describe('parseTagFilter', () => {
  it('reads a stored JSON string array', () => {
    expect(parseTagFilter('["docs","back"]')).toEqual(['docs', 'back'])
  })
  it.each([null, '', 'not json', '{"a":1}', '[1,"docs"]'])('falls back safely for %j', (raw) => {
    expect(parseTagFilter(raw)).toEqual(raw === '[1,"docs"]' ? ['docs'] : [])
  })
})
