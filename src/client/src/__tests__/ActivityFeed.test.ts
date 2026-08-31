import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ActivityFeed from '../components/ActivityFeed.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
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
