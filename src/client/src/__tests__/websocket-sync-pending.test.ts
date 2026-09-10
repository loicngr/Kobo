import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

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
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  })

  afterEach(() => {
    useWebSocketStore().disconnect()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function connect() {
    const store = useWebSocketStore()
    store.connect()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    return { store, socket }
  }

  it('tracks an actual subscribe sync reactively until even an empty response arrives', () => {
    const { store, socket } = connect()
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

  it('does not create an outstanding request without an open socket', () => {
    const store = useWebSocketStore()
    store.subscribe('absent')
    store.connect()
    store.subscribe('connecting')
    expect(FakeWebSocket.instances[0]!.send).not.toHaveBeenCalled()
    expect(store.pendingSyncRequests).toEqual([])
  })

  it('does not create an outstanding request when sending fails', () => {
    const { store, socket } = connect()
    socket.send.mockImplementation(() => {
      throw new Error('socket closed')
    })
    expect(store._send({ type: 'sync:request', payload: { workspaceIds: ['w1'] } })).toBe(false)
    expect(store.pendingSyncRequests).toEqual([])
  })

  it('consumes overlapping multi-workspace requests in response order', () => {
    const { store, socket } = connect()
    store._send({ type: 'sync:request', payload: { workspaceIds: ['w1', 'w2'] } })
    store.subscribe('w1')
    expect(store.pendingSyncRequests).toEqual([['w1', 'w2'], ['w1']])

    socket.respond()
    expect(store.isSyncPending('w1')).toBe(true)
    expect(store.isSyncPending('w2')).toBe(false)
    socket.respond()
    expect(store.isSyncPending('w1')).toBe(false)
  })

  it('releases only the response being processed when its replay throws', () => {
    const { store, socket } = connect()
    store.subscribe('w1')
    store.subscribe('w2')
    socket.respond({ events: {} })
    expect(store.pendingSyncRequests).toEqual([['w2']])
    expect(store._replaying).toBe(false)
    socket.respond()
    expect(store.pendingSyncRequests).toEqual([])
  })

  it.each(['sync:empty', 'sync:error'])('consumes one request when the server answers %s', (type) => {
    const { store, socket } = connect()
    store.subscribe('w1')
    store.subscribe('w2')
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, payload: {} }) }))
    expect(store.pendingSyncRequests).toEqual([['w2']])
  })

  it.each(['disconnect', 'close', 'offline'])('releases all pending requests on %s', (action) => {
    const { store, socket } = connect()
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

  it('does not attribute late events from an offline connection to a new sync request', () => {
    const { store, socket } = connect()
    store.subscribe('old')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
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

  it('preserves drain and targeted follow-up requests sent while consuming earlier responses', () => {
    const { store, socket } = connect()
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
})
