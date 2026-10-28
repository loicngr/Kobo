import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedMessage } from '../../../shared/pinned-messages'
import { pinnedMessageTurns } from '../services/pinned-messages'
import { usePinnedMessagesStore } from '../stores/pinned-messages'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
function savedPin(overrides: Partial<PinnedMessage> = {}): PinnedMessage {
  return {
    id: 'p1',
    workspaceId: 'w1',
    workspaceName: 'Mission',
    sessionId: 's1',
    sessionName: 'Session',
    eventId: 'e1',
    itemKeys: ['text:m1'],
    speaker: 'agent',
    preview: 'Answer',
    messageCreatedAt: '2026-10-28T10:00:00Z',
    createdAt: '2026-10-28T11:00:00Z',
    archived: false,
    sourceAvailable: true,
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(apiFetch).mockReset().mockResolvedValue({ pins: [], hasMore: false })
})
describe('pinned message metadata', () => {
  it('preserves an unrelated workspace load while another workspace is mutated', async () => {
    const pending = deferred<unknown>()
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(savedPin())
    const store = usePinnedMessagesStore()
    const load = store.load('w2')
    await store.pin('w1', 's1', ['e1'])
    pending.resolve({ pins: [savedPin({ id: 'p2', workspaceId: 'w2' })], hasMore: false })
    await load
    expect(store.list('w2').loaded).toBe(true)
    expect(store.list('w2').pins[0]?.workspaceId).toBe('w2')
  })
  it('refreshes metadata after a failed mutation invalidates an ongoing load', async () => {
    const pending = deferred<unknown>()
    vi.mocked(apiFetch)
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ pins: [savedPin()], hasMore: false })
    const store = usePinnedMessagesStore()
    const load = store.load('w1')
    await expect(store.unpin(savedPin())).rejects.toThrow('offline')
    pending.resolve({ pins: [], hasMore: false })
    await load
    expect(store.list('w1').loaded).toBe(true)
    expect(store.list('w1').pins).toEqual([savedPin()])
  })
  it('loads all workspace pages and matches stable keys only within their session', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ pins: [savedPin()], hasMore: true })
      .mockResolvedValueOnce({ pins: [savedPin({ id: 'p2', sessionId: 's2', itemKeys: ['tool:t1'] })], hasMore: false })
    const store = usePinnedMessagesStore()
    await store.load('w1')
    expect(store.list('w1').pins).toHaveLength(2)
    expect(store.find('w1', 's1', ['text:older', 'text:m1'])?.id).toBe('p1')
    expect(store.find('w1', 's2', ['text:m1'])).toBeUndefined()
    expect(vi.mocked(apiFetch).mock.calls[1]?.[0]).toContain('offset=1')
  })
  it('keeps global pagination explicit and excludes snapshot bodies from state', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ pins: [savedPin({ archived: true })], hasMore: true })
    const store = usePinnedMessagesStore()
    await store.load()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(store.list().hasMore).toBe(true)
    vi.mocked(apiFetch).mockResolvedValueOnce({ pins: [savedPin({ id: 'p2' })], hasMore: false })
    await store.load(undefined, true)
    expect(store.list().pins).toHaveLength(2)
  })
  it('rejects older refreshes and preserves independent workspace lists', async () => {
    const old = deferred<unknown>()
    vi.mocked(apiFetch)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ pins: [savedPin()], hasMore: false })
    const store = usePinnedMessagesStore()
    const previous = store.load('w1')
    await store.load('w1')
    await store.load('w2')
    old.resolve({ pins: [], hasMore: false })
    await previous
    expect(store.list('w1').pins).toHaveLength(1)
    expect(store.list('w2').pins).toEqual([])
  })
  it('does not resurrect a deleted pin from a request started before the mutation', async () => {
    const old = deferred<unknown>()
    const after = deferred<unknown>()
    const store = usePinnedMessagesStore()
    store.list('w1').pins = [savedPin()]
    vi.mocked(apiFetch)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ok: true })
      .mockReturnValueOnce(after.promise)
    const previous = store.load('w1')
    await store.unpin(savedPin())
    old.resolve({ pins: [savedPin()], hasMore: false })
    await previous
    expect(store.list('w1').pins).toEqual([])
    after.resolve({ pins: [], hasMore: false })
  })
  it('does not erase a newly pinned card with a delayed empty response', async () => {
    const old = deferred<unknown>()
    const after = deferred<unknown>()
    const store = usePinnedMessagesStore()
    vi.mocked(apiFetch)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(savedPin())
      .mockReturnValueOnce(after.promise)
    const previous = store.load('w1')
    await store.pin('w1', 's1', ['e1', 'e2'])
    old.resolve({ pins: [], hasMore: false })
    await previous
    expect(store.list('w1').pins).toEqual([savedPin()])
    expect(apiFetch).toHaveBeenCalledWith('/api/pinned-messages', {
      method: 'POST',
      body: { workspaceId: 'w1', sessionId: 's1', eventIds: ['e1', 'e2'] },
    })
    after.resolve({ pins: [savedPin()], hasMore: false })
  })
  it('exposes load failures and clears them after retry', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'))
    const store = usePinnedMessagesStore()
    await store.load('w1')
    expect(store.list('w1').error).toBe('offline')
    expect(store.list('w1').loading).toBe(false)
    await store.load('w1')
    expect(store.list('w1').error).toBe('')
  })
})
it('reuses conversation folding for saved text, tools and user messages, preserving event IDs', () => {
  const base = { workspaceId: 'w1', sessionId: 's1', createdAt: '2026-10-28T10:00:00Z' }
  const turns = pinnedMessageTurns([
    { ...base, id: 'e1', type: 'user:message', payload: { content: 'Question', sender: 'user' } },
    {
      ...base,
      createdAt: '2026-10-28T10:01:00Z',
      id: 'e2',
      type: 'agent:event',
      payload: { kind: 'message:text', messageId: 'm1', text: 'Answer', streaming: false },
    },
    {
      ...base,
      createdAt: '2026-10-28T10:02:00Z',
      id: 'e3',
      type: 'agent:event',
      payload: { kind: 'tool:call', toolCallId: 't1', name: 'Read', input: { path: 'x' } },
    },
    {
      ...base,
      createdAt: '2026-10-28T10:03:00Z',
      id: 'e4',
      type: 'agent:event',
      payload: { kind: 'tool:result', toolCallId: 't1', output: 'result', isError: false },
    },
  ])
  expect(turns).toHaveLength(2)
  expect(turns[0]?.items[0]).toMatchObject({ type: 'user', content: 'Question', eventIds: ['e1'] })
  expect(turns[1]?.items[0]).toMatchObject({ type: 'text', text: 'Answer', streaming: false, eventIds: ['e2'] })
  expect(turns[1]?.items[1]).toMatchObject({ type: 'tool', result: { output: 'result' }, eventIds: ['e3', 'e4'] })
})
