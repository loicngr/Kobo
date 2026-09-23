import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useActivityStore } from '../stores/activity'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const api = vi.mocked(apiFetch)
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.resetAllMocks()
})
describe('absence digest', () => {
  it('establishes the first visit without presenting historical activity', async () => {
    api.mockResolvedValue({ cursor: 42 })
    const store = useActivityStore()
    await store.returnToApp()
    expect(store.items).toEqual([])
    expect(store.cursor).toBe(42)
  })
  it('keeps unread events across reload and acknowledges only the loaded page', async () => {
    localStorage.setItem('kobo:activityVisit', JSON.stringify({ cursor: 4, seenAt: '2026-09-09T10:00:00Z' }))
    api.mockResolvedValue({
      items: [{ id: 5, workspaceId: 'w', kind: 'question' }],
      nextCursor: 5,
      cursor: 9,
      hasMore: true,
    })
    const store = useActivityStore()
    await store.returnToApp()
    expect(store.items).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('kobo:activityVisit')!).cursor).toBe(4)
    store.markRead()
    expect(store.cursor).toBe(5)
    expect(JSON.parse(localStorage.getItem('kobo:activityVisit')!).cursor).toBe(5)
  })
  it('does not mark away-time events read when a heartbeat returns late', async () => {
    api.mockResolvedValueOnce({ cursor: 4 })
    const store = useActivityStore()
    await store.returnToApp()
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const pending = store.heartbeat()
    store.leaveApp()
    resolve({ cursor: 9 })
    await pending
    expect(store.cursor).toBe(4)
  })
  it('preserves checkpoint after network failure and can retry', async () => {
    localStorage.setItem('kobo:activityVisit', JSON.stringify({ cursor: 4, seenAt: '' }))
    api.mockRejectedValueOnce(new Error('offline'))
    const store = useActivityStore()
    await store.returnToApp()
    expect(store.error).toBe(true)
    expect(store.cursor).toBe(4)
    api.mockResolvedValueOnce({ items: [], nextCursor: 4, cursor: 4, hasMore: false })
    await store.returnToApp()
    expect(store.error).toBe(false)
  })
})

describe('activity recovery', () => {
  async function presentStore(cursor = 4) {
    api.mockResolvedValueOnce({ cursor })
    const store = useActivityStore()
    await store.returnToApp()
    return store
  }
  const page = (id: number) => ({
    items: [{ id, workspaceId: 'w', kind: 'question' }],
    nextCursor: id,
    cursor: id,
    hasMore: false,
  })
  it('recovers missed events after an offline heartbeat before acknowledging anything', async () => {
    const store = await presentStore()
    api.mockRejectedValueOnce(new Error('offline'))
    await store.heartbeat()
    api.mockResolvedValueOnce(page(9))
    await store.heartbeat()
    expect(api).toHaveBeenLastCalledWith('/api/activity?after=4')
    expect(store.items.map((item) => item.id)).toEqual([9])
    expect(store.cursor).toBe(4)
  })
  it('reloads retained events when the database cursor has moved backwards', async () => {
    localStorage.setItem('kobo:activityVisit', JSON.stringify({ cursor: 100, seenAt: '' }))
    api.mockResolvedValueOnce({ items: [], nextCursor: 100, cursor: 20, hasMore: false })
    api.mockResolvedValueOnce(page(20))
    const store = useActivityStore()
    await store.returnToApp()
    expect(api).toHaveBeenLastCalledWith('/api/activity?after=0')
    expect(store.items.map((item) => item.id)).toEqual([20])
    store.markRead()
    expect(store.cursor).toBe(20)
    expect(JSON.parse(localStorage.getItem('kobo:activityVisit')!).cursor).toBe(20)
  })
  it('detects a restored database in a visible tab heartbeat', async () => {
    const store = await presentStore(100)
    api.mockResolvedValueOnce({ cursor: 20 })
    api.mockResolvedValueOnce(page(20))
    await store.heartbeat()
    expect(store.items.map((item) => item.id)).toEqual([20])
    expect(store.cursor).toBe(0)
  })
  it('keeps a reset checkpoint when recovery fails and retries from zero', async () => {
    const store = await presentStore(100)
    api.mockResolvedValueOnce({ cursor: 20 })
    api.mockRejectedValueOnce(new Error('offline'))
    await store.heartbeat()
    expect(store.cursor).toBe(0)
    expect(store.error).toBe(true)
    api.mockResolvedValueOnce(page(21))
    await store.heartbeat()
    expect(api).toHaveBeenLastCalledWith('/api/activity?after=0')
    expect(store.items.map((item) => item.id)).toEqual([21])
  })
  it('does not start concurrent heartbeat requests', async () => {
    const store = await presentStore()
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const pending = store.heartbeat()
    await store.heartbeat()
    expect(api).toHaveBeenCalledTimes(2)
    resolve({ cursor: 5 })
    await pending
  })
  it('preserves a newer acknowledgement from another tab', async () => {
    const store = await presentStore()
    store.nextCursor = 5
    localStorage.setItem('kobo:activityVisit', JSON.stringify({ cursor: 9, seenAt: '' }))
    store.markRead()
    expect(store.cursor).toBe(9)
  })
  it('invalidates a pending head request when the browser goes offline', async () => {
    const store = await presentStore()
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const pending = store.heartbeat()
    store.connectionLost()
    resolve({ cursor: 9 })
    await pending
    expect(store.cursor).toBe(4)
    expect(store.error).toBe(true)
    api.mockResolvedValueOnce(page(9))
    await store.heartbeat()
    expect(store.items.map((item) => item.id)).toEqual([9])
  })
  it('ignores late recovery data when the app becomes hidden', async () => {
    const store = await presentStore()
    store.connectionLost()
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const pending = store.heartbeat()
    store.leaveApp()
    resolve(page(9))
    await pending
    expect(store.items).toEqual([])
    expect(store.cursor).toBe(4)
    expect(store.loading).toBe(false)
  })
  it('does not loop recovering an empty restored database', async () => {
    const store = await presentStore(100)
    api.mockResolvedValueOnce({ cursor: 0 })
    api.mockResolvedValueOnce({ items: [], nextCursor: 0, cursor: 0, hasMore: false })
    await store.heartbeat()
    expect(store.cursor).toBe(0)
    expect(store.error).toBe(false)
    expect(api).toHaveBeenCalledTimes(3)
  })
  it('discards stale pages if the database is restored during pagination', async () => {
    localStorage.setItem('kobo:activityVisit', JSON.stringify({ cursor: 90, seenAt: '' }))
    const store = useActivityStore()
    api.mockResolvedValueOnce({ ...page(100), hasMore: true })
    await store.returnToApp()
    api.mockResolvedValueOnce({ items: [], nextCursor: 100, cursor: 20, hasMore: false })
    api.mockResolvedValueOnce(page(20))
    await store.loadMore()
    expect(store.items.map((item) => item.id)).toEqual([20])
    expect(store.cursor).toBe(0)
  })
})
