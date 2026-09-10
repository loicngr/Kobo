import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentsStore } from '../stores/documents'

describe('documents store — out-of-order responses', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('ignores a stale openDocument response that resolves after a newer one', async () => {
    const store = useDocumentsStore()
    let resolveA!: (v: Response) => void
    const responseFor = (content: string) =>
      new Response(JSON.stringify({ content, path: `p/${content}` }), { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => new Promise<Response>((r) => (resolveA = r)))
        .mockImplementationOnce(() => Promise.resolve(responseFor('B'))),
    )

    const openA = store.openDocument('w1', { path: 'a.md', name: 'a.md', modifiedAt: '' })
    const openB = store.openDocument('w1', { path: 'b.md', name: 'b.md', modifiedAt: '' })
    await openB
    resolveA(responseFor('A'))
    await openA.catch(() => {})

    expect(store.selected?.content).toBe('B')
  })

  it('aborts an in-flight openDocument when the workspace is cleared, so a late response cannot overwrite selected', async () => {
    const store = useDocumentsStore()
    let resolveFetch!: (v: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => (resolveFetch = r))),
    )

    const open = store.openDocument('w1', { path: 'a.md', name: 'a.md', modifiedAt: '' })
    store.clearForWorkspace('w1')
    resolveFetch(new Response(JSON.stringify({ content: 'A', path: 'a.md' }), { status: 200 }))
    await open.catch(() => {})

    expect(store.selected).toBeNull()
  })
})

it.each(['close', 'clear'])('invalidates a deep-link waiting for its list on %s', async (action) => {
  setActivePinia(createPinia())
  const store = useDocumentsStore()
  let finish!: (response: Response) => void
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(Response.json({ content: 'late', path: 'a.md' }))
  vi.stubGlobal('fetch', fetchMock)
  const pending = store.openDocumentByPath('w1', 'a.md')
  if (action === 'close') store.closeDocument()
  else store.clearForWorkspace('w1')
  finish(Response.json({ documents: [{ path: 'a.md', name: 'a.md', modifiedAt: '' }] }))
  expect(await pending).toBe(false)
  expect(store.selected).toBeNull()
  expect(store.requestOpen).toBe(0)
  expect(store.loadingContent).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('does not reopen a document after the user closes it', async () => {
  setActivePinia(createPinia())
  const store = useDocumentsStore()
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const pending = store.openDocument('w1', { path: 'a.md', name: 'a.md', modifiedAt: '' })
  store.closeDocument()
  finish(Response.json({ content: 'late', path: 'a.md' }))
  await pending
  expect(store.selected).toBeNull()
  expect(store.loadingContent).toBe(false)
})

it.each([200, 500])(
  'clears content loading when a missing deep-link supersedes an open (list HTTP %s)',
  async (status) => {
    setActivePinia(createPinia())
    const store = useDocumentsStore()
    store.selected = { path: 'old.md', name: 'old.md', content: 'already open' }
    let finishOpen!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishOpen = resolve
            }),
        )
        .mockResolvedValueOnce(Response.json({ documents: [] }, { status })),
    )

    const pending = store.openDocument('w1', { path: 'a.md', name: 'a.md', modifiedAt: '' })
    expect(await store.openDocumentByPath('w1', 'missing.md')).toBe(false)
    finishOpen(Response.json({ path: 'a.md', content: 'late' }))
    await pending

    expect(store.loadingContent).toBe(false)
    expect(store.selected?.path).toBe('old.md')
    expect(store.requestOpen).toBe(0)
  },
)

it('does not clear a newer content load when an older deep-link cannot find its document', async () => {
  setActivePinia(createPinia())
  const store = useDocumentsStore()
  let finishList!: (response: Response) => void
  let finishOpen!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishList = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOpen = resolve
          }),
      ),
  )

  const missing = store.openDocumentByPath('w1', 'missing.md')
  const pending = store.openDocument('w1', { path: 'a.md', name: 'a.md', modifiedAt: '' })
  finishList(Response.json({ documents: [] }))
  expect(await missing).toBe(false)
  expect(store.loadingContent).toBe(true)

  finishOpen(Response.json({ path: 'a.md', content: 'current' }))
  await pending
  expect(store.loadingContent).toBe(false)
  expect(store.selected?.content).toBe('current')
})
