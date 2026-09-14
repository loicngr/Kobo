import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import ChatInput from '../components/ChatInput.vue'
import en from '../i18n/en'
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
    if (options?.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ history: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
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
        QuotaFooter: true,
        SlashSuggestionsPopup: true,
      },
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
