import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import ChatInput from '../components/ChatInput.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

const device = vi.hoisted(() => ({ narrow: false, mobile: false }))
vi.mock('quasar', async () => ({
  ...(await vi.importActual('quasar')),
  useQuasar: () => ({
    screen: { lt: { sm: device.narrow, md: device.narrow } },
    platform: { is: { mobile: device.mobile } },
    notify: vi.fn(),
  }),
}))
const wrappers: VueWrapper[] = []
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  device.narrow = false
  device.mobile = false
  setActivePinia(createPinia())
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/attachments'))
      return Response.json({
        uid: '0123456789',
        kind: 'file',
        path: '.ai/attachments/0123456789.md',
        reference: 'Attached document "brief.md": [file: .ai/attachments/0123456789.md]',
      })
    if (url === '/api/skills') return Response.json([])
    if (url.endsWith('/auto-loop/messages')) return Response.json([])
    if (options?.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ history: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  await flushPromises()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function setup(status: Workspace['status'] = 'idle') {
  const store = useWorkspaceStore()
  store.workspaces = [
    {
      id: 'a',
      name: 'A',
      status,
      engine: 'claude-code',
      tags: [],
      worktreePath: '/tmp/a',
      projectPath: '/',
      sourceBranch: 'main',
      workingBranch: 'b',
      notionUrl: null,
      sentryUrl: null,
      notionPageId: null,
      model: 'auto',
      reasoningEffort: 'medium',
      agentPermissionMode: 'bypass',
      devServerStatus: 'idle',
      hasUnread: false,
      archivedAt: null,
      favoritedAt: null,
      prWatchDisabledAt: null,
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
      worktreeOwned: true,
      createdAt: '',
      updatedAt: '',
    },
  ]
  store.selectedWorkspaceId = 'a'
  store.selectedSessionId = 'session'
  store.sessions = [{ id: 'session', workspaceId: 'a', status: 'idle', engineSessionId: null } as never]
  vi.spyOn(store, 'startWorkspace').mockResolvedValue(undefined as never)
  vi.spyOn(store, 'fetchSessions').mockResolvedValue(undefined)
  const input = defineComponent({
    props: ['modelValue', 'disable', 'readonly'],
    emits: ['update:modelValue'],
    setup(_, { expose }) {
      const el = ref<HTMLTextAreaElement>()
      expose({ getNativeElement: () => el.value })
      return { el }
    },
    template:
      '<textarea ref="el" :value="modelValue" :disabled="disable" :readonly="readonly" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  })
  const wrapper = mount(ChatInput, {
    props: { workspaceId: 'a' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QInput: input,
        QBtn: defineComponent({
          props: ['disable', 'icon'],
          template: '<button :disabled="disable" :data-icon="icon"><slot /></button>',
        }),
        QTooltip: true,
        QIcon: true,
        QSpinnerDots: true,
        QItemSection: true,
        QItem: true,
        QList: true,
        QMenu: true,
        QSpace: true,
        QuotaFooter: true,
        SlashSuggestionsPopup: true,
      },
      directives: { ripple: () => {} },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { store, wrapper }
}

it.each([
  { name: 'desktop', narrow: false, mobile: false, autoFocus: true },
  { name: 'phone portrait', narrow: true, mobile: true, autoFocus: false },
  { name: 'phone landscape', narrow: false, mobile: true, autoFocus: false },
])('only focuses automatically on desktop ($name)', async ({ narrow, mobile, autoFocus }) => {
  device.narrow = narrow
  device.mobile = mobile
  const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
  const { wrapper } = await setup()
  expect(focus).toHaveBeenCalledTimes(autoFocus ? 1 : 0)
  focus.mockClear()
  await wrapper.setProps({ workspaceId: 'b' })
  await flushPromises()
  expect(focus).toHaveBeenCalledTimes(autoFocus ? 1 : 0)
  focus.mockClear()
  ;(wrapper.vm as unknown as { focus: () => void }).focus()
  expect(focus).toHaveBeenCalledOnce()
})

async function attach(wrapper: VueWrapper) {
  await wrapper.trigger('drop', { dataTransfer: { files: [new File(['# Brief'], 'brief.md')] } })
  await flushPromises()
  expect(wrapper.get('textarea').element.value).toContain('[file: .ai/attachments/0123456789.md]')
}
const deletes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE')

it('sends a document from the chat without deleting it when the draft clears', async () => {
  const { store, wrapper } = await setup()
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(store.startWorkspace).toHaveBeenCalledWith(
    'a',
    expect.stringContaining('[file: .ai/attachments/0123456789.md]'),
    'session',
  )
  expect(wrapper.get('textarea').element.value).toBe('')
  expect(deletes()).toEqual([])
})

it('restores the attachment after a rejected chat send so it can be removed or retried', async () => {
  const { store, wrapper } = await setup()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(store.startWorkspace).mockRejectedValueOnce(new Error('offline'))
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('textarea').element.value).toContain('[file:')
  expect(wrapper.findAll('.attachment-tag')).toHaveLength(1)
  expect(deletes()).toEqual([])
  await wrapper.get('button[aria-label="Remove attachment"]').trigger('click')
  expect(deletes()).toHaveLength(1)
})

it('preserves queued documents when switching to another workspace', async () => {
  const { store, wrapper } = await setup('executing')
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  expect(store.getQueuedMessage('a', 'session')?.content).toContain('[file:')
  await wrapper.setProps({ workspaceId: 'b' })
  await flushPromises()
  expect(deletes()).toEqual([])
})

it('keeps documents while automatically creating a replacement session', async () => {
  const { store, wrapper } = await setup()
  store.sessions[0]!.status = 'completed'
  vi.spyOn(store, 'createSession').mockImplementation(async () => {
    const session = { id: 'new', status: 'idle', workspaceId: 'a' } as never
    store.selectedSessionId = 'new'
    return session
  })
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(store.startWorkspace).toHaveBeenCalledWith('a', expect.stringContaining('[file:'), 'new')
  expect(deletes()).toEqual([])
})

it.each([false, true])(
  'keeps auto-loop attachments when a new iteration is selected before the HTTP receipt (ready=%s)',
  async (ready) => {
    const { store, wrapper } = await setup('executing')
    store.autoLoopStates.a = {
      auto_loop: true,
      auto_loop_ready: ready,
      no_progress_streak: 0,
      tasks_done: 0,
      tasks_total: 1,
      crons_count: 0,
    }
    const sendImmediate = vi.spyOn(useWebSocketStore(), 'sendChatMessage')
    let acknowledge!: () => void
    const receipt = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    const queued = vi.spyOn(store, 'queueAutoLoopMessage').mockImplementation(async () => {
      store.selectedSessionId = 'next-iteration'
      await receipt
    })
    await attach(wrapper)
    try {
      await wrapper.get('button[data-icon="send"]').trigger('click')
      await flushPromises()
      expect(queued).toHaveBeenCalledWith('a', expect.stringContaining('[file: .ai/attachments/0123456789.md]'))
      expect(store.startWorkspace).not.toHaveBeenCalled()
      expect(sendImmediate).not.toHaveBeenCalled()
      expect(deletes()).toEqual([])
    } finally {
      acknowledge()
      await flushPromises()
    }
  },
)

it('preserves the draft and document badge when auto-loop queue submission fails', async () => {
  const { store, wrapper } = await setup('executing')
  store.autoLoopStates.a = {
    auto_loop: true,
    auto_loop_ready: true,
    no_progress_streak: 0,
    tasks_done: 0,
    tasks_total: 1,
    crons_count: 0,
  }
  vi.spyOn(store, 'queueAutoLoopMessage').mockRejectedValue(new Error('offline'))
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('textarea').element.value).toContain('[file: .ai/attachments/0123456789.md]')
  expect(wrapper.findAll('.attachment-tag')).toHaveLength(1)
  expect(deletes()).toEqual([])
})

it('queues from workspace metadata while the initial auto-loop snapshot is still loading', async () => {
  const { store, wrapper } = await setup()
  store.workspaces[0]!.autoLoop = true
  const queued = vi.spyOn(store, 'queueAutoLoopMessage').mockResolvedValue()
  const sendImmediate = vi.spyOn(useWebSocketStore(), 'sendChatMessage')
  await wrapper.get('textarea').setValue('Next iteration instruction')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(queued).toHaveBeenCalledWith('a', 'Next iteration instruction')
  expect(store.startWorkspace).not.toHaveBeenCalled()
  expect(sendImmediate).not.toHaveBeenCalled()
})

it('records accepted queued instructions in their original workspace history after navigation', async () => {
  const { store, wrapper } = await setup('executing')
  store.autoLoopStates.a = {
    auto_loop: true,
    auto_loop_ready: true,
    no_progress_streak: 0,
    tasks_done: 0,
    tasks_total: 1,
    crons_count: 0,
  }
  let acknowledge!: () => void
  vi.spyOn(store, 'queueAutoLoopMessage').mockReturnValue(
    new Promise<void>((resolve) => {
      acknowledge = resolve
    }),
  )
  await wrapper.get('textarea').setValue('Original workspace instruction')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await wrapper.setProps({ workspaceId: 'b' })
  acknowledge()
  await flushPromises()
  const historyPosts = fetchMock.mock.calls.filter(
    ([url, options]) => url.endsWith('/chat-history') && options?.method === 'POST',
  )
  expect(historyPosts).toHaveLength(1)
  expect(historyPosts[0]![0]).toBe('/api/workspaces/a/chat-history')
})

it.each(['claude-code', 'codex'] as const)(
  'forces immediate busy messages with attachments for %s when enabled',
  async (engine) => {
    const { store, wrapper } = await setup('executing')
    store.workspaces[0]!.engine = engine
    store.sessions[0]!.status = 'running'
    useSettingsStore().global.forceImmediateMessages = true
    const ws = useWebSocketStore()
    vi.spyOn(ws, 'isConnected').mockReturnValue(true)
    const send = vi.spyOn(ws, 'sendChatMessageConfirmed').mockResolvedValue()
    await attach(wrapper)
    await wrapper.get('button[data-icon="send"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('a', expect.stringContaining('[file:'), 'session', true)
    expect(store.getQueuedMessage('a', 'session')).toBeFalsy()
    expect(wrapper.get('textarea').element.value).toBe('')
    expect(deletes()).toEqual([])
  },
)
it('restores the draft when an immediate send cannot reach the server', async () => {
  const { store, wrapper } = await setup('executing')
  store.sessions[0]!.status = 'running'
  useSettingsStore().global.forceImmediateMessages = true
  const ws = useWebSocketStore()
  vi.spyOn(ws, 'isConnected').mockReturnValue(true)
  vi.spyOn(ws, 'sendChatMessageConfirmed').mockRejectedValue(new Error('offline'))
  await attach(wrapper)
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('textarea').element.value).toContain('[file:')
  expect(store.getQueuedMessage('a', 'session')).toBeFalsy()
  expect(deletes()).toEqual([])
})
it('uses immediate delivery instead of scheduling an auto-loop instruction when enabled', async () => {
  const { store, wrapper } = await setup('executing')
  store.sessions[0]!.status = 'running'
  store.workspaces[0]!.autoLoop = true
  useSettingsStore().global.forceImmediateMessages = true
  const ws = useWebSocketStore()
  vi.spyOn(ws, 'isConnected').mockReturnValue(true)
  const send = vi.spyOn(ws, 'sendChatMessageConfirmed').mockResolvedValue()
  const queued = vi.spyOn(store, 'queueAutoLoopMessage').mockResolvedValue()
  await wrapper.get('textarea').setValue('Do this now')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(queued).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledWith('a', 'Do this now', 'session', true)
})
it.each(['compacting', 'awaiting-user'] as const)(
  'keeps %s protection with immediate delivery enabled',
  async (status) => {
    const { wrapper } = await setup(status)
    useSettingsStore().global.forceImmediateMessages = true
    const send = vi.spyOn(useWebSocketStore(), 'sendChatMessageConfirmed').mockResolvedValue()
    await wrapper.get('textarea').setValue('Wait safely')
    await wrapper.get('button[data-icon="send"]').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
    expect(wrapper.get('textarea').element.value).toBe('Wait safely')
  },
)

it.each(['ordinary message', '/kobo-check-progress'])(
  'does not queue rejected idle-session messages in immediate mode: %s',
  async (content) => {
    const { store, wrapper } = await setup('idle')
    store.sessions[0]!.status = 'running'
    useSettingsStore().global.forceImmediateMessages = true
    const ws = useWebSocketStore()
    vi.spyOn(ws, 'isConnected').mockReturnValue(true)
    const confirmed = vi.spyOn(ws, 'sendChatMessageConfirmed').mockRejectedValue(new Error('Pending permission'))
    const unconfirmed = vi.spyOn(ws, 'sendChatMessage').mockReturnValue(true)
    await wrapper.get('textarea').setValue(content)
    await wrapper.get('button[data-icon="send"]').trigger('click')
    await flushPromises()
    expect(confirmed).toHaveBeenCalled()
    expect(unconfirmed).not.toHaveBeenCalled()
    expect(store.getQueuedMessage('a', 'session')).toBeFalsy()
    expect(wrapper.get('textarea').element.value).toBe(content)
  },
)

it('retains a busy Vibe draft on refused immediate delivery without queueing or resending', async () => {
  const { store, wrapper } = await setup('executing')
  store.workspaces[0]!.engine = 'mistral-vibe'
  store.sessions[0]!.status = 'running'
  useSettingsStore().global.forceImmediateMessages = true
  const ws = useWebSocketStore()
  vi.spyOn(ws, 'isConnected').mockReturnValue(true)
  const send = vi.spyOn(ws, 'sendChatMessageConfirmed').mockRejectedValue(new Error('Live steering unsupported'))
  const queue = vi.spyOn(store, 'queueMessage')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await wrapper.get('textarea').setValue('Keep this draft')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(send).toHaveBeenCalledTimes(1)
  expect(queue).not.toHaveBeenCalled()
  expect(wrapper.get('textarea').element.value).toBe('Keep this draft')
  useSettingsStore().global.forceImmediateMessages = false
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(queue).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
})

it('sends reviewer messages to the exact session without auto-loop queueing or resuming the principal', async () => {
  const { useParallelReviewStore } = await import('../stores/parallel-review')
  const { store, wrapper } = await setup('compacting')
  store.sessions[0]!.role = 'parallel-review'
  store.sessions[0]!.status = 'running'
  store.workspaces[0]!.autoLoop = true
  useParallelReviewStore().setStatus('a', {
    reviewSessionId: 'session',
    originalSessionId: 'main',
    phase: 'reviewing',
    compacting: false,
    returnToSession: false,
    error: null,
  })
  vi.spyOn(useWebSocketStore(), 'isConnected').mockReturnValue(true)
  const send = vi.spyOn(useWebSocketStore(), 'sendChatMessageConfirmed').mockResolvedValue()
  const queue = vi.spyOn(store, 'queueAutoLoopMessage')
  await wrapper.get('textarea').setValue('Check the migration')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(send).toHaveBeenCalledWith('a', 'Check the migration', 'session', true)
  expect(queue).not.toHaveBeenCalled()
  expect(store.startWorkspace).not.toHaveBeenCalled()
  expect(store.queuedMessages).toEqual({})
  expect(store.workspaces[0]!.status).toBe('compacting')
})

it('keeps a closed reviewer read-only without any fallback start or auto-loop instruction', async () => {
  const { useParallelReviewStore } = await import('../stores/parallel-review')
  const { store, wrapper } = await setup('executing')
  store.sessions[0]!.role = 'parallel-review'
  store.sessions[0]!.status = 'completed'
  useParallelReviewStore().setStatus('a', {
    reviewSessionId: 'session',
    originalSessionId: 'main',
    phase: 'completed',
    compacting: false,
    returnToSession: false,
    error: null,
  })
  await flushPromises()
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('This review is closed')
  expect(store.startWorkspace).not.toHaveBeenCalled()
})

it('stops only the selected reviewer and preserves its draft on a rejected native send', async () => {
  const { useParallelReviewStore } = await import('../stores/parallel-review')
  const { store, wrapper } = await setup('executing')
  store.sessions[0]!.role = 'parallel-review'
  store.sessions[0]!.status = 'running'
  store.sessions[0]!.engine = 'mistral-vibe'
  useParallelReviewStore().setStatus('a', {
    reviewSessionId: 'session',
    originalSessionId: 'main',
    phase: 'reviewing',
    compacting: false,
    returnToSession: false,
    error: null,
  })
  vi.spyOn(useWebSocketStore(), 'isConnected').mockReturnValue(true)
  vi.spyOn(useWebSocketStore(), 'sendChatMessageConfirmed').mockRejectedValue(new Error('Native session busy'))
  const stop = vi.spyOn(useParallelReviewStore(), 'act').mockResolvedValue()
  const interrupt = vi.spyOn(store, 'interruptAgent')
  await wrapper.get('textarea').setValue('Check again')
  await wrapper.get('button[data-icon="send"]').trigger('click')
  await flushPromises()
  expect(wrapper.get('textarea').element.value).toBe('Check again')
  expect(store.queuedMessages).toEqual({})
  await wrapper.get('.chat-hint__interrupt').trigger('click')
  expect(stop).toHaveBeenCalledWith('a', 'session', 'stop')
  expect(interrupt).not.toHaveBeenCalled()
  expect(store.startWorkspace).not.toHaveBeenCalled()
})

it('preserves the reviewer draft and targeted stop while native closure is pending', async () => {
  const { useParallelReviewStore } = await import('../stores/parallel-review')
  const { store, wrapper } = await setup('executing')
  store.sessions[0]!.role = 'parallel-review'
  store.sessions[0]!.status = 'running'
  const reviews = useParallelReviewStore()
  const status = {
    reviewSessionId: 'session',
    originalSessionId: 'main',
    phase: 'reviewing' as const,
    compacting: false,
    returnToSession: true,
    error: null,
  }
  reviews.setStatus('a', status)
  await wrapper.get('textarea').setValue('Preserve this draft')
  reviews.setStatus('a', { ...status, phase: 'closing' })
  await flushPromises()
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  expect(wrapper.get('textarea').element.value).toBe('Preserve this draft')
  const stop = vi.spyOn(reviews, 'act').mockResolvedValue()
  const interrupt = vi.spyOn(store, 'interruptAgent')
  await wrapper.get('.chat-hint__interrupt').trigger('click')
  expect(stop).toHaveBeenCalledWith('a', 'session', 'stop')
  expect(interrupt).not.toHaveBeenCalled()
  expect(store.startWorkspace).not.toHaveBeenCalled()
})
