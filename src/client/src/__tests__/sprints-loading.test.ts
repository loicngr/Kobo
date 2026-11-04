import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useSprintStore } from '../stores/sprints'

afterEach(() => vi.unstubAllGlobals())

it('keeps an old catalogue unconfirmed until the latest refresh succeeds', async () => {
  setActivePinia(createPinia())
  const store = useSprintStore()
  store.loaded = true
  store.sprints = [{ id: 'old', name: 'Old', sortOrder: 0, createdAt: '', updatedAt: '' }]
  const replies: ((response: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve))),
  )
  const older = store.fetchSprints()
  const latest = store.fetchSprints()
  expect(store.loaded).toBe(false)
  replies[0]!(Response.json({ sprints: [] }))
  await older
  expect(store.loaded).toBe(false)
  replies[1]!(Response.json({ sprints: [{ id: 'new', name: 'New', sortOrder: 0, createdAt: '', updatedAt: '' }] }))
  await latest
  expect(store.loaded).toBe(true)
  expect(store.sprints.map((s) => s.id)).toEqual(['new'])
})

it('keeps the created sprint selectable if refreshing the catalogue fails', async () => {
  setActivePinia(createPinia())
  const store = useSprintStore()
  const sprint = { id: 'new', name: 'New', sortOrder: 0, createdAt: '', updatedAt: '' }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sprint }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 })),
  )
  expect(await store.create('New')).toEqual(sprint)
  expect(store.sprints).toEqual([sprint])
})

it('does not restore or select a sprint deleted before the catalogue refresh', async () => {
  setActivePinia(createPinia())
  const store = useSprintStore()
  const sprint = { id: 'deleted', name: 'Deleted', sortOrder: 0, createdAt: '', updatedAt: '' }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sprint }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ sprints: [] })),
  )
  expect(await store.create('Deleted')).toBeNull()
  expect(store.sprints).toEqual([])
  expect(store.loaded).toBe(true)
})
