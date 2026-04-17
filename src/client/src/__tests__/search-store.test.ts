import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSearchStore } from '../stores/search'

const fakeResults = [
  {
    workspaceId: 'ws-1',
    workspaceName: 'My Work',
    archived: false,
    type: 'user:message',
    timestamp: '2026-04-17T10:00:00Z',
    snippet: '…some text…',
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('search store', () => {
  it('starts with empty query, no results, not loading', () => {
    const store = useSearchStore()
    expect(store.query).toBe('')
    expect(store.results).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.includeArchived).toBe(false)
  })

  it('skips the fetch and clears results when query is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    const store = useSearchStore()
    store.results = fakeResults
    await store.search()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.results).toEqual([])
  })

  it('populates results on successful fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(fakeResults), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const store = useSearchStore()
    store.query = 'needle'
    await store.search()
    expect(store.results).toEqual(fakeResults)
    expect(store.error).toBe('')
  })

  it('sends includeArchived=true when flag is set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
    const store = useSearchStore()
    store.query = 'q'
    store.includeArchived = true
    await store.search()
    const url = fetchSpy.mock.calls[0]?.[0] as string
    expect(url).toContain('includeArchived=true')
  })

  it('does not send includeArchived when flag is false', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
    const store = useSearchStore()
    store.query = 'q'
    store.includeArchived = false
    await store.search()
    const url = fetchSpy.mock.calls[0]?.[0] as string
    expect(url).not.toContain('includeArchived')
  })

  it('records error and clears results on HTTP failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'db exploded' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const store = useSearchStore()
    store.query = 'q'
    store.results = fakeResults
    await store.search()
    expect(store.error).toContain('db exploded')
    expect(store.results).toEqual([])
  })

  it('trims whitespace before searching', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
    const store = useSearchStore()
    store.query = '   hello   '
    await store.search()
    const url = fetchSpy.mock.calls[0]?.[0] as string
    expect(url).toContain('q=hello')
  })

  it('clear() resets query, results and error', () => {
    const store = useSearchStore()
    store.query = 'x'
    store.results = fakeResults
    store.error = 'boom'
    store.clear()
    expect(store.query).toBe('')
    expect(store.results).toEqual([])
    expect(store.error).toBe('')
  })
})
