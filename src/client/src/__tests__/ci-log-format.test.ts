import { describe, expect, it } from 'vitest'
import { ciLogSpans, ciStepAppearance } from '../utils/ci-log-format'

describe('CI log formatting', () => {
  it('preserves plain text and never produces HTML', () => {
    expect(ciLogSpans('<script>alert(1)</script>')).toEqual([{ text: '<script>alert(1)</script>', style: {} }])
  })
  it('supports colors, bold and resets across lines', () => {
    const spans = ciLogSpans('plain\u001b[1;31mred\nred\u001b[22;39mplain')
    expect(spans.map((s) => s.text).join('')).toBe('plainred\nredplain')
    expect(spans[1]?.style).toEqual({ color: '#ff7b72', fontWeight: 'bold' })
    expect(spans[2]?.style).toEqual({})
  })
  it('supports indexed, RGB and background colors', () => {
    const spans = ciLogSpans('\u001b[38;5;196mred\u001b[48;2;10;20;30mbackground\u001b[0mreset')
    expect(spans[0]?.style.color).toBe('rgb(255, 0, 0)')
    expect(spans[1]?.style.backgroundColor).toBe('rgb(10, 20, 30)')
    expect(spans[2]?.style).toEqual({})
  })
  it('ignores malformed color parameters', () => {
    expect(ciLogSpans('\u001b[38;2;999;2;3mtest')[0]?.style).toEqual({})
  })
  it.each([
    ['completed', 'success', 'positive', 'check_circle'],
    ['completed', 'failure', 'negative', 'cancel'],
    ['completed', 'timed_out', 'negative', 'cancel'],
    ['completed', 'skipped', 'grey-6', 'remove_circle_outline'],
    ['completed', 'cancelled', 'grey-6', 'remove_circle_outline'],
    ['in_progress', null, 'warning', 'hourglass_top'],
  ])('formats %s/%s', (status, conclusion, color, icon) => {
    expect(ciStepAppearance(status!, conclusion)).toEqual({ color, icon })
  })
})
