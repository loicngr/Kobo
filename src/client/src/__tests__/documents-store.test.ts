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
