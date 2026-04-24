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
      setScrollPosition: vi.fn(),
      emitScroll: (info: { verticalPosition: number; verticalSize: number; verticalContainerSize: number }) =>
        emit('scroll', info),
    }
    expose(api)
    return () => h('div', { class: 'q-scroll-area-stub' }, slots.default?.())
  },
})

const globalStubs = {
  TurnCard: { template: '<div class="turn-card-stub"></div>' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-spinner': { template: '<span class="q-spinner"></span>' },
  'q-spinner-dots': { template: '<span class="q-spinner-dots"></span>' },
  'q-expansion-item': { template: '<div><slot /></div>' },
  'q-scroll-area': QScrollAreaStub,
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
        notionPageId: null,
        model: 'claude-opus-4-5',
        reasoningEffort: 'normal',
        permissionMode: 'auto-accept',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        tags: [],
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
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
        notionPageId: null,
        model: 'claude-opus-4-5',
        reasoningEffort: 'normal',
        permissionMode: 'auto-accept',
        devServerStatus: 'stopped',
        hasUnread: false,
        archivedAt: null,
        favoritedAt: null,
        tags: [],
        autoLoop: false,
        autoLoopReady: false,
        noProgressStreak: 0,
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
})
