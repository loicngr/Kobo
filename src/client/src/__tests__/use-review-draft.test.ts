import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReviewComment,
  formatSubmitMessage,
  type ReviewComment,
  useReviewDraft,
} from '../composables/use-review-draft'

describe('createReviewComment', () => {
  it('produces a ReviewComment with id, createdAt and the given fields', () => {
    const before = Date.now()
    const c = createReviewComment({ filePath: 'src/foo.ts', line: 42, content: 'fix' })
    const after = Date.now()
    expect(c.filePath).toBe('src/foo.ts')
    expect(c.line).toBe(42)
    expect(c.content).toBe('fix')
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(new Date(c.createdAt).getTime()).toBeGreaterThanOrEqual(before)
    expect(new Date(c.createdAt).getTime()).toBeLessThanOrEqual(after)
  })

  it('throws when filePath is empty or starts with /', () => {
    expect(() => createReviewComment({ filePath: '', line: 1, content: 'x' })).toThrow()
    expect(() => createReviewComment({ filePath: '/abs.ts', line: 1, content: 'x' })).toThrow()
  })
})

describe('useReviewDraft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns an empty draft when no localStorage entry exists', () => {
    const { draft } = useReviewDraft('ws-1', { sendChatMessage: vi.fn() })
    expect(draft.value.comments).toEqual([])
    expect(draft.value.globalMessage).toBe('')
  })

  it('reads the existing localStorage entry on mount', () => {
    localStorage.setItem(
      'kobo:review-draft:ws-1',
      JSON.stringify({
        comments: [{ id: 'a', filePath: 'foo.ts', line: 1, content: 'x', createdAt: '2026-01-01' }],
        globalMessage: 'hi',
      }),
    )
    const { draft } = useReviewDraft('ws-1', { sendChatMessage: vi.fn() })
    expect(draft.value.comments).toHaveLength(1)
    expect(draft.value.globalMessage).toBe('hi')
  })

  it('debounces writes by 300ms', () => {
    const { addComment } = useReviewDraft('ws-1', { sendChatMessage: vi.fn() })
    addComment({ filePath: 'a.ts', line: 1, content: 'one' })
    expect(localStorage.getItem('kobo:review-draft:ws-1')).toBeNull()
    addComment({ filePath: 'a.ts', line: 2, content: 'two' })
    vi.advanceTimersByTime(299)
    expect(localStorage.getItem('kobo:review-draft:ws-1')).toBeNull()
    vi.advanceTimersByTime(1)
    const stored = JSON.parse(localStorage.getItem('kobo:review-draft:ws-1') ?? '{}')
    expect(stored.comments).toHaveLength(2)
  })

  it('flush() writes synchronously, bypassing the debounce', () => {
    const { addComment, flush } = useReviewDraft('ws-1', { sendChatMessage: vi.fn() })
    addComment({ filePath: 'a.ts', line: 1, content: 'one' })
    flush()
    const stored = JSON.parse(localStorage.getItem('kobo:review-draft:ws-1') ?? '{}')
    expect(stored.comments).toHaveLength(1)
  })

  it('treats a corrupt localStorage entry as empty', () => {
    localStorage.setItem('kobo:review-draft:ws-1', '{not valid json')
    const { draft } = useReviewDraft('ws-1', { sendChatMessage: vi.fn() })
    expect(draft.value.comments).toEqual([])
    expect(draft.value.globalMessage).toBe('')
  })
})

describe('formatSubmitMessage', () => {
  const c = (filePath: string, line: number, content: string): ReviewComment => ({
    id: 'x',
    filePath,
    line,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  it('returns global-only message when there are no comments', () => {
    const out = formatSubmitMessage({ comments: [], globalMessage: 'overall vibe ok' })
    expect(out).toBe('## Code review\n\noverall vibe ok')
  })

  it('groups comments by file alphabetically and sorts by line ascending', () => {
    const out = formatSubmitMessage({
      comments: [c('z/last.ts', 5, 'z'), c('a/first.ts', 10, 'late'), c('a/first.ts', 2, 'early')],
      globalMessage: '',
    })
    const aBlockIdx = out.indexOf('### `a/first.ts`')
    const zBlockIdx = out.indexOf('### `z/last.ts`')
    expect(aBlockIdx).toBeGreaterThan(-1)
    expect(zBlockIdx).toBeGreaterThan(aBlockIdx)
    const earlyIdx = out.indexOf('**L2**')
    const lateIdx = out.indexOf('**L10**')
    expect(earlyIdx).toBeGreaterThan(-1)
    expect(lateIdx).toBeGreaterThan(earlyIdx)
  })

  it('includes the global message when both are present', () => {
    const out = formatSubmitMessage({
      comments: [c('a.ts', 1, 'fix')],
      globalMessage: 'context: …',
    })
    expect(out).toContain('## Code review — please address the following')
    expect(out).toContain('context: …')
    expect(out).toContain('### `a.ts`')
    expect(out).toContain('- **L1** : fix')
  })

  it('preserves Markdown metacharacters in comment content (no escaping)', () => {
    const out = formatSubmitMessage({
      comments: [c('a.ts', 1, '`backticks` and *stars* and **bold**')],
      globalMessage: '',
    })
    expect(out).toContain('- **L1** : `backticks` and *stars* and **bold**')
  })

  it('indents subsequent lines of multi-line comment content with 4 spaces', () => {
    const out = formatSubmitMessage({
      comments: [c('a.ts', 1, 'line one\nline two\nline three')],
      globalMessage: '',
    })
    expect(out).toContain('- **L1** : line one\n    line two\n    line three')
  })

  it('appends the footer with comment+file counts', () => {
    const out = formatSubmitMessage({
      comments: [c('a.ts', 1, 'x'), c('b.ts', 1, 'y'), c('a.ts', 2, 'z')],
      globalMessage: '',
    })
    expect(out).toContain('_3 comments across 2 files. Address them and ping me back when done._')
  })

  it('drops the footer when there are no comments', () => {
    const out = formatSubmitMessage({ comments: [], globalMessage: 'just a thought' })
    expect(out).not.toContain('Address them and ping me back')
  })
})

describe('useReviewDraft submit()', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('on success: calls sendChatMessage with the formatted payload, then clears the draft', async () => {
    const sendChatMessage = vi.fn().mockResolvedValue(undefined)
    const { addComment, submit, draft } = useReviewDraft('ws-1', { sendChatMessage })
    addComment({ filePath: 'a.ts', line: 1, content: 'fix' })

    const result = await submit('session-1')

    expect(result.ok).toBe(true)
    expect(sendChatMessage).toHaveBeenCalledTimes(1)
    expect(sendChatMessage).toHaveBeenCalledWith('ws-1', expect.stringContaining('- **L1** : fix'), 'session-1')
    expect(draft.value.comments).toEqual([])
    expect(localStorage.getItem('kobo:review-draft:ws-1')).toBeNull()
  })

  it('on failure: returns error, draft and localStorage stay intact', async () => {
    const err = new Error('ws disconnected')
    const sendChatMessage = vi.fn().mockRejectedValue(err)
    const { addComment, submit, draft, flush } = useReviewDraft('ws-1', { sendChatMessage })
    addComment({ filePath: 'a.ts', line: 1, content: 'fix' })
    flush()

    const result = await submit('session-1')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('ws disconnected')
    expect(draft.value.comments).toHaveLength(1)
    const stored = JSON.parse(localStorage.getItem('kobo:review-draft:ws-1') ?? '{}')
    expect(stored.comments).toHaveLength(1)
  })

  it('refuses to submit when draft is empty (0 comments and no global message)', async () => {
    const sendChatMessage = vi.fn()
    const { submit } = useReviewDraft('ws-1', { sendChatMessage })
    const result = await submit('session-1')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/empty/i)
    expect(sendChatMessage).not.toHaveBeenCalled()
  })
})
