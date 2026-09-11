import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSearchStore } from '../stores/search'

const fakeResults = [
  {
    eventId: 'event-1',
    sessionId: 'session-1',
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

  it('does not let a stale search response overwrite a newer one', async () => {
    const store = useSearchStore()
    let resolveFirst!: (v: unknown) => void
    let resolveSecond!: (v: unknown) => void
    const firstResponse = new Promise((r) => {
      resolveFirst = r
    })
    const secondResponse = new Promise((r) => {
      resolveSecond = r
    })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse)
    vi.stubGlobal('fetch', fetchMock)

    store.query = 'first query'
    const firstCall = store.search()
    store.query = 'second query'
    const secondCall = store.search()

    // Newer request's response lands first.
    resolveSecond({ ok: true, headers: new Headers(), json: async () => [{ eventId: 'e2', snippet: 'second' }] })
    await secondCall

    // Older request's response lands after — must NOT overwrite.
    resolveFirst({ ok: true, headers: new Headers(), json: async () => [{ eventId: 'e1', snippet: 'first' }] })
    await firstCall

    expect(store.results).toEqual([{ eventId: 'e2', snippet: 'second' }])
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

  it('does not let a late response overwrite state after clear() during an in-flight search', async () => {
    const store = useSearchStore()
    let resolveFirst!: (v: unknown) => void
    const firstResponse = new Promise((r) => {
      resolveFirst = r
    })
    const fetchMock = vi.fn().mockImplementationOnce(() => firstResponse)
    vi.stubGlobal('fetch', fetchMock)

    store.query = 'first query'
    const firstCall = store.search()
    expect(store.loading).toBe(true)

    // User clicks clear before the response lands.
    store.clear()
    expect(store.loading).toBe(false)
    expect(store.results).toEqual([])
    expect(store.query).toBe('')

    // The stale in-flight response resolves after clear().
    resolveFirst({ ok: true, headers: new Headers(), json: async () => fakeResults })
    await firstCall

    // Must still reflect the cleared state, not the stale response.
    expect(store.results).toEqual([])
    expect(store.loading).toBe(false)
  })

  it('does not let a late response overwrite state after the empty-query short-circuit fires during an in-flight search', async () => {
    const store = useSearchStore()
    let resolveFirst!: (v: unknown) => void
    const firstResponse = new Promise((r) => {
      resolveFirst = r
    })
    const fetchMock = vi.fn().mockImplementationOnce(() => firstResponse)
    vi.stubGlobal('fetch', fetchMock)

    store.query = 'first query'
    const firstCall = store.search()
    expect(store.loading).toBe(true)

    // Query is cleared to empty and search() is triggered again (e.g. debounced input).
    store.query = ''
    const secondCall = store.search()
    await secondCall
    expect(store.loading).toBe(false)
    expect(store.results).toEqual([])

    // The stale in-flight response resolves after the short-circuit.
    resolveFirst({ ok: true, headers: new Headers(), json: async () => fakeResults })
    await firstCall

    expect(store.results).toEqual([])
    expect(store.loading).toBe(false)
  })
})

it('tracks progressive index status without hiding existing results during refresh', async () => {
  const store = useSearchStore()
  store.query = 'needle'
  store.results = fakeResults
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ state: 'building', processed: 500, total: 1200 })),
  )
  expect(await store.refreshIndexStatus()).toBe(true)
  expect(store.indexStatus).toEqual({ state: 'building', processed: 500, total: 1200 })
  expect(store.results).toEqual(fakeResults)
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(fakeResults), { headers: { 'X-Kobo-Search-Partial': 'true' } }),
  )
  const pending = store.search(true)
  expect(store.loading).toBe(false)
  await pending
  expect(store.partial).toBe(true)
})

it('does not regress index progress when concurrent status responses arrive out of order', async () => {
  const store = useSearchStore()
  let first!: (response: Response) => void
  vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          first = resolve
        }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'ready', processed: 1200, total: 1200 })))
  const older = store.refreshIndexStatus()
  await store.refreshIndexStatus()
  first(new Response(JSON.stringify({ state: 'building', processed: 500, total: 1200 })))
  await older
  expect(store.indexStatus.state).toBe('ready')
  expect(store.indexStatus.processed).toBe(1200)
})

it('cancels an unmounted search without clearing the last displayed results', async () => {
  const store = useSearchStore()
  store.query = 'needle'
  store.results = fakeResults
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      }),
  )
  const pending = store.search()
  store.cancel()
  await pending
  expect(store.results).toEqual(fakeResults)
  expect(store.error).toBe('')
  expect(store.loading).toBe(false)
})
