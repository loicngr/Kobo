import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import ActivityFeed from '../components/ActivityFeed.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

// Content height reported by the stub; a test can make it grow after each
// scroll, as QVirtualScroll does once it measures the real item heights.
let stubScrollSize = 1000
let onStubScroll: (() => void) | null = null

const QScrollAreaStub = defineComponent({
  name: 'QScrollArea',
  emits: ['scroll'],
  setup(_props, { slots, emit, expose }) {
    const root = ref<HTMLElement | null>(null)
    const api = {
      getScroll: () => ({
        verticalSize: stubScrollSize,
        verticalPosition: 0,
        verticalContainerSize: 400,
      }),
      getScrollTarget: () => root.value ?? document.createElement('div'),
      setScrollPosition: vi.fn(() => onStubScroll?.()),
      emitScroll: (info: { verticalPosition: number; verticalSize: number; verticalContainerSize: number }) =>
        emit('scroll', info),
    }
    expose(api)
    return () => h('div', { ref: root, class: 'q-scroll-area-stub' }, slots.default?.())
  },
})

const QVirtualScrollStub = defineComponent({
  name: 'QVirtualScroll',
  props: { items: { type: Array, default: () => [] } },
  emits: ['virtual-scroll'],
  setup(props, { slots, expose }) {
    expose({ scrollTo: vi.fn() })
    // Render everything: virtualisation is a rendering strategy, not a
    // behaviour this suite asserts on.
    return () =>
      h(
        'div',
        { class: 'q-virtual-scroll-stub' },
        props.items.map((item, index) => slots.default?.({ item, index })),
      )
  },
})

const globalStubs = {
  TurnCard: { template: '<div class="turn-card-stub"></div>' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-spinner': { template: '<span class="q-spinner"></span>' },
  'q-spinner-dots': { template: '<span class="q-spinner-dots"></span>' },
  'q-icon': { template: '<span class="q-icon"></span>' },
  'q-expansion-item': { template: '<div><slot /></div>' },
  'q-scroll-area': QScrollAreaStub,
  'q-virtual-scroll': QVirtualScrollStub,
}

describe('ActivityFeed.vue', () => {
  it('opens cached user-only conversations at the measured bottom, including after reselection', async () => {
    const store = useWorkspaceStore()
    for (const workspaceId of ['first-user', 'second-user']) {
      store.addActivityItem(workspaceId, {
        id: `${workspaceId}-message`,
        type: 'text',
        content: 'user message',
        timestamp: '2026-01-01T00:00:00Z',
        meta: { sender: 'user' },
      })
    }
    stubScrollSize = 8500
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'first-user' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const scroll = wrapper.findComponent(QScrollAreaStub).vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    expect(scroll).toHaveBeenLastCalledWith('vertical', 8500, 0)
    const virtual = wrapper.findComponent(QVirtualScrollStub).vm.$.exposed?.scrollTo as ReturnType<typeof vi.fn>
    expect(virtual).toHaveBeenCalledWith(0, 'end-force')
    scroll.mockClear()
    await wrapper.setProps({ workspaceId: 'second-user' })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).toHaveBeenLastCalledWith('vertical', 8500, 0)
    scroll.mockClear()
    await wrapper.setProps({ workspaceId: 'first-user' })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).toHaveBeenLastCalledWith('vertical', 8500, 0)
    wrapper.unmount()
  })

  it('anchors again when a late initial sync replaces an already populated cache', async () => {
    const stream = useAgentStreamStore()
    const websocket = useWebSocketStore()
    stream.reset(
      'late-cache',
      [{ kind: 'message:text', messageId: 'old', text: 'cached', streaming: false }],
      ['2026-01-01T00:00:00Z'],
    )
    websocket.pendingSyncRequests = [['late-cache']]
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'late-cache' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(2000)
    stubScrollSize = 12000
    stream.reset(
      'late-cache',
      [{ kind: 'message:text', messageId: 'new', text: 'latest history', streaming: false }],
      ['2026-01-01T00:00:01Z'],
    )
    websocket.pendingSyncRequests = []
    await vi.advanceTimersByTimeAsync(100)
    const scroll = wrapper.findComponent(QScrollAreaStub).vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    expect(scroll).toHaveBeenLastCalledWith('vertical', 12000, 0)
    wrapper.unmount()
  })

  it('follows delayed measured heights while pinned and preserves an active reading position', async () => {
    useAgentStreamStore().reset(
      'resize',
      [{ kind: 'message:text', messageId: 'm', text: 'cached', streaming: false }],
      ['2026-01-01T00:00:00Z'],
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'resize' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const area = wrapper.findComponent(QScrollAreaStub)
    const scroll = area.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    area.vm.$emit('scroll', { verticalPosition: 600, verticalSize: 1000, verticalContainerSize: 400 })
    await nextTick()
    stubScrollSize = 9000
    area.vm.$emit('scroll', { verticalPosition: 600, verticalSize: 9000, verticalContainerSize: 400 })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).toHaveBeenLastCalledWith('vertical', 9000, 0)
    await area.trigger('wheel')
    area.vm.$emit('scroll', { verticalPosition: 300, verticalSize: 9000, verticalContainerSize: 400 })
    scroll.mockClear()
    stubScrollSize = 10000
    area.vm.$emit('scroll', { verticalPosition: 300, verticalSize: 10000, verticalContainerSize: 400 })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps a history search focused when the virtual list grows after navigation', async () => {
    useAgentStreamStore().reset(
      'search-grow',
      [{ kind: 'message:text', messageId: 'm', text: 'cached', streaming: false }],
      ['2026-01-01T00:00:00Z'],
    )
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'search-grow' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const area = wrapper.findComponent(QScrollAreaStub)
    const scroll = area.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    area.vm.$emit('scroll', { verticalPosition: 600, verticalSize: 1000, verticalContainerSize: 400 })
    scroll.mockClear()
    window.dispatchEvent(
      new CustomEvent('kobo:focus-history-event', {
        detail: { workspaceId: 'search-grow', eventId: 'older-hit' },
      }),
    )
    stubScrollSize = 9000
    area.vm.$emit('scroll', { verticalPosition: 3000, verticalSize: 9000, verticalContainerSize: 400 })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not pull a reader back to the bottom when the initial history finally arrives', async () => {
    const stream = useAgentStreamStore()
    const websocket = useWebSocketStore()
    stream.reset(
      'reading-cache',
      [{ kind: 'message:text', messageId: 'old', text: 'cached', streaming: false }],
      ['2026-01-01T00:00:00Z'],
    )
    websocket.pendingSyncRequests = [['reading-cache']]
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'reading-cache' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const area = wrapper.findComponent(QScrollAreaStub)
    await area.trigger('wheel')
    area.vm.$emit('scroll', { verticalPosition: 300, verticalSize: 1000, verticalContainerSize: 400 })
    const scroll = area.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    scroll.mockClear()
    stubScrollSize = 12000
    useWorkspaceStore().addActivityItem('reading-cache', {
      id: 'old-user-message',
      type: 'text',
      content: 'historical user message',
      timestamp: '2026-01-01T00:00:00Z',
      meta: { sender: 'user' },
    })
    stream.reset(
      'reading-cache',
      [{ kind: 'message:text', messageId: 'new', text: 'latest history', streaming: false }],
      ['2026-01-01T00:00:01Z'],
    )
    websocket.pendingSyncRequests = []
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('releases a stalled targeted session loader and shows a retryable error', async () => {
    vi.useFakeTimers()
    useWorkspaceStore().selectedSessionId = 'stalled'
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'stalled-workspace' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('[data-testid="history-load-error"]').text()).toContain('timed out')
    expect(fetch).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('aborts targeted history reads on navigation and unmount', async () => {
    useWorkspaceStore().selectedSessionId = 'selected'
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'first' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    const firstSignal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal
    await wrapper.setProps({ workspaceId: 'second' })
    expect(firstSignal?.aborted).toBe(true)
    const secondSignal = vi.mocked(fetch).mock.calls[1]?.[1]?.signal
    wrapper.unmount()
    expect(secondSignal?.aborted).toBe(true)
  })

  it('keeps the latest targeted loader owned during rapid workspace reselection', async () => {
    useWorkspaceStore().selectedSessionId = 'selected'
    const finish: Array<(response: Response) => void> = []
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish.push(resolve)
        }),
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'first' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    await wrapper.setProps({ workspaceId: 'second' })
    await wrapper.setProps({ workspaceId: 'first' })
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    finish[0]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    finish[1]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    await flushPromises()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    finish[2]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    await flushPromises()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    wrapper.unmount()
  })

  it('follows a new local user send even when the reader had scrolled up', async () => {
    const store = useWorkspaceStore()
    useAgentStreamStore().reset(
      'local-send',
      [{ kind: 'message:text', messageId: 'm', text: 'cached', streaming: false }],
      ['2026-01-01T00:00:00Z'],
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'local-send' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const area = wrapper.findComponent(QScrollAreaStub)
    await area.trigger('wheel')
    area.vm.$emit('scroll', { verticalPosition: 300, verticalSize: 1000, verticalContainerSize: 400 })
    const scroll = area.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    scroll.mockClear()
    store.addActivityItem('local-send', {
      id: 'new-user-message',
      type: 'text',
      content: 'new local message',
      timestamp: '2026-01-01T00:00:01Z',
      meta: { sender: 'user', pending: true },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(scroll).toHaveBeenLastCalledWith('vertical', 1000, 180)
    wrapper.unmount()
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    stubScrollSize = 1000
    onStubScroll = null
  })

  it('does not start an animated scroll when switching to a workspace with more messages', async () => {
    // Per-workspace counters "grow" on a switch; treating that as a new send
    // started a 180ms animation towards the previous feed's height that
    // Quasar cannot cancel, leaving the new conversation mid-way.
    const store = useWorkspaceStore()
    for (const id of ['u1', 'u2', 'u3']) {
      store.addActivityItem('w-many', {
        id,
        type: 'text',
        content: id,
        timestamp: '2026-01-01T00:00:00Z',
        meta: { sender: 'user' },
      })
    }
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'w-few' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)
    const setScrollPosition = wrapper.findComponent(QScrollAreaStub).vm.$.exposed?.setScrollPosition as ReturnType<
      typeof vi.fn
    >
    setScrollPosition.mockClear()
    await wrapper.setProps({ workspaceId: 'w-many' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setScrollPosition.mock.calls.filter(([, , duration]) => duration !== 0)).toEqual([])
    wrapper.unmount()
  })

  it('stops re-anchoring as soon as the user scrolls during the initial settling', async () => {
    onStubScroll = () => {
      stubScrollSize += 500 // Never stabilises on its own.
    }
    useAgentStreamStore().reset(
      'w-user',
      [{ kind: 'message:text', messageId: 'm1', text: 'hello', streaming: false }],
      ['2026-01-01T00:00:00Z'],
      { sessionIds: [null] },
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'w-user' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(50)
    const area = wrapper.findComponent(QScrollAreaStub)
    const setScrollPosition = area.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    await area.trigger('wheel')
    const callsAtWheel = setScrollPosition.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setScrollPosition.mock.calls.length).toBeLessThanOrEqual(callsAtWheel + 1)
    wrapper.unmount()
  })

  it('keeps anchoring to the bottom while the opened conversation grows after the first jump', async () => {
    // Virtual scroll estimates unrendered turns at 160px: jumping to the end
    // renders the last turns, their real height grows the content, and a
    // single retry left the feed in the middle of the conversation.
    const sizes = [2500, 4000]
    onStubScroll = () => {
      const next = sizes.shift()
      if (next !== undefined) stubScrollSize = next
    }
    useAgentStreamStore().reset(
      'w-grow',
      [{ kind: 'message:text', messageId: 'm1', text: 'hello', streaming: false }],
      ['2026-01-01T00:00:00Z'],
      { sessionIds: [null] },
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'w-grow' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(2_000)
    const setScrollPosition = wrapper.findComponent(QScrollAreaStub).vm.$.exposed?.setScrollPosition as ReturnType<
      typeof vi.fn
    >
    expect(setScrollPosition).toHaveBeenLastCalledWith('vertical', 4000, 0)
    wrapper.unmount()
  })

  it('shows an idle empty conversation immediately without a grace-period timer', async () => {
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'empty' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('.activity-feed-empty').exists()).toBe(true)
    wrapper.unmount()
  })

  it('waits for the actual sync response, even when slow or empty', async () => {
    const websocket = useWebSocketStore()
    websocket.pendingSyncRequests = [['empty']]
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'empty' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    websocket._routeMessage({ type: 'sync:response', payload: { events: [], mode: 'snapshot' } })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('.activity-feed-empty').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders cached conversations immediately when switching workspaces', async () => {
    const stream = useAgentStreamStore()
    const store = useWorkspaceStore()
    for (const id of ['first', 'second']) {
      stream.reset(id, [{ kind: 'message:text', messageId: id, text: id, streaming: false }], ['2026-01-01T00:00:00Z'])
      // Workspace navigation still refreshes its session list in the background.
      store.loadingSessions[id] = true
    }
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'first' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('.turn-card-stub').exists()).toBe(true)
    await wrapper.setProps({ workspaceId: 'second' })
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('.turn-card-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it.each(['agent', 'user'])(
    'preserves the %s conversation DOM and reading position during a session-list refresh',
    async (sender) => {
      const store = useWorkspaceStore()
      const stream = useAgentStreamStore()
      store.selectedWorkspaceId = 'w1'
      store.selectedSessionId = 'current'
      const session = {
        id: 'current',
        workspaceId: 'w1',
        pid: null,
        engineSessionId: null,
        status: 'completed' as const,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        name: null,
      }
      store.sessions = [session]
      if (sender === 'agent') {
        stream.reset(
          'w1',
          [{ kind: 'message:text', messageId: 'm1', text: 'cached', streaming: false }],
          ['2026-01-01T00:00:00Z'],
          { sessionIds: ['current'] },
        )
      } else {
        store.addActivityItem('w1', {
          id: 'user1',
          type: 'text',
          content: 'cached',
          timestamp: '2026-01-01T00:00:00Z',
          sessionId: 'current',
          meta: { sender: 'user' },
        })
      }
      let finish!: (response: Response) => void
      vi.mocked(fetch).mockImplementation((url) =>
        String(url).endsWith('/sessions')
          ? new Promise<Response>((resolve) => {
              finish = resolve
            })
          : Promise.resolve({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response),
      )
      const wrapper = mount(ActivityFeed, {
        props: { workspaceId: 'w1' },
        global: { plugins: [i18n], stubs: globalStubs },
      })
      await vi.advanceTimersByTimeAsync(100)
      const originalArea = wrapper.findComponent(QScrollAreaStub).element
      const originalTurn = wrapper.find('.turn-card-stub').element
      const scroll = wrapper.findComponent(QScrollAreaStub)
      const setScrollPosition = scroll.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
      setScrollPosition.mockClear()
      // The user is reading in the middle; no initial scroll or pagination is pending.
      originalArea.scrollTop = 300
      scroll.vm.$emit('scroll', { verticalPosition: 300, verticalSize: 1000, verticalContainerSize: 400 })

      const pending = store.fetchSessions('w1')
      await nextTick()
      expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
      expect(wrapper.findComponent(QScrollAreaStub).element).toBe(originalArea)
      expect(wrapper.find('.turn-card-stub').element).toBe(originalTurn)

      finish({ ok: true, json: async () => [session] } as Response)
      await pending
      await vi.advanceTimersByTimeAsync(100)
      expect(wrapper.findComponent(QScrollAreaStub).element).toBe(originalArea)
      expect(wrapper.find('.turn-card-stub').element).toBe(originalTurn)
      expect(originalArea.scrollTop).toBe(300)
      expect(setScrollPosition).not.toHaveBeenCalled()
      wrapper.unmount()
    },
  )

  it('keeps a user-only conversation visible while sync and targeted history are pending', async () => {
    const store = useWorkspaceStore()
    store.selectedSessionId = 'current'
    store.addActivityItem('w1', {
      id: 'user1',
      type: 'text',
      content: 'already visible',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'current',
      meta: { sender: 'user' },
    })
    useWebSocketStore().pendingSyncRequests = [['w1']]
    let finish!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'w1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(wrapper.find('.turn-card-stub').exists()).toBe(true)
    finish({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    await nextTick()
    wrapper.unmount()
  })

  it('keeps the spinner until session discovery finishes', async () => {
    const store = useWorkspaceStore()
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const pending = store.fetchSessions('empty')
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'empty' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    resolve({ ok: true, json: async () => [] } as Response)
    await pending
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each([true, false])('ends a targeted session loader on response without a minimum delay (ok=%s)', async (ok) => {
    const store = useWorkspaceStore()
    store.selectedSessionId = 'session'
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'empty' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    resolve({ ok, json: async () => ({ events: [], hasMore: false }) } as Response)
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not let the previous workspace response end the new workspace loader', async () => {
    const store = useWorkspaceStore()
    store.selectedSessionId = 'session'
    const resolve: Array<(response: Response) => void> = []
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((done) => {
          resolve.push(done)
        }),
    )
    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'first' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await wrapper.setProps({ workspaceId: 'second' })
    expect(fetch).toHaveBeenCalledTimes(2)
    resolve[0]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    resolve[1]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(false)
    wrapper.unmount()
  })

  it('loads older history with the selected session in the query string', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()

    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = 'sess-1'
    workspaceStore.sessions = [
      {
        id: 'sess-1',
        workspaceId: 'ws-1',
        pid: null,
        engineSessionId: null,
        status: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        name: null,
      },
    ]
    workspaceStore.workspaces = [
      {
        id: 'ws-1',
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        status: 'idle',
        notionUrl: null,
        sentryUrl: null,
        notionPageId: null,
        model: 'claude-opus-4-5',
        engine: 'claude-code',
        reasoningEffort: 'normal',
        agentPermissionMode: 'bypass',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        prWatchDisabledAt: null,
        tags: [],
        description: null,
        agentDescription: null,
        initialPrompt: null,
        prChangesDismissedAt: null,
        prCiFailureDismissedAt: null,
        worktreePurgedAt: null,
        worktreePurgeRestoreData: null,
        comparisonId: null,
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
        worktreePath: '/tmp/project/.worktrees/feature/test',
        worktreeOwned: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    streamStore.reset(
      'ws-1',
      [{ kind: 'message:text', messageId: 'm1', text: 'hello', streaming: false }],
      ['2026-01-01T00:00:01Z'],
      {
        oldestId: 'cursor-1',
        hasMoreOlder: true,
        sessionIds: ['sess-1'],
        eventIds: ['cursor-1'],
      },
    )

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ events: [], hasMore: false }),
    } as Response)

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })

    await vi.advanceTimersByTimeAsync(250)
    await nextTick()

    const scroll = wrapper.findComponent({ name: 'QScrollArea' })
    scroll.vm.$emit('scroll', {
      verticalPosition: 0,
      verticalSize: 1000,
      verticalContainerSize: 400,
    })

    await nextTick()

    expect(fetch).toHaveBeenCalledWith('/api/workspaces/ws-1/events?before=cursor-1&limit=200&session=sess-1', {
      signal: expect.any(AbortSignal),
    })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.q-spinner').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the reading position when older events are prepended to an already hydrated stream', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()
    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = null
    streamStore.reset(
      'ws-1',
      [{ kind: 'message:text', messageId: 'current', text: 'current', streaming: false }],
      ['2026-01-01T00:00:02Z'],
      { oldestId: 'cursor-2', hasMoreOlder: true, sessionIds: [null], eventIds: ['cursor-2'] },
    )
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          {
            id: 'cursor-1',
            workspaceId: 'ws-1',
            type: 'agent:event',
            payload: { kind: 'message:text', messageId: 'older', text: 'older', streaming: false },
            sessionId: null,
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        hasMore: false,
      }),
    } as Response)

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    const scroll = wrapper.findComponent({ name: 'QScrollArea' })
    const setScrollPosition = scroll.vm.$.exposed?.setScrollPosition as ReturnType<typeof vi.fn>
    setScrollPosition.mockClear()

    scroll.vm.$emit('scroll', { verticalPosition: 0, verticalSize: 1000, verticalContainerSize: 400 })
    await nextTick()
    await vi.advanceTimersByTimeAsync(700)
    await nextTick()

    expect(streamStore.eventIdsFor('ws-1')).toEqual(['cursor-1', 'cursor-2'])
    expect(setScrollPosition).not.toHaveBeenCalledWith('vertical', 1000, expect.any(Number))
  })

  it('hydrates a selected session with workspace-level user messages from the fetch response', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()

    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = 'sess-1'
    workspaceStore.sessions = [
      {
        id: 'sess-1',
        workspaceId: 'ws-1',
        pid: null,
        engineSessionId: null,
        status: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        name: null,
      },
    ]
    workspaceStore.workspaces = [
      {
        id: 'ws-1',
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        status: 'idle',
        notionUrl: null,
        sentryUrl: null,
        notionPageId: null,
        model: 'claude-opus-4-5',
        engine: 'claude-code',
        reasoningEffort: 'normal',
        agentPermissionMode: 'bypass',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        prWatchDisabledAt: null,
        tags: [],
        description: null,
        agentDescription: null,
        initialPrompt: null,
        prChangesDismissedAt: null,
        prCiFailureDismissedAt: null,
        worktreePurgedAt: null,
        worktreePurgeRestoreData: null,
        comparisonId: null,
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
        worktreePath: '/tmp/project/.worktrees/feature/test',
        worktreeOwned: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    streamStore.reset('ws-1', [], [], {
      oldestId: undefined,
      hasMoreOlder: true,
      sessionIds: [],
      eventIds: [],
    })

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          {
            id: 'evt-ws-user',
            workspaceId: 'ws-1',
            type: 'user:message',
            payload: { content: 'workspace note', sender: 'user' },
            sessionId: null,
            createdAt: '2026-01-01T00:00:01Z',
          },
          {
            id: 'evt-s1',
            workspaceId: 'ws-1',
            type: 'agent:event',
            payload: { kind: 'message:text', messageId: 'm-1', text: 'hello', streaming: false },
            sessionId: 'sess-1',
            createdAt: '2026-01-01T00:00:02Z',
          },
        ],
        hasMore: false,
      }),
    } as Response)

    mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })

    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    await nextTick()

    expect(fetch).toHaveBeenCalledWith('/api/workspaces/ws-1/events?session=sess-1&limit=500', {
      signal: expect.any(AbortSignal),
    })
    expect(workspaceStore.activityFeeds['ws-1']?.map((i) => [i.id, i.sessionId ?? null])).toContainEqual([
      'evt-ws-user',
      null,
    ])
    expect(streamStore.sessionIdsFor('ws-1')).toEqual(['sess-1'])
  })

  it('ignores a second jump-to-previous click while the first is still walking back', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()
    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = null
    streamStore.reset(
      'ws-1',
      [{ kind: 'message:text', messageId: 'm', text: 'only agent output', streaming: false }],
      ['2026-01-01T00:00:02Z'],
      { oldestId: 'cursor-1', hasMoreOlder: true, sessionIds: [null], eventIds: ['cursor-1'] },
    )

    // Every older page comes back empty: the walk keeps asking until the cap.
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ events: [], hasMore: true }),
    } as Response)

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    vi.mocked(fetch).mockClear()

    const buttons = wrapper.findAll('button')
    const upButton = buttons[buttons.length - 1]

    // Two clicks in a row, before the first walk had any chance to finish.
    const firstClick = upButton.trigger('click')
    const secondClick = upButton.trigger('click')
    await Promise.all([firstClick, secondClick])
    await vi.advanceTimersByTimeAsync(5000)
    await nextTick()

    const callsFromOneWalk = vi.mocked(fetch).mock.calls.length
    // A single walk is capped at MAX_ATTEMPTS = 15 pages. Two concurrent walks
    // would have produced more.
    expect(callsFromOneWalk).toBeLessThanOrEqual(15)
  })

  it('announces settled messages and tool calls in a dedicated live region', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()
    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = null
    // Busy status keeps the fold from force-closing the streaming text item
    // (closeStaleStreamingText only fires when the session isn't active) —
    // without it the "must not announce partial fragments" case below would
    // be vacuously true because the fragment gets closed immediately.
    workspaceStore.workspaces = [
      {
        id: 'ws-1',
        name: 'Test',
        projectPath: '/tmp/project',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
        status: 'executing',
        notionUrl: null,
        sentryUrl: null,
        notionPageId: null,
        model: 'claude-opus-4-5',
        engine: 'claude-code',
        reasoningEffort: 'normal',
        agentPermissionMode: 'bypass',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        prWatchDisabledAt: null,
        tags: [],
        description: null,
        agentDescription: null,
        initialPrompt: null,
        prChangesDismissedAt: null,
        prCiFailureDismissedAt: null,
        worktreePurgedAt: null,
        worktreePurgeRestoreData: null,
        comparisonId: null,
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
        worktreePath: '/tmp/project/.worktrees/feature/test',
        worktreeOwned: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    streamStore.reset(
      'ws-1',
      // A streaming fragment must NOT be announced: Codex emits 50-200 of
      // them per message and each one would be read out.
      [{ kind: 'message:text', messageId: 'm1', text: 'partial', streaming: true }],
      ['2026-01-01T00:00:01Z'],
      { hasMoreOlder: false, sessionIds: [null], eventIds: ['e1'] },
    )

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()

    const region = wrapper.find('[data-testid="activity-live-region"]')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-live')).toBe('polite')
    expect(region.attributes('role')).toBe('log')
    expect(region.text()).toBe('')

    // The store has no batched `append`; replay the accumulated stream via
    // `reset` instead — behaviourally identical for the fold.
    streamStore.reset(
      'ws-1',
      [{ kind: 'message:text', messageId: 'm1', text: 'partial then done', streaming: false }],
      ['2026-01-01T00:00:02Z'],
      { hasMoreOlder: false, sessionIds: [null], eventIds: ['e2'] },
    )
    await nextTick()
    expect(wrapper.find('[data-testid="activity-live-region"]').text()).toContain('partial then done')

    streamStore.reset(
      'ws-1',
      [
        { kind: 'message:text', messageId: 'm1', text: 'partial then done', streaming: false },
        { kind: 'tool:call', messageId: 'm1', toolCallId: 't1', name: 'Bash', input: {} },
      ],
      ['2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z'],
      { hasMoreOlder: false, sessionIds: [null, null], eventIds: ['e2', 'e3'] },
    )
    await nextTick()
    expect(wrapper.find('[data-testid="activity-live-region"]').text()).toContain('Bash')
  })

  it('renders its turns through the virtual list', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()
    workspaceStore.selectedWorkspaceId = 'ws-1'
    workspaceStore.selectedSessionId = null
    streamStore.reset(
      'ws-1',
      [
        { kind: 'message:text', messageId: 'm1', text: 'one', streaming: false },
        { kind: 'message:text', messageId: 'm2', text: 'two', streaming: false },
      ],
      ['2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z'],
      { oldestId: 'c1', hasMoreOlder: false, sessionIds: [null, null], eventIds: ['c1', 'c2'] },
    )
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'ws-1' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()

    expect(wrapper.find('.q-virtual-scroll-stub').exists()).toBe(true)
    expect(wrapper.findAll('.turn-card-stub').length).toBeGreaterThan(0)
  })

  it('keeps the latest user message visible after it scrolls above the feed', async () => {
    const workspaceStore = useWorkspaceStore()
    const streamStore = useAgentStreamStore()
    workspaceStore.addActivityItem('sticky-user-message', {
      id: 'prompt-0',
      type: 'text',
      content: 'Ancien message utilisateur',
      timestamp: '2025-12-31T23:59:59Z',
      meta: { sender: 'user' },
    })
    workspaceStore.addActivityItem('sticky-user-message', {
      id: 'prompt-1',
      type: 'text',
      content: 'Relance la vérification de la migration',
      timestamp: '2026-01-01T00:00:00Z',
      meta: { sender: 'user' },
    })
    streamStore.reset(
      'sticky-user-message',
      [
        { kind: 'message:text', messageId: 'answer-0', text: 'Ancienne réponse.', streaming: false },
        { kind: 'message:text', messageId: 'answer-1', text: 'Je vérifie.', streaming: false },
      ],
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z'],
      { hasMoreOlder: false, sessionIds: [null, null], eventIds: ['answer-event-0', 'answer-event-1'] },
    )

    const wrapper = mount(ActivityFeed, {
      props: { workspaceId: 'sticky-user-message' },
      global: { plugins: [i18n], stubs: globalStubs },
    })
    await vi.advanceTimersByTimeAsync(100)

    const virtual = wrapper.findComponent(QVirtualScrollStub)
    virtual.vm.$emit('virtual-scroll', { index: 3 })
    await nextTick()
    const stickyMessage = wrapper.find('[data-testid="latest-user-message"]').text()
    expect(stickyMessage).toContain('Relance la vérification de la migration')
    expect(stickyMessage).not.toContain('Ancien message utilisateur')

    const scrollTarget = wrapper.find('.q-scroll-area-stub').element
    const latestUserCard = wrapper.find('[data-turn-index="2"]').element
    Object.defineProperty(scrollTarget, 'getBoundingClientRect', {
      value: () => ({ top: 0, bottom: 400 }),
    })
    Object.defineProperty(latestUserCard, 'getBoundingClientRect', {
      value: () => ({ top: 100, bottom: 180 }),
    })
    wrapper.findComponent(QScrollAreaStub).vm.$emit('scroll', {
      verticalPosition: 500,
      verticalSize: 1000,
      verticalContainerSize: 400,
    })
    await vi.advanceTimersByTimeAsync(20)
    await nextTick()
    expect(wrapper.find('[data-testid="latest-user-message"]').exists()).toBe(false)

    virtual.vm.$emit('virtual-scroll', { index: 0 })
    await nextTick()
    expect(wrapper.find('[data-testid="latest-user-message"]').exists()).toBe(false)
  })
})
