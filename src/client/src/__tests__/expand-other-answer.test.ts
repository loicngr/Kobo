import { describe, expect, it } from 'vitest'
import { expandOtherAnswer, OTHER_INSTRUCTION, OTHER_OPTION_VALUE } from '../utils/expand-other-answer'

describe('expandOtherAnswer()', () => {
  it('returns the literal label for a normal single-select value', () => {
    expect(expandOtherAnswer('OptionA', false)).toBe('OptionA')
  })

  it('returns the full instruction when single-select equals the sentinel', () => {
    expect(expandOtherAnswer(OTHER_OPTION_VALUE, false)).toBe(OTHER_INSTRUCTION)
  })

  it('joins normal multi-select labels with ", "', () => {
    expect(expandOtherAnswer(['OptionA', 'OptionB'], true)).toBe('OptionA, OptionB')
  })

  it('returns the full instruction when multi-select contains only the sentinel', () => {
    expect(expandOtherAnswer([OTHER_OPTION_VALUE], true)).toBe(OTHER_INSTRUCTION)
  })

  it('replaces the sentinel inline among other multi-select labels', () => {
    expect(expandOtherAnswer(['OptionA', OTHER_OPTION_VALUE, 'OptionB'], true)).toBe(
      `OptionA, ${OTHER_INSTRUCTION}, OptionB`,
    )
  })

  it('returns "" for an empty multi-select array', () => {
    expect(expandOtherAnswer([], true)).toBe('')
  })

  it('returns "" for an empty single-select string', () => {
    expect(expandOtherAnswer('', false)).toBe('')
  })

  it('defensively unwraps a single-element array passed to single-select', () => {
    expect(expandOtherAnswer(['OptionA'], false)).toBe('OptionA')
  })

  it('exports the expected sentinel value (regression guard)', () => {
    expect(OTHER_OPTION_VALUE).toBe('__KOBO_OTHER__')
  })
})
