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

describe('parseUnifiedDiff — deleted lines that look like a file header', () => {
  it('keeps a deleted SQL comment starting with two dashes', () => {
    const diff = [
      '--- a/schema.sql',
      '+++ b/schema.sql',
      '@@ -1,2 +1,1 @@',
      '--- drop the legacy index',
      ' CREATE TABLE t (id INT);',
    ].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual([
      { type: 'del', content: '-- drop the legacy index' },
      { type: 'context', content: 'CREATE TABLE t (id INT);' },
    ])
  })

  it('keeps an added YAML front-matter separator', () => {
    const diff = ['--- a/post.md', '+++ b/post.md', '@@ -0,0 +1,2 @@', '++++', '+title: hello'].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual([
      { type: 'add', content: '+++' },
      { type: 'add', content: 'title: hello' },
    ])
  })

  it('still drops the real file headers that precede the first hunk', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-const a = 1', '+const a = 2'].join('\n')

    expect(parseUnifiedDiff(diff)).toEqual([
      { type: 'del', content: 'const a = 1' },
      { type: 'add', content: 'const a = 2' },
    ])
  })
})

describe('computeInlineDiff() bounds', () => {
  it('exposes a line cap', async () => {
    const { INLINE_DIFF_MAX_LINES } = await import('../services/inline-diff')
    expect(INLINE_DIFF_MAX_LINES).toBe(800)
  })

  it('keeps the common prefix and suffix as context around a small edit', async () => {
    const { computeInlineDiff } = await import('../services/inline-diff')
    const before = ['a', 'b', 'OLD', 'c', 'd'].join('\n')
    const after = ['a', 'b', 'NEW', 'c', 'd'].join('\n')
    expect(computeInlineDiff(before, after)).toEqual([
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
      { type: 'del', content: 'OLD' },
      { type: 'add', content: 'NEW' },
      { type: 'context', content: 'c' },
      { type: 'context', content: 'd' },
    ])
  })

  it('degrades to a flat del/add block past the cap instead of allocating a huge table', async () => {
    const { INLINE_DIFF_MAX_LINES, computeInlineDiff } = await import('../services/inline-diff')
    const n = INLINE_DIFF_MAX_LINES + 10
    const before = ['header', ...Array.from({ length: n }, (_, i) => `old-${i}`), 'footer'].join('\n')
    const after = ['header', ...Array.from({ length: n }, (_, i) => `new-${i}`), 'footer'].join('\n')

    const lines = computeInlineDiff(before, after)

    // The trimmed prefix and suffix survive; the middle is not LCS-matched.
    expect(lines[0]).toEqual({ type: 'context', content: 'header' })
    expect(lines[lines.length - 1]).toEqual({ type: 'context', content: 'footer' })
    expect(lines.filter((l) => l.type === 'del')).toHaveLength(n)
    expect(lines.filter((l) => l.type === 'add')).toHaveLength(n)
    // Every deletion comes before every addition — no interleaving.
    const firstAdd = lines.findIndex((l) => l.type === 'add')
    const lastDel = lines.map((l) => l.type).lastIndexOf('del')
    expect(lastDel).toBeLessThan(firstAdd)
  })

  it('still uses the LCS walk when only the changed middle is small', async () => {
    const { INLINE_DIFF_MAX_LINES, computeInlineDiff } = await import('../services/inline-diff')
    // A two-thousand-line file with a one-line change: after trimming, the
    // middle is a single line, far under the cap.
    const shared = Array.from({ length: INLINE_DIFF_MAX_LINES * 2 }, (_, i) => `line-${i}`)
    const before = [...shared, 'OLD', ...shared].join('\n')
    const after = [...shared, 'NEW', ...shared].join('\n')

    const lines = computeInlineDiff(before, after)

    expect(lines.filter((l) => l.type === 'del')).toEqual([{ type: 'del', content: 'OLD' }])
    expect(lines.filter((l) => l.type === 'add')).toEqual([{ type: 'add', content: 'NEW' }])
  })

  it('handles a pure append and a pure truncation', async () => {
    const { computeInlineDiff } = await import('../services/inline-diff')
    expect(computeInlineDiff('a\nb', 'a\nb\nc')).toEqual([
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
      { type: 'add', content: 'c' },
    ])
    expect(computeInlineDiff('a\nb\nc', 'a\nb')).toEqual([
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
      { type: 'del', content: 'c' },
    ])
  })
})
