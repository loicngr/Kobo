import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutoLoopFinalReviewStatus } from '../../../shared/auto-loop-review'
import { useAutoLoopReviewStore } from '../stores/auto-loop-review'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

const configuration = {
  engine: 'codex',
  model: 'auto',
  reasoningEffort: 'high',
  additionalInstructions: 'Check migrations',
}
const status: AutoLoopFinalReviewStatus = {
  configuration,
  state: 'pending',
  cycle: 0,
  findingsCount: null,
  reason: null,
  reviewSessionId: null,
  originalSessionId: null,
}
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

it('saves final review configuration separately without launching the loop', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(status))
  vi.stubGlobal('fetch', fetch)
  const store = useAutoLoopReviewStore()
  await store.saveFinalReview('w', configuration)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/workspaces/w/auto-loop/final-review')
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('PATCH')
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body)).toEqual({ configuration })
  expect(store.finalReviews.w).toEqual(status)
})

it('does not overwrite a live review state with an older configuration load', async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    ),
  )
  const store = useAutoLoopReviewStore()
  const pending = store.fetchFinalReview('w')
  store.setFinalReview('w', { ...status, state: 'reviewing', cycle: 1 })
  resolve(Response.json(status))
  await pending
  expect(store.finalReviews.w?.state).toBe('reviewing')
})

it('keeps the saved configuration after an unsuccessful update', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Review in progress' }, { status: 409 })))
  const store = useAutoLoopReviewStore()
  store.setFinalReview('w', status)
  await expect(store.saveFinalReview('w', null)).rejects.toThrow('Review in progress')
  expect(store.finalReviews.w).toEqual(status)
})

it('does not resurrect a completed return from an older load', async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    ),
  )
  const store = useAutoLoopReviewStore()
  const pending = store.fetchReturn('w')
  store.setReturn('w', null)
  resolve(Response.json({ reviewSessionId: 'review', originalSessionId: 'original', phase: 'reviewing', error: null }))
  await pending
  expect(store.returns.w).toBeNull()
})

it('refreshes pending returns after reconnect, including a previously failed first load', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json(null))
  vi.stubGlobal('fetch', fetch)
  const store = useAutoLoopReviewStore()
  await expect(store.fetchReturn('w')).rejects.toThrow('offline')
  await store.refreshKnown()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(store.returns.w).toBeNull()
})

it('ignores an in-flight return response after workspace deletion', async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    ),
  )
  const store = useAutoLoopReviewStore()
  const pending = store.fetchReturn('w')
  store.forget('w')
  resolve(Response.json({ reviewSessionId: 'review', originalSessionId: 'original', phase: 'reviewing', error: null }))
  await pending
  expect(store.returns).not.toHaveProperty('w')
})

it('retains a blocked loop snapshot alongside a newer final review event', async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    ),
  )
  const workspaces = useWorkspaceStore()
  const pending = workspaces.fetchAutoLoopStates()
  useWebSocketStore()._routeMessage({
    type: 'autoloop:final-review',
    workspaceId: 'w',
    payload: { ...status, state: 'blocked', reason: 'Launch failed' },
  })
  resolve(Response.json({ w: { auto_loop: true, state: 'blocked', reason: 'Launch failed', finalReview: status } }))
  await pending
  expect(workspaces.autoLoopStates.w?.state).toBe('blocked')
  expect(workspaces.autoLoopStates.w?.finalReview?.state).toBe('blocked')
})
