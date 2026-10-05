import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryStore } from '../stores/memory'

const view = (workspaceId: string) => ({
  scopes: [{ id: `scope-${workspaceId}`, level: 'workspace', workspaceId, generation: 0, revision: 0 }],
  entries: [],
  proposals: [],
  contexts: [],
})

describe('memory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it.each([true, false])('refreshes an initially empty workspace journal (journalOnly=%s)', async (journalOnly) => {
    const store = useMemoryStore()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(Response.json(String(input).includes('/view') ? view('one') : { items: [] })),
      ),
    )
    await store.loadWorkspace('one')
    await store.loadWorkspaceOperations('one')
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockClear()
    store.invalidate({
      scopeId: 'scope-one',
      level: 'workspace',
      revision: 1,
      generation: 0,
      operationId: 1,
      journalOnly,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/operations?workspaceId=one'))).toBe(true)
  })

  it('loads later workspace memory pages without duplicates or losing context metadata', async () => {
    const store = useMemoryStore()
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ...view('ws-1'), entries: [{ id: 'first', revision: 1 }], entriesNextCursor: '50' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { id: 'first', revision: 1 },
            { id: 'second', revision: 1 },
          ],
        }),
      )
    vi.stubGlobal('fetch', request)
    await store.loadWorkspace('ws-1', 'session-a')
    await store.loadMoreWorkspaceEntries('ws-1', 'session-a')
    expect(String(request.mock.calls[1]?.[0])).toContain('cursor=50')
    expect(store.workspaceView('ws-1', 'session-a')?.entries.map((entry) => entry.id)).toEqual(['first', 'second'])
    expect(store.workspaceView('ws-1', 'session-a')?.entriesNextCursor).toBeUndefined()
    expect(store.workspaceView('ws-1', 'session-a')?.scopes).toEqual(view('ws-1').scopes)
  })

  it('appends scope pages and exposes whether more persisted scopes exist', async () => {
    const store = useMemoryStore()
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [{ id: 'scope-1', level: 'project', projectPath: '/one', generation: 0, revision: 0 }],
          nextCursor: '50',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [{ id: 'scope-51', level: 'workspace', workspaceId: 'archived', generation: 0, revision: 0 }],
        }),
      )
    vi.stubGlobal('fetch', request)

    await store.loadScopes()
    expect(store.hasMoreScopes()).toBe(true)
    await store.loadMoreScopes()

    expect(store.scopesFor().map((scope) => scope.id)).toEqual(['scope-1', 'scope-51'])
    expect(store.hasMoreScopes()).toBe(false)
    expect(String(request.mock.calls[1]?.[0])).toContain('cursor=50')
  })

  it('loads the workspace-wide operation journal with independent pagination', async () => {
    const store = useMemoryStore()
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              id: 50,
              scopeId: 'global',
              kind: 'read',
              actor: { kind: 'external-mcp', clientName: 'Client', transport: 'http' },
              createdAt: 'now',
            },
          ],
          nextCursor: '50',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [{ id: 40, scopeId: 'project', kind: 'created', actor: { kind: 'human' }, createdAt: 'then' }],
        }),
      )
    vi.stubGlobal('fetch', request)

    await store.loadWorkspaceOperations('ws-1')
    expect(store.workspaceOperationsCursor('ws-1')).toBe('50')
    await store.loadWorkspaceOperations('ws-1', true)

    expect(store.workspaceOperationsFor('ws-1').map((operation) => operation.id)).toEqual([50, 40])
    expect(store.workspaceOperationsCursor('ws-1')).toBeUndefined()
    expect(String(request.mock.calls[1]?.[0])).toContain('afterCursor=50')
    expect(String(request.mock.calls[1]?.[0])).toContain('workspaceId=ws-1')
  })

  it('does not let an older workspace response replace the latest selected view', async () => {
    const store = useMemoryStore()
    let finishFirst!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => new Promise<Response>((resolve) => (finishFirst = resolve)))
        .mockResolvedValueOnce(Response.json(view('second'))),
    )

    const first = store.loadWorkspace('first', 'session-first')
    const second = store.loadWorkspace('second', 'session-second')
    await second
    finishFirst(Response.json(view('first')))
    await first

    expect(store.activeWorkspaceKey).toBe(JSON.stringify(['second', 'session-second']))
    expect(store.workspaceView('second', 'session-second')?.scopes[0]?.workspaceId).toBe('second')
    expect(store.workspaceView('first', 'session-first')).toBeUndefined()
  })

  it('preserves cached data when a background refresh fails', async () => {
    const store = useMemoryStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(view('one'))))
    await store.loadWorkspace('one', 'session-one')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: 'offline' }, { status: 503 })))

    await expect(store.loadWorkspace('one', 'session-one', true)).rejects.toThrow()
    expect(store.workspaceView('one', 'session-one')?.scopes[0]?.workspaceId).toBe('one')
  })

  it('reloads the selected workspace view from the server after reconnect', async () => {
    const store = useMemoryStore()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(view('one')))
        .mockResolvedValueOnce(Response.json({ items: [{ id: 'old' }], nextCursor: 'next-page' })),
    )
    await store.loadWorkspace('one', 'session-one')
    await store.loadEntries('scope-one')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((input: RequestInfo | URL) =>
          Promise.resolve(
            String(input).includes('/view')
              ? Response.json({ ...view('one'), entries: [{ id: 'fresh' }] })
              : String(input).includes('/entries')
                ? Response.json({ items: [{ id: 'fresh' }] })
                : Response.json({ items: [] }),
          ),
        ),
    )

    await store.refreshVisibleData()

    expect(store.workspaceView('one', 'session-one')?.entries).toEqual([{ id: 'fresh' }])
    expect(store.entriesFor('scope-one')).toEqual([{ id: 'fresh' }])
  })

  it('invalidates only matching project views and paginates operations', async () => {
    const store = useMemoryStore()
    const first = {
      ...view('one'),
      scopes: [{ id: 'project-one', level: 'project', projectPath: '/repo/one', generation: 0, revision: 0 }],
    }
    const second = {
      ...view('two'),
      scopes: [{ id: 'project-two', level: 'project', projectPath: '/repo/two', generation: 0, revision: 0 }],
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(first))
        .mockResolvedValueOnce(Response.json(second))
        .mockImplementation(() => Promise.resolve(Response.json({ items: [] }))),
    )
    await store.loadWorkspace('one', 'session-one')
    await store.loadWorkspace('two', 'session-two')
    store.invalidate({ scopeId: 'project-one', level: 'project', revision: 1, generation: 0, operationId: 7 })
    expect(store.isWorkspaceInvalidated('one', 'session-one')).toBe(true)
    expect(store.isWorkspaceInvalidated('two', 'session-two')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            items: [{ id: 2, scopeId: 'project-one', kind: 'read', actor: { kind: 'human' }, createdAt: 'now' }],
            nextCursor: '2',
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            items: [{ id: 1, scopeId: 'project-one', kind: 'created', actor: { kind: 'human' }, createdAt: 'then' }],
          }),
        ),
    )
    await store.loadOperations('project-one')
    await store.loadOperations('project-one', true)
    expect(store.operationsFor('project-one').map((operation) => operation.id)).toEqual([2, 1])
    expect(store.operationsCursor('project-one')).toBeUndefined()
  })

  it('refreshes a global cache without clearing proposal counts or journals in narrower scopes', async () => {
    const store = useMemoryStore()
    const scopes = [
      { id: 'global-scope', level: 'global' as const, generation: 0, revision: 0 },
      { id: 'project-scope', level: 'project' as const, projectPath: '/repo/one', generation: 0, revision: 0 },
      { id: 'workspace-scope', level: 'workspace' as const, workspaceId: 'one', generation: 0, revision: 0 },
    ]
    const initialView = { ...view('one'), scopes, entries: [], proposals: [], contexts: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/view')) return Promise.resolve(Response.json(initialView))
        if (url.includes('/proposals?')) {
          const scopeId = new URL(url, 'http://localhost').searchParams.get('scopeId')
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: `proposal-${scopeId}`,
                  scopeId,
                  title: scopeId,
                  key: 'k',
                  body: 'b',
                  actor: { kind: 'human' },
                  createdAt: 'now',
                },
              ],
            }),
          )
        }
        if (url.includes('/operations?')) {
          const scopeId = new URL(url, 'http://localhost').searchParams.get('scopeId')
          return Promise.resolve(
            Response.json({
              items: [
                {
                  id: scopeId === 'global-scope' ? 1 : 2,
                  scopeId,
                  kind: 'created',
                  actor: { kind: 'human' },
                  createdAt: 'now',
                },
              ],
            }),
          )
        }
        return Promise.resolve(Response.json({ items: [] }))
      }),
    )
    await store.loadWorkspace('one', 'session-one')
    for (const scope of scopes) {
      await store.loadProposals(scope.id)
      await store.loadOperations(scope.id)
    }
    expect(store.pendingProposalCount(['project-scope', 'workspace-scope'])).toBe(2)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/view')) return Promise.resolve(Response.json({ ...initialView, proposals: [] }))
        if (url.includes('/proposals?scopeId=global-scope')) return Promise.resolve(Response.json({ items: [] }))
        if (url.includes('/operations?scopeId=global-scope')) return Promise.resolve(Response.json({ items: [] }))
        return Promise.resolve(Response.json({ items: [] }))
      }),
    )
    store.invalidate({ scopeId: 'global-scope', level: 'global', revision: 1, generation: 0, operationId: 11 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.pendingProposalCount(['global-scope'])).toBe(0)
    expect(store.pendingProposalCount(['project-scope', 'workspace-scope'])).toBe(2)
    expect(store.operationsFor('project-scope')).toHaveLength(1)
    expect(store.operationsFor('workspace-scope')).toHaveLength(1)
  })

  it('routes memory invalidation events through the websocket dispatcher', async () => {
    const store = useMemoryStore()
    const invalidate = vi.spyOn(store, 'invalidate')
    const { useWebSocketStore } = await import('../stores/websocket')
    useWebSocketStore()._routeMessage({
      type: 'memory:changed',
      payload: { scopeId: 'scope-1', level: 'global', revision: 4, generation: 2, operationId: 9 },
    })
    expect(invalidate).toHaveBeenCalledWith({
      scopeId: 'scope-1',
      level: 'global',
      revision: 4,
      generation: 2,
      operationId: 9,
    })
  })

  it('keeps journal-only read events live without reloading the workspace view, while mutations still refresh it', async () => {
    const store = useMemoryStore()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/view')) return Promise.resolve(Response.json(view('one')))
        return Promise.resolve(Response.json({ items: [] }))
      }),
    )
    await store.loadWorkspace('one', 'session-one')
    calls.length = 0
    const { useWebSocketStore } = await import('../stores/websocket')
    const websocket = useWebSocketStore()

    websocket._routeMessage({
      type: 'memory:changed',
      payload: {
        scopeId: 'scope-one',
        level: 'workspace',
        revision: 0,
        generation: 0,
        operationId: 10,
        journalOnly: true,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((url) => url.includes('/view'))).toBe(false)
    expect(calls.some((url) => url.includes('/operations'))).toBe(true)

    calls.length = 0
    websocket._routeMessage({
      type: 'memory:changed',
      payload: { scopeId: 'scope-one', level: 'workspace', revision: 1, generation: 0, operationId: 11 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((url) => url.includes('/view'))).toBe(true)
  })

  it('tracks pending proposals by scope and preserves conflict errors for explicit resolution', async () => {
    const store = useMemoryStore()
    const proposal = {
      id: 'proposal-1',
      scopeId: 'scope-one',
      key: 'a',
      title: 'A',
      body: 'B',
      actor: { kind: 'human' },
      createdAt: 'now',
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ items: [proposal] }))
        .mockResolvedValueOnce(Response.json({ items: [{ ...proposal, id: 'proposal-2', scopeId: 'scope-two' }] })),
    )
    await store.loadProposals('scope-one')
    await store.loadProposals('scope-two')
    expect(store.pendingProposalCount(['scope-one'])).toBe(1)
    expect(store.pendingProposalCount(['scope-two'])).toBe(1)

    const created = {
      id: 'entry-created',
      scopeId: 'scope-one',
      key: 'a',
      title: 'A',
      body: 'B',
      revision: 1,
      actor: { kind: 'human' },
      createdAt: 'now',
      updatedAt: 'now',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(created, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: 'Memory changed since it was loaded' }, { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await store.createEntry({ scopeId: 'scope-one', key: 'a', title: 'A', body: 'B' })).toMatchObject(created)
    await expect(
      store.updateEntry(
        {
          id: 'entry-1',
          scopeId: 'scope-one',
          key: 'a',
          title: 'A',
          body: 'B',
          revision: 1,
          actor: { kind: 'human' },
          createdAt: 'now',
          updatedAt: 'now',
        },
        { title: 'Changed' },
      ),
    ).rejects.toMatchObject({ status: 409, message: 'Memory changed since it was loaded' })
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/memory/entries/entry-1')
  })

  it('submits human proposal decisions and promotion to their exact endpoints', async () => {
    const store = useMemoryStore()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ error: 'Target key already exists' }, { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    await store.decideProposal('proposal-1', 'reject')
    await expect(
      store.promoteEntry(
        {
          id: 'entry-1',
          scopeId: 'scope-one',
          key: 'a',
          title: 'A',
          body: 'B',
          revision: 1,
          actor: { kind: 'human' },
          createdAt: 'now',
          updatedAt: 'now',
        },
        'scope-global',
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/memory/proposals/proposal-1/reject',
      '/api/memory/entries/entry-1/promote',
    ])
  })
})
