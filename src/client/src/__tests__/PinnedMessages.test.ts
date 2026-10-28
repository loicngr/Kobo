import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { Notify } from 'quasar'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { PinnedMessage } from '../../../shared/pinned-messages'
import MessagePinMenu from '../components/MessagePinMenu.vue'
import PinnedMessagesDialog from '../components/PinnedMessagesDialog.vue'
import TurnCard from '../components/TurnCard.vue'
import en from '../i18n/en'
import type { Turn } from '../services/conversation-turns'
import { openSubagentActivityKey } from '../services/subagent-activity-navigation'
import { useDocumentsStore } from '../stores/documents'
import { usePinnedMessagesStore } from '../stores/pinned-messages'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', async (original) => ({ ...(await original<typeof import('quasar')>()), Notify: { create: vi.fn() } }))
const { push } = vi.hoisted(() => ({ push: vi.fn().mockResolvedValue(undefined) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
const pin: PinnedMessage = {
  id: 'p1',
  workspaceId: 'w1',
  workspaceName: 'Mission',
  sessionId: 's1',
  sessionName: 'Session',
  eventId: 'e1',
  itemKeys: ['text:m1'],
  speaker: 'agent',
  preview: '<script>Answer</script>',
  messageCreatedAt: '2026-10-28T10:00:00Z',
  createdAt: '2026-10-28T11:00:00Z',
  archived: false,
  sourceAvailable: true,
}
const turn: Turn = {
  speaker: 'agent',
  items: [{ type: 'text', messageId: 'm1', text: 'Answer', streaming: false, eventIds: ['e1', 'e2'] }],
}
const passthrough = { template: '<div><slot /></div>' }
const button = { props: ['label', 'disable'], template: '<button :disabled="disable"><slot />{{ label }}</button>' }
const global = {
  plugins: [createI18n({ legacy: false, locale: 'en', flatJson: true, messages: { en: { ...en } } })],
  directives: { 'close-popup': {} },
  stubs: {
    QDialog: passthrough,
    QCard: passthrough,
    QCardSection: passthrough,
    QSpace: true,
    QBtn: button,
    QMenu: passthrough,
    QList: passthrough,
    QItem: button,
    QItemSection: passthrough,
    QIcon: passthrough,
    QTooltip: true,
    QSpinner: true,
    TurnCard: {
      props: { turn: Object, disablePin: Boolean },
      template: '<article :data-disable-pin="disablePin">{{ turn.items[0].text }}</article>',
    },
  },
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(usePinnedMessagesStore(), 'load').mockResolvedValue(undefined)
  vi.spyOn(Notify, 'create').mockReturnValue(() => {})
  push.mockClear()
})
describe('message pin menu', () => {
  it('has an accessible menu and pins the complete persisted card, then offers unpin', async () => {
    const store = usePinnedMessagesStore()
    const save = vi.spyOn(store, 'pin').mockResolvedValue(pin)
    const remove = vi.spyOn(store, 'unpin').mockResolvedValue(undefined)
    const wrapper = mount(MessagePinMenu, { props: { workspaceId: 'w1', sessionId: 's1', turn }, global })
    expect(wrapper.get('[aria-haspopup="menu"]').attributes('aria-label')).toBe('Message actions')
    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith('w1', 's1', ['e1', 'e2'])
    store.list('w1').pins = [pin]
    await flushPromises()
    expect(wrapper.get('[role="img"]').attributes('aria-label')).toBe('Pinned message')
    expect(wrapper.text()).toContain('Unpin message')
    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith(pin)
    wrapper.unmount()
  })
  it('disables unpersisted and optimistic cards and reports mutation failures', async () => {
    const store = usePinnedMessagesStore()
    const save = vi.spyOn(store, 'pin').mockRejectedValue(new Error('retained events missing'))
    const wrapper = mount(MessagePinMenu, {
      props: {
        workspaceId: 'w1',
        sessionId: 's1',
        turn: { speaker: 'user', items: [{ type: 'user', content: 'Hi', sender: 'user' }] },
      },
      global,
    })
    expect(wrapper.findAll('button')[1]!.attributes('disabled')).toBeDefined()
    await wrapper.setProps({ turn })
    await wrapper.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledOnce()
    expect(Notify.create).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('retained events missing') }),
    )
    useWorkspaceStore().activityFeeds.w1 = [
      { id: 'e1', type: 'text', content: 'Hi', timestamp: '', meta: { pending: true } },
    ]
    await flushPromises()
    expect(wrapper.findAll('button')[1]!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
describe('pinned message list', () => {
  function dialog(workspaceId?: string) {
    usePinnedMessagesStore().list(workspaceId).pins = [pin]
    return mount(PinnedMessagesDialog, { props: { modelValue: true, workspaceId }, global })
  }
  it('changes session before focusing an original in the same workspace', async () => {
    const fetchSessions = vi.spyOn(useWorkspaceStore(), 'fetchSessions').mockResolvedValue(undefined)
    vi.spyOn(usePinnedMessagesStore(), 'detail').mockResolvedValue({ pin, events: [] })
    const focused = vi.fn((event: Event) => {
      expect(fetchSessions).toHaveBeenCalledWith('w1', 's1')
      const detail = (event as CustomEvent).detail
      expect(detail).toMatchObject({ workspaceId: 'w1', sessionId: 's1', eventId: 'e1' })
      detail.onFocused()
    })
    window.addEventListener('kobo:focus-history-event', focused)
    const wrapper = dialog('w1')
    await wrapper.get('.pinned-open').trigger('click')
    await flushPromises()
    expect(focused).toHaveBeenCalledOnce()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(push).not.toHaveBeenCalled()
    window.removeEventListener('kobo:focus-history-event', focused)
    wrapper.unmount()
  })
  it.each(['onFocused', 'onUnavailable', 'onError', 'onCancelled'])(
    'keeps the loader and disables actions until history reports %s',
    async (completion) => {
      vi.spyOn(useWorkspaceStore(), 'fetchSessions').mockResolvedValue(undefined)
      vi.spyOn(usePinnedMessagesStore(), 'detail').mockResolvedValue({ pin, events: [] })
      let focus: Record<string, (...args: unknown[]) => void> | undefined
      const listener = (event: Event) => {
        focus = (event as CustomEvent).detail
      }
      window.addEventListener('kobo:focus-history-event', listener)
      const wrapper = dialog('w1')
      try {
        await wrapper.get('.pinned-open').trigger('click')
        await flushPromises()
        expect(wrapper.findComponent({ name: 'QSpinner' }).exists()).toBe(true)
        expect(wrapper.get('.pinned-open').attributes('disabled')).toBeDefined()
        expect(wrapper.emitted('update:modelValue')).toBeUndefined()
        focus![completion](new Error('offline'))
        await flushPromises()
        expect(wrapper.findComponent({ name: 'QSpinner' }).exists()).toBe(false)
        if (completion === 'onFocused') expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
        if (completion === 'onError' || completion === 'onCancelled')
          expect(wrapper.get('.pinned-open').attributes('disabled')).toBeUndefined()
      } finally {
        window.removeEventListener('kobo:focus-history-event', listener)
        wrapper.unmount()
      }
    },
  )
  it('navigates global pins, including archived workspaces, using the original session and event', async () => {
    vi.spyOn(usePinnedMessagesStore(), 'detail').mockResolvedValue({ pin, events: [] })
    const wrapper = dialog()
    await wrapper.get('.pinned-open').trigger('click')
    await flushPromises()
    expect(push).toHaveBeenCalledWith({
      name: 'workspace',
      params: { id: 'w1' },
      query: { session: 's1', eventId: 'e1' },
    })
    expect(wrapper.find('script').exists()).toBe(false)
    wrapper.unmount()
  })
  it('loads saved content lazily when the original disappeared and disables nested pin menus', async () => {
    const detail = vi.spyOn(usePinnedMessagesStore(), 'detail').mockResolvedValue({
      pin: { ...pin, sourceAvailable: false },
      events: [
        {
          id: 'e1',
          workspaceId: 'w1',
          sessionId: 's1',
          type: 'agent:event',
          createdAt: pin.messageCreatedAt,
          payload: { kind: 'message:text', messageId: 'm1', text: 'Saved answer', streaming: false },
        },
      ],
    })
    const wrapper = dialog('w1')
    expect(detail).not.toHaveBeenCalled()
    await wrapper.get('.pinned-open').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Saved copy captured when pinned')
    expect(wrapper.get('article').attributes('data-disable-pin')).toBe('true')
    expect(wrapper.get('article').text()).toBe('Saved answer')
    expect(push).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('keeps dashboard copies independent of the selected workspace while preserving reading and live navigation', async () => {
    const workspace = useWorkspaceStore()
    workspace.selectedWorkspaceId = 'selected'
    workspace.workspaces = [{ id: 'selected', projectPath: '/tmp/selected', workingBranch: 'main' } as Workspace]
    const subagent = {
      toolUseId: 'child',
      description: 'Current session agent',
      status: 'done' as const,
      sessionId: 'current',
      startedAt: '',
      updatedAt: '',
    }
    workspace.subagents = { w1: { child: subagent }, selected: { child: subagent } }
    const documents = useDocumentsStore()
    documents.documentsByWorkspace.selected = [{ path: 'docs/plan.md', name: 'plan', modifiedAt: '' }]
    const openDocument = vi.spyOn(documents, 'openDocumentByPath').mockResolvedValue(true)
    const openSubagent = vi.fn()
    const openDiff = vi.fn()
    window.addEventListener('kobo:open-diff', openDiff)
    const origin = { kind: 'subagent', toolCallId: 'child' }
    const payloads = [
      {
        kind: 'message:text',
        messageId: 'parent',
        text: 'Read docs/plan.md and [website](https://example.org)',
        streaming: false,
      },
      {
        kind: 'tool:call',
        toolCallId: 'edit',
        name: 'Edit',
        input: { file_path: 'src/app.ts', old_string: 'before', new_string: 'after' },
      },
      { kind: 'message:text', messageId: 'child-text', text: 'Child docs/plan.md', streaming: false, origin },
      {
        kind: 'tool:call',
        toolCallId: 'child-edit',
        name: 'Edit',
        input: { file_path: 'child.ts', old_string: 'old', new_string: 'new' },
        origin,
      },
    ]
    vi.spyOn(usePinnedMessagesStore(), 'detail').mockResolvedValue({
      pin: { ...pin, sourceAvailable: false },
      events: payloads.map((payload, i) => ({
        id: `saved-${i}`,
        workspaceId: 'w1',
        sessionId: 's1',
        type: 'agent:event',
        createdAt: pin.messageCreatedAt,
        payload,
      })),
    })
    usePinnedMessagesStore().list().pins = [pin]
    const realCards = {
      ...global,
      provide: { _q_: { notify: vi.fn() }, [openSubagentActivityKey as symbol]: openSubagent },
      stubs: {
        ...global.stubs,
        TurnCard: false,
        QItemLabel: passthrough,
        QExpansionItem: {
          data: () => ({ expanded: false }),
          template:
            '<section><button class="expand" @click="expanded = !expanded"><slot name="header" /></button><div v-if="expanded"><slot /></div></section>',
        },
      },
    }
    const wrapper = mount(PinnedMessagesDialog, { props: { modelValue: true }, global: realCards })
    await wrapper.get('.pinned-open').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Read docs/plan.md')
    expect(wrapper.get('a[href="https://example.org"]').text()).toBe('website')
    expect(wrapper.text()).not.toContain('Current session agent')
    await wrapper.get('.expand').trigger('click')
    expect(wrapper.text()).toContain('Child docs/plan.md')
    expect(wrapper.findAll('.tool-open-diff')).toHaveLength(0)
    expect(wrapper.findAll('.document-link')).toHaveLength(0)
    expect(wrapper.find('.turn-subagent-activity [aria-label]').exists()).toBe(false)
    for (const header of wrapper.findAll('.tool-header')) await header.trigger('click')
    expect(wrapper.findAll('.tool-diff')).toHaveLength(2)
    expect(wrapper.text()).toContain('before')
    expect(wrapper.text()).toContain('after')
    expect(openDiff).not.toHaveBeenCalled()
    expect(openDocument).not.toHaveBeenCalled()
    expect(openSubagent).not.toHaveBeenCalled()

    const live = mount(TurnCard, {
      props: { turn: wrapper.getComponent(TurnCard).props('turn'), workspaceId: 'selected', disablePin: true },
      global: realCards,
    })
    await live.get('.expand').trigger('click')
    expect(live.text()).toContain('Current session agent')
    expect(live.findAll('.tool-open-diff')).toHaveLength(2)
    expect(live.findAll('.document-link')).toHaveLength(2)
    await live.get('.tool-open-diff').trigger('click')
    await live.get('.document-link').trigger('click')
    await live.get('.turn-subagent-activity [aria-label]').trigger('click')
    expect(openDiff).toHaveBeenCalledOnce()
    expect(openDocument).toHaveBeenCalledWith('selected', 'docs/plan.md')
    expect(openSubagent).toHaveBeenCalledWith({ origin })
    live.unmount()
    wrapper.unmount()
    window.removeEventListener('kobo:open-diff', openDiff)
  })
  it('drops a late snapshot after switching the list scope', async () => {
    let finish!: (value: { pin: PinnedMessage; events: [] }) => void
    vi.spyOn(usePinnedMessagesStore(), 'detail').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const wrapper = dialog('w1')
    await wrapper.get('.pinned-open').trigger('click')
    await wrapper.setProps({ workspaceId: 'w2' })
    finish({ pin: { ...pin, sourceAvailable: false }, events: [] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Saved copy captured')
    expect(wrapper.text()).toContain('No pinned messages.')
    wrapper.unmount()
  })
})
