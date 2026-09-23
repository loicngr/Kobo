import { describe, expect, it } from 'vitest'
import { prefillFromPr } from '../utils/pr-prefill'

const pr = { number: 42, title: 'Add dark mode', url: 'https://github.com/o/r/pull/42' }

// Echoes the key and its params so the test can assert on what was requested
// without depending on a locale file.
const t = (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`

const intro = `createPage.prResumeIntro:${JSON.stringify({ number: 42, title: 'Add dark mode', url: pr.url })}`

describe('prefillFromPr', () => {
  it('uses the PR title as name when the current name is empty', () => {
    const result = prefillFromPr(pr, { name: '', description: '' }, t)
    expect(result.name).toBe('Add dark mode')
  })

  it('truncates a long PR title to 200 characters with an ellipsis', () => {
    const longTitle = 'x'.repeat(250)
    const result = prefillFromPr({ ...pr, title: longTitle }, { name: '', description: '' }, t)
    expect(result.name).toHaveLength(200)
    expect(result.name).toBe(`${'x'.repeat(199)}…`)
  })

  it('never splits a surrogate pair when truncating an emoji title', () => {
    const emojiTitle = '🎉'.repeat(150)
    const result = prefillFromPr({ ...pr, title: emojiTitle }, { name: '', description: '' }, t)
    expect(result.name.length).toBeLessThanOrEqual(200)
    expect(result.name.endsWith('…')).toBe(true)
    // Every code point before the ellipsis is a whole emoji, none a lone half.
    expect(Array.from(result.name.slice(0, -1)).every((c) => c === '🎉')).toBe(true)
  })

  it('keeps an existing name untouched', () => {
    const result = prefillFromPr(pr, { name: 'My name', description: '' }, t)
    expect(result.name).toBe('My name')
  })

  it('builds the description intro alone when the PR has no body', () => {
    expect(prefillFromPr(pr, { name: '', description: '' }, t).description).toBe(intro)
    expect(prefillFromPr({ ...pr, body: '' }, { name: '', description: '' }, t).description).toBe(intro)
  })

  it('appends the PR body after a blank line when present', () => {
    const result = prefillFromPr({ ...pr, body: 'Line 1\nLine 2' }, { name: '', description: '' }, t)
    expect(result.description).toBe(`${intro}\n\nLine 1\nLine 2`)
  })

  it('keeps an existing description untouched', () => {
    const result = prefillFromPr({ ...pr, body: 'Body' }, { name: '', description: 'Mine' }, t)
    expect(result.description).toBe('Mine')
  })

  describe('re-import after a previous prefill', () => {
    const previous = { name: 'Old PR title', description: 'old intro' }

    it('replaces a name still equal to the previous prefill', () => {
      const result = prefillFromPr(pr, { name: 'Old PR title', description: '' }, t, previous)
      expect(result.name).toBe('Add dark mode')
    })

    it('replaces a description still equal to the previous prefill', () => {
      const result = prefillFromPr(pr, { name: '', description: 'old intro' }, t, previous)
      expect(result.description).toBe(intro)
    })

    it('keeps a name and description the user edited since', () => {
      const result = prefillFromPr(pr, { name: 'Old PR title (edited)', description: 'old intro, edited' }, t, previous)
      expect(result).toEqual({ name: 'Old PR title (edited)', description: 'old intro, edited' })
    })
  })
})
