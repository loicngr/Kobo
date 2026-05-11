import { describe, expect, it } from 'vitest'
import { computeInlineDiff, getFileChangeInfo, parseUnifiedDiff } from '../services/inline-diff'

describe('parseUnifiedDiff()', () => {
  it('returns an empty list for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('skips @@ hunk headers', () => {
    const out = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n b')
    expect(out).toEqual([
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
    ])
  })

  it('skips +++ / --- file headers', () => {
    const out = parseUnifiedDiff('--- a.ts\n+++ b.ts\n+added')
    expect(out).toEqual([{ type: 'add', content: 'added' }])
  })

  it('classifies + as add, - as del, space as context', () => {
    const diff = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d'
    expect(parseUnifiedDiff(diff)).toEqual([
      { type: 'context', content: 'a' },
      { type: 'del', content: 'b' },
      { type: 'add', content: 'c' },
      { type: 'context', content: 'd' },
    ])
  })

  it('treats untagged non-empty lines as context (lenient parsing)', () => {
    const out = parseUnifiedDiff('first untagged\n+added')
    expect(out).toEqual([
      { type: 'context', content: 'first untagged' },
      { type: 'add', content: 'added' },
    ])
  })

  it('preserves leading whitespace on added/removed lines', () => {
    const out = parseUnifiedDiff('+  indented add\n-  indented del')
    expect(out).toEqual([
      { type: 'add', content: '  indented add' },
      { type: 'del', content: '  indented del' },
    ])
  })
})

describe('getFileChangeInfo() — Codex unified-diff shape', () => {
  it('parses { file_path, diff } into diffLines + add/del stats', () => {
    const input = {
      file_path: '/repo/x.ts',
      diff: '@@ -1,3 +1,3 @@\n unchanged\n-old\n+new\n+another\n',
    }
    const fc = getFileChangeInfo('Edit', input)
    expect(fc).not.toBeNull()
    expect(fc!.toolName).toBe('Edit')
    expect(fc!.filePath).toBe('/repo/x.ts')
    expect(fc!.additions).toBe(2)
    expect(fc!.deletions).toBe(1)
    expect(fc!.diffLines).toHaveLength(4)
  })

  it('keeps Claude shape (old_string / new_string) when both are present', () => {
    const input = { file_path: '/repo/x.ts', old_string: 'foo\nbar', new_string: 'foo\nbaz' }
    const fc = getFileChangeInfo('Edit', input)
    expect(fc!.oldString).toBe('foo\nbar')
    expect(fc!.newString).toBe('foo\nbaz')
    expect(fc!.diffLines).toBeUndefined()
  })

  it('returns null when neither file_path nor a diff is present', () => {
    expect(getFileChangeInfo('Edit', { changes: [] })).toBeNull()
  })
})

describe('computeInlineDiff() (regression coverage)', () => {
  it('emits a single context block when both sides are identical', () => {
    const out = computeInlineDiff('same', 'same')
    expect(out).toEqual([{ type: 'context', content: 'same' }])
  })

  it('reports an add when the new side has extra trailing lines', () => {
    const out = computeInlineDiff('a', 'a\nb')
    expect(out).toEqual([
      { type: 'context', content: 'a' },
      { type: 'add', content: 'b' },
    ])
  })
})
