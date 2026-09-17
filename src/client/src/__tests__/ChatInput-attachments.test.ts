import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import ChatInput from '../components/ChatInput.vue'
import en from '../i18n/en'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', async () => ({
  ...(await vi.importActual('quasar')),
  useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, notify: vi.fn() }),
}))
const wrappers: VueWrapper[] = []
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
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
