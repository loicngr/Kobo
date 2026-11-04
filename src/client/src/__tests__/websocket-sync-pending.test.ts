vi.mock('../utils/auth-token', () => ({
  authenticatedWebSocketUrl: vi.fn(async (path: string) => `ws://localhost${path}?ticket=test`),
}))

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { useAutoLoopReviewStore } from '../stores/auto-loop-review'
import { useDevServerStore } from '../stores/dev-server'
import { useMemoryStore } from '../stores/memory'
import { useParallelReviewStore } from '../stores/parallel-review'
import { usePinnedMessagesStore } from '../stores/pinned-messages'
import { useProgressBarsStore } from '../stores/progress-bars'
import { useSessionHandoffStore } from '../stores/session-handoff'
import { useSprintStore } from '../stores/sprints'
import { useUpdateStore } from '../stores/update'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'
import { authenticatedWebSocketUrl } from '../utils/auth-token'

class FakeWebSocket extends EventTarget {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  send = vi.fn()

  constructor(_url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  respond(payload: Record<string, unknown> = { events: [] }) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'sync:response', payload }) }))
  }
}

// Reuse one store, as in the app: its network listeners are bound once and
// retain that store. Reset data and the connection between cases.
const pinia = createPinia()

describe('websocket sync request loading', () => {
  beforeEach(() => {
    setActivePinia(pinia)
    useWebSocketStore().$reset()
    useWorkspaceStore().$reset()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(useUpdateStore(), 'refreshSnapshot').mockResolvedValue()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(useWorkspaceStore(), 'fetchWorkspaces').mockResolvedValue()
    vi.spyOn(useSprintStore(), 'fetchSprints').mockResolvedValue()
    vi.spyOn(useMemoryStore(), 'refreshVisibleData').mockResolvedValue()
    vi.spyOn(useProgressBarsStore(), 'refresh').mockResolvedValue()
    vi.spyOn(usePinnedMessagesStore(), 'refresh').mockResolvedValue([])
    vi.spyOn(useAutoLoopReviewStore(), 'refreshKnown').mockResolvedValue()
    vi.spyOn(useParallelReviewStore(), 'refreshKnown').mockResolvedValue()
    vi.spyOn(useWorkspaceStore(), 'fetchWorkspacesInfo').mockResolvedValue()
    vi.spyOn(useWorkspaceStore(), 'fetchAutoLoopStates').mockResolvedValue()
    vi.spyOn(useWorkspaceStore(), 'fetchAutoLoopMessages').mockResolvedValue()
    vi.spyOn(useDevServerStore(), 'fetchStatus').mockResolvedValue()
    vi.spyOn(useSessionHandoffStore(), 'refresh').mockResolvedValue()
  })

  afterEach(() => {
    useWebSocketStore().disconnect()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function connect() {
    const store = useWebSocketStore()
    await store.connect()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    return { store, socket }
  }

  it('subscribes workspaces discovered by the reconnect list before live refresh finishes', async () => {
    const workspaces = useWorkspaceStore()
    workspaces.workspaces = [{ id: 'old' } as Workspace]
    vi.spyOn(workspaces, 'fetchWorkspaces').mockImplementation(async () => {
      workspaces.workspaces = [{ id: 'old' } as Workspace, { id: 'new' } as Workspace]
    })
    vi.mocked(workspaces.fetchWorkspacesInfo).mockImplementation(() => new Promise<void>(() => {}))
    const { socket } = await connect()
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', payload: { workspaceId: 'new' } })),
    )
  })

  it('subscribes after the winning list applies when a sprint refresh invalidates the reconnect list', async () => {
    const workspaces = useWorkspaceStore()
    const oldWorkspace = { id: 'old', status: 'executing' } as Workspace
    const newWorkspace = { id: 'new', status: 'executing' } as Workspace
    workspaces.workspaces = [oldWorkspace]
    vi.mocked(workspaces.fetchWorkspaces).mockRestore()
    const reads: Array<(response: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        if (String(input) === '/api/workspaces') return new Promise<Response>((resolve) => reads.push(resolve))
        return Promise.reject(new Error(`Unexpected request: ${String(input)}`))
      }),
    )
    const { store, socket } = await connect()
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    store._routeMessage({ type: 'sprint:changed', payload: {} })
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    reads[0]!(Response.json([oldWorkspace, newWorkspace]))
    await vi.waitFor(() => expect(workspaces.listRequestVersion).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', payload: { workspaceId: 'new' } }))
    reads[1]!(Response.json([oldWorkspace, newWorkspace]))
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', payload: { workspaceId: 'new' } })),
    )
    expect(
      socket.send.mock.calls.filter(
        ([message]) => message === JSON.stringify({ type: 'subscribe', payload: { workspaceId: 'new' } }),
      ),
    ).toHaveLength(1)
  })

  it('does not subscribe from a stale connection when a list finishes late', async () => {
    const workspaces = useWorkspaceStore()
    let finish!: () => void
    vi.spyOn(workspaces, 'fetchWorkspaces').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { store, socket } = await connect()
    store.disconnect()
    workspaces.workspaces = [{ id: 'new' } as Workspace]
    finish()
    await Promise.resolve()
    expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', payload: { workspaceId: 'new' } }))
  })

  it('retrieves release availability on initial connection and reconnect', async () => {
    const { store } = await connect()
    expect(useUpdateStore().refreshSnapshot).toHaveBeenCalledTimes(1)
    store.disconnect()
    await connect()
    expect(useUpdateStore().refreshSnapshot).toHaveBeenCalledTimes(2)
  })

  it('tracks an actual subscribe sync reactively until even an empty response arrives', async () => {
    const { store, socket } = await connect()
    const pending = computed(() => store.isSyncPending('w1'))
    expect(pending.value).toBe(false)

    store.subscribe('w1')
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'sync:request', payload: { workspaceIds: ['w1'] } }),
    )
    expect(store.pendingSyncRequests).toEqual([['w1']])
    expect(pending.value).toBe(true)

    socket.respond()
    expect(store.pendingSyncRequests).toEqual([])
    expect(pending.value).toBe(false)
  })

  it('does not create an outstanding request without an open socket', async () => {
    const store = useWebSocketStore()
    store.subscribe('absent')
    await store.connect()
    store.subscribe('connecting')
    expect(FakeWebSocket.instances[0]!.send).not.toHaveBeenCalled()
    expect(store.pendingSyncRequests).toEqual([])
  })

  it('does not create an outstanding request when sending fails', async () => {
    const { store, socket } = await connect()
    socket.send.mockImplementation(() => {
      throw new Error('socket closed')
    })
    expect(store._send({ type: 'sync:request', payload: { workspaceIds: ['w1'] } })).toBe(false)
    expect(store.pendingSyncRequests).toEqual([])
  })

  it('consumes overlapping multi-workspace requests in response order', async () => {
    const { store, socket } = await connect()
    store._send({ type: 'sync:request', payload: { workspaceIds: ['w1', 'w2'] } })
    store.subscribe('w1')
    expect(store.pendingSyncRequests).toEqual([['w1', 'w2'], ['w1']])

    socket.respond()
    expect(store.isSyncPending('w1')).toBe(true)
    expect(store.isSyncPending('w2')).toBe(false)
    socket.respond()
    expect(store.isSyncPending('w1')).toBe(false)
  })

  it('releases only the response being processed when its replay throws', async () => {
    const { store, socket } = await connect()
    store.subscribe('w1')
    store.subscribe('w2')
    socket.respond({ events: {} })
    expect(store.pendingSyncRequests).toEqual([['w2']])
    expect(store._replaying).toBe(false)
    socket.respond()
    expect(store.pendingSyncRequests).toEqual([])
  })

  it.each(['sync:empty', 'sync:error'])('consumes one request when the server answers %s', async (type) => {
    const { store, socket } = await connect()
    store.subscribe('w1')
    store.subscribe('w2')
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, payload: {} }) }))
    expect(store.pendingSyncRequests).toEqual([['w2']])
  })

  it.each(['disconnect', 'close', 'offline'])('releases all pending requests on %s', async (action) => {
    const { store, socket } = await connect()
    store.subscribe('w1')
    store.subscribe('w2')
    expect(store.pendingSyncRequests).toHaveLength(2)
    if (action === 'disconnect') store.disconnect()
    else if (action === 'close') socket.close()
    else {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      window.dispatchEvent(new Event('offline'))
      store.subscribe('offline')
    }
    expect(store.pendingSyncRequests).toEqual([])
    expect(store.isSyncPending('w1')).toBe(false)
  })

  it('does not attribute late events from an offline connection to a new sync request', async () => {
    const { store, socket } = await connect()
    store.subscribe('old')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(useWorkspaceStore(), 'fetchWorkspacesInfo').mockResolvedValue()
    vi.spyOn(useDevServerStore(), 'fetchStatus').mockResolvedValue()
    vi.spyOn(useSessionHandoffStore(), 'refresh').mockResolvedValue()
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    const replacement = FakeWebSocket.instances.at(-1)!
    replacement.open()
    store.subscribe('new')

    socket.respond()
    socket.close()
    expect(store.isSyncPending('new')).toBe(true)
    expect(store.connected).toBe(true)
    replacement.respond()
    expect(store.isSyncPending('new')).toBe(false)
  })

  it('preserves drain and targeted follow-up requests sent while consuming earlier responses', async () => {
    const { store, socket } = await connect()
    useWorkspaceStore().workspaces = [{ id: 'w1' }, { id: 'w2' }] as Workspace[]
    store.subscribe('w1')
    socket.respond({
      truncated: true,
      events: [
        { id: 'evt-1', workspaceId: 'w1', type: 'agent:event', payload: { kind: 'message:end', messageId: 'm1' } },
      ],
    })
    expect(store.pendingSyncRequests).toEqual([['w1', 'w2']])

    store.subscribe('w2')
    socket.respond()
    expect(store.pendingSyncRequests).toEqual([['w2'], ['w2']])
    socket.respond()
    expect(store.isSyncPending('w2')).toBe(true)
    socket.respond()
    expect(store.isSyncPending('w2')).toBe(false)
  })
  it('refreshes live status and pending inputs after the reconnect delta drain completes', async () => {
    const workspace = useWorkspaceStore()
    workspace.workspaces = [{ id: 'w1' }] as Workspace[]
    workspace.selectedWorkspaceId = 'w1'
    const ws = useWebSocketStore()
    ws.lastEventId = 'before'
    const { socket } = await connect()
    expect(workspace.fetchWorkspacesInfo).not.toHaveBeenCalled()
    socket.respond({
      truncated: true,
      events: [
        { id: 'middle', workspaceId: 'w1', type: 'agent:event', payload: { kind: 'message:end', messageId: 'm' } },
      ],
    })
    expect(workspace.fetchWorkspacesInfo).not.toHaveBeenCalled()
    socket.respond()
    await Promise.resolve()
    expect(workspace.fetchWorkspacesInfo).toHaveBeenCalledTimes(1)
    expect(useDevServerStore().fetchStatus).toHaveBeenCalledWith('w1')
  })

  it('refreshes auto-loop instructions after reconnect even when no new message event is replayed', async () => {
    const workspace = useWorkspaceStore()
    workspace.workspaces = [{ id: 'w1' }] as Workspace[]
    workspace.selectedWorkspaceId = 'w1'
    workspace.autoLoopMessages.w1 = []
    workspace.autoLoopMessages['previously-opened'] = []
    const ws = useWebSocketStore()
    ws.lastEventId = 'before'
    const { socket } = await connect()
    socket.respond()
    await Promise.resolve()
    await Promise.resolve()
    expect(workspace.fetchAutoLoopStates).toHaveBeenCalledTimes(1)
    expect(workspace.fetchAutoLoopMessages).toHaveBeenCalledWith('w1')
    expect(workspace.fetchAutoLoopMessages).toHaveBeenCalledWith('previously-opened')
    expect(workspace.fetchAutoLoopMessages).toHaveBeenCalledTimes(2)
  })
  it('does not reopen a disconnected client after a delayed upgrade ticket arrives', async () => {
    let resolveTicket!: (value: string) => void
    vi.mocked(authenticatedWebSocketUrl).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve
        }),
    )
    const store = useWebSocketStore()
    const pending = store.connect()
    store.disconnect()
    resolveTicket('ws://localhost/ws?ticket=stale')
    await pending
    expect(FakeWebSocket.instances).toHaveLength(0)
    await store.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('replaces a handshake that never opens or closes and then reconnects', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const store = useWebSocketStore()
    await store.connect()
    const stale = FakeWebSocket.instances[0]!
    vi.spyOn(stale, 'close').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(20_000)
    expect(store.reconnecting).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const replacement = FakeWebSocket.instances.at(-1)!
    expect(replacement).not.toBe(stale)
    replacement.open()
    expect(store.connected).toBe(true)
    stale.dispatchEvent(new Event('close'))
    expect(store.connected).toBe(true)
  })

  it('recovers on Android foreground return even if the old socket still reports OPEN', async () => {
    vi.useFakeTimers()
    const { store, socket } = await connect()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    const resumed = FakeWebSocket.instances.at(-1)!
    expect(resumed).not.toBe(socket)
    resumed.open()
    expect(store.connected).toBe(true)
    expect(store.reconnecting).toBe(false)
    expect(authenticatedWebSocketUrl).toHaveBeenLastCalledWith('/ws')
    socket.dispatchEvent(new Event('error'))
    expect(store.connected).toBe(true)
  })

  it('preserves pending deliveries when a healthy socket answers the foreground probe', async () => {
    vi.useFakeTimers()
    const { store, socket } = await connect()
    const delivered = store.sendChatMessageConfirmed('w1', 'Send once')
    const settled = vi.fn()
    void delivered.then(settled, settled)
    const sent = JSON.parse(socket.send.mock.calls.at(-1)![0])
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({ type: 'sync:request', payload: {} })
    socket.respond()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(settled).not.toHaveBeenCalled()
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'chat:accepted',
          workspaceId: 'w1',
          payload: { clientMessageId: sent.payload.clientMessageId },
        }),
      }),
    )
    await expect(delivered).resolves.toBeUndefined()
  })

  it('cancels an outstanding foreground probe on explicit disconnect', async () => {
    vi.useFakeTimers()
    const { store } = await connect()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    store.disconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('invalidates a suspended ticket request on resume and ignores its late result', async () => {
    let release!: (url: string) => void
    vi.mocked(authenticatedWebSocketUrl).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const store = useWebSocketStore()
    const pending = store.connect()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    release('ws://localhost/ws?ticket=stale')
    await pending
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.open()
    expect(store.connected).toBe(true)
  })

  it('recovers from an error even when no close event follows', async () => {
    vi.useFakeTimers()
    const { store, socket } = await connect()
    vi.spyOn(socket, 'close').mockImplementation(() => {})
    socket.dispatchEvent(new Event('error'))
    expect(store.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    const next = FakeWebSocket.instances.at(-1)!
    expect(next).not.toBe(socket)
    next.open()
    expect(store.connected).toBe(true)
  })

  it('does not restart after an explicit disconnect on foreground, online or authentication events', async () => {
    const { store } = await connect()
    store.disconnect()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('kobo:auth-token-changed'))
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(store.connected).toBe(false)
  })
})
