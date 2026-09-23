import { describe, expect, it, vi } from 'vitest'

describe('countCommentsByPath', () => {
  it('counts comments per file', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const { byFile } = countCommentsByPath([
      { filePath: 'src/a.ts' },
      { filePath: 'src/a.ts' },
      { filePath: 'src/b.ts' },
    ])
    expect(byFile.get('src/a.ts')).toBe(2)
    expect(byFile.get('src/b.ts')).toBe(1)
  })

  it('counts comments on every ancestor folder', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const { byFolder } = countCommentsByPath([{ filePath: 'src/server/routes/git.ts' }])
    expect(byFolder.get('src')).toBe(1)
    expect(byFolder.get('src/server')).toBe(1)
    expect(byFolder.get('src/server/routes')).toBe(1)
    // The file itself is not a folder.
    expect(byFolder.get('src/server/routes/git.ts')).toBeUndefined()
  })

  it('adds up sibling files under a shared ancestor', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const { byFolder } = countCommentsByPath([
      { filePath: 'src/a/x.ts' },
      { filePath: 'src/b/y.ts' },
      { filePath: 'src/b/z.ts' },
    ])
    expect(byFolder.get('src')).toBe(3)
    expect(byFolder.get('src/a')).toBe(1)
    expect(byFolder.get('src/b')).toBe(2)
  })

  it('handles a root-level file with no folder at all', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const { byFile, byFolder } = countCommentsByPath([{ filePath: 'README.md' }])
    expect(byFile.get('README.md')).toBe(1)
    expect(byFolder.size).toBe(0)
  })

  it('walks each comment exactly once, whatever the tree depth', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const comments = Array.from({ length: 500 }, (_, i) => ({ filePath: `src/pkg/mod-${i}/file.ts` }))
    const spy = vi.spyOn(String.prototype, 'split')
    countCommentsByPath(comments)
    const calls = spy.mock.calls.length
    spy.mockRestore()
    // One split per comment. The old code re-scanned the entire comment list
    // once per folder node, twice per render.
    expect(calls).toBe(comments.length)
  })

  it('returns empty maps for an empty list', async () => {
    const { countCommentsByPath } = await import('../utils/review-comment-counts')
    const { byFile, byFolder } = countCommentsByPath([])
    expect(byFile.size).toBe(0)
    expect(byFolder.size).toBe(0)
  })
})
