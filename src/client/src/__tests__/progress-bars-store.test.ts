import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProgressBar, ProgressBarList } from '../../../shared/progress-bars'
import { useProgressBarsStore } from '../stores/progress-bars'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const now = '2026-10-12T12:00:00.000Z'
function bar(overrides: Partial<ProgressBar> = {}): ProgressBar {
  return {
    id: 'p1',
    workspaceId: 'w1',
    sessionId: 's1',
    label: 'Tests',
    step: null,
    current: null,
    total: null,
    status: 'running',
    dismissed: false,
    dismissedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sequence: 0,
    ...overrides,
  }
}
function page(items: ProgressBar[], nextOffset: number | null = null): ProgressBarList {
  return { items, totalCount: items.length, nextOffset, serverTime: now }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.mocked(apiFetch).mockReset()
})
afterEach(() => {
  useProgressBarsStore().reset()
  vi.useRealTimers()
})
it('reads every page including failures after hidden entries and merges newer live revisions', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  const pending = deferred<ProgressBarList>()
  vi.mocked(apiFetch)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(page([bar({ id: 'failed', status: 'failed' })]))
  const request = store.refresh()
  store.apply(bar({ revision: 3, current: 3, total: 5 }))
  pending.resolve(page([bar(), bar({ id: 'hidden', dismissed: true })], 100))
  await request
  expect(store.visible.map((item) => item.id)).toEqual(['failed', 'p1'])
  expect(store.records.p1?.current).toBe(3)
  expect(vi.mocked(apiFetch).mock.calls[1]?.[0]).toContain('offset=100')
})
it('ignores earlier A responses after switching A to B to A, including errors and clock offset', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  const pending = deferred<ProgressBarList>()
  vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
  const request = store.refresh()
  store.selectScope('w2', 's2')
  store.selectScope('w1', 's1')
  pending.resolve({ ...page([bar()]), serverTime: '2030-01-01T00:00:00Z' })
  await request
  expect(store.visible).toEqual([])
  store.apply(bar({ status: 'succeeded', completedAt: now }))
  expect(store.visible).toHaveLength(1)
  const failure = deferred<ProgressBarList>()
  vi.mocked(apiFetch).mockReturnValueOnce(failure.promise)
  const rejected = store.refresh()
  store.selectScope('w2', 's2')
  failure.reject(new Error('Old error'))
  await rejected
  expect(store.error).toBeNull()
})
it('expires success from server completion with clock skew and never restarts its delay', async () => {
  vi.setSystemTime('2026-10-12T15:00:00.000Z')
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar({ status: 'succeeded', completedAt: now }))
  vi.mocked(apiFetch).mockResolvedValue(page([bar({ status: 'succeeded', completedAt: now })]))
  await store.refresh()
  expect(store.visible).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(4_000)
  vi.mocked(apiFetch).mockResolvedValue({ ...page([]), serverTime: '2026-10-12T12:00:04.000Z' })
  await store.refresh()
  expect(store.visible).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(store.visible).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
it('keeps failure/interruption visible and cancels timers when scope is reset', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar({ status: 'failed' }))
  store.apply(bar({ id: 'i', status: 'interrupted' }))
  store.apply(bar({ id: 's', status: 'succeeded', completedAt: now }))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(store.visible).toHaveLength(2)
  store.reset()
  expect(vi.getTimerCount()).toBe(0)
  expect(store.visible).toEqual([])
})
it('rolls back only the optimistic mask on failure, retaining a newer live update', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar())
  const pending = deferred<ProgressBar>()
  vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
  const request = store.dismiss('p1')
  expect(store.visible).toEqual([])
  store.apply(bar({ revision: 2, current: 4, total: 5 }))
  pending.reject(new Error('Offline'))
  expect(await request).toBe(false)
  expect(store.visible[0]?.current).toBe(4)
  expect(store.error).toBe('dismiss')
})
it('preserves cross-client dismissal across a pending failure, late updates, and refetch', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar())
  const pending = deferred<ProgressBar>()
  vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
  const request = store.dismiss('p1')
  store.apply(bar({ revision: 3, dismissed: true, dismissedAt: now }))
  pending.reject(new Error('Lost reply'))
  await request
  store.apply(bar({ revision: 2 }))
  store.apply(bar({ revision: 4 }))
  vi.mocked(apiFetch).mockResolvedValue(page([bar()]))
  await store.refresh()
  expect(store.visible).toEqual([])
  store.apply(bar({ id: 'new' }))
  expect(store.visible.map((item) => item.id)).toEqual(['new'])
})
it('ignores unrelated sessions and clears synchronously when no session is selected', () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar())
  store.apply(bar({ id: 'other', sessionId: 's2' }))
  expect(store.visible).toHaveLength(1)
  store.selectScope('w1', null)
  expect(store.visible).toEqual([])
})

it('does not apply a late dismissal reply to a reselected scope', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar())
  const pending = deferred<ProgressBar>()
  vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
  const request = store.dismiss('p1')
  store.selectScope('w2', 's2')
  store.selectScope('w1', 's1')
  store.apply(bar({ revision: 3, current: 2, total: 5 }))
  pending.resolve(bar({ revision: 2, dismissed: true, dismissedAt: now }))
  await request
  expect(store.visible[0]?.revision).toBe(3)
  expect(store.pendingDismissals).toEqual({})
})

it('shares one timer across completed activities and schedules the next remaining expiry', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar({ status: 'succeeded', completedAt: now }))
  store.apply(bar({ id: 'p2', status: 'succeeded', completedAt: '2026-10-12T12:00:02.000Z' }))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(store.visible.map((item) => item.id)).toEqual(['p2'])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(store.visible).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('discards a failed dismissal received after its success expired, even after refresh', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar({ status: 'succeeded', completedAt: now }))
  await vi.advanceTimersByTimeAsync(4000)
  const pending = deferred<ProgressBar>()
  vi.mocked(apiFetch).mockReturnValueOnce(pending.promise)
  const request = store.dismiss('p1')
  await vi.advanceTimersByTimeAsync(2000)
  pending.reject(new Error('Offline'))
  await request
  expect(store.visible).toEqual([])
  expect(store.error).toBeNull()
  vi.mocked(apiFetch).mockResolvedValue({ ...page([]), serverTime: '2026-10-12T12:00:06.000Z' })
  await store.refresh()
  expect(store.error).toBeNull()
})

it('clears only an expired activity dismissal error while unrelated activities remain visible', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar({ status: 'succeeded', completedAt: now }))
  store.apply(bar({ id: 'other' }))
  await vi.advanceTimersByTimeAsync(4000)
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Offline'))
  await store.dismiss('p1')
  expect(store.error).toBe('dismiss')
  await vi.advanceTimersByTimeAsync(1000)
  expect(store.visible.map((item) => item.id)).toEqual(['other'])
  expect(store.error).toBeNull()
})

it('preserves a useful dismissal error until that activity is dismissed by another client', async () => {
  const store = useProgressBarsStore()
  store.selectScope('w1', 's1')
  store.apply(bar())
  store.apply(bar({ id: 'other', status: 'succeeded', completedAt: now }))
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Offline'))
  await store.dismiss('p1')
  await vi.advanceTimersByTimeAsync(5000)
  expect(store.visible.map((item) => item.id)).toEqual(['p1'])
  expect(store.error).toBe('dismiss')
  store.apply(bar({ revision: 2, dismissed: true, dismissedAt: now }))
  expect(store.error).toBeNull()
})
