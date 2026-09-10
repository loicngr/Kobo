import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ActivityFeed from '../components/ActivityFeed.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const QScrollAreaStub = defineComponent({
  name: 'QScrollArea',
  emits: ['scroll'],
  setup(_props, { slots, emit, expose }) {
    const api = {
      getScroll: () => ({
        verticalSize: 1000,
        verticalPosition: 0,
        verticalContainerSize: 400,
      }),
      getScrollTarget: () => document.createElement('div'),
      setScrollPosition: vi.fn(),
      emitScroll: (info: { verticalPosition: number; verticalSize: number; verticalContainerSize: number }) =>
        emit('scroll', info),
    }
    expose(api)
    return () => h('div', { class: 'q-scroll-area-stub' }, slots.default?.())
  },
})

const QVirtualScrollStub = defineComponent({
  name: 'QVirtualScroll',
  props: { items: { type: Array, default: () => [] } },
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
  'q-expansion-item': { template: '<div><slot /></div>' },
  'q-scroll-area': QScrollAreaStub,
  'q-virtual-scroll': QVirtualScrollStub,
}

describe('ActivityFeed.vue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
    for (let i = 0; i < 5; i++) await nextTick()
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
    for (let i = 0; i < 5; i++) await nextTick()
    expect(wrapper.find('.activity-feed-switching').exists()).toBe(true)
    resolve[1]({ ok: true, json: async () => ({ events: [], hasMore: false }) } as Response)
    for (let i = 0; i < 5; i++) await nextTick()
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

    expect(fetch).toHaveBeenCalledWith('/api/workspaces/ws-1/events?before=cursor-1&limit=200&session=sess-1')
    for (let i = 0; i < 8; i++) await nextTick()
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

    expect(fetch).toHaveBeenCalledWith('/api/workspaces/ws-1/events?session=sess-1&limit=500')
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
})
