import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import type { AutoLoopRuntime, QueuedAutoLoopMessage } from '../../../shared/auto-loop-types'
import AutoLoopChip from '../components/AutoLoopChip.vue'
import AutoLoopStatusPanel from '../components/AutoLoopStatusPanel.vue'
import en from '../i18n/en'

const store = reactive({
  autoLoopStates: {} as Record<
    string,
    Partial<AutoLoopRuntime> & {
      auto_loop: boolean
      auto_loop_ready: boolean
      retry_at?: string | null
      tasks_done: number
      tasks_total: number
    }
  >,
  autoLoopMessages: {} as Record<string, QueuedAutoLoopMessage[]>,
  selectedWorkspace: { id: 'ws-1' },
  selectedWorkspaceId: 'ws-1',
  tasks: [] as { status: string }[],
  fetchAutoLoopMessages: vi.fn(async (_id: string) => {}),
  resolveAutoLoopMessage: vi.fn(async (_id: string, _messageId: number, _action: string) => {}),
  enableAutoLoop: vi.fn(async (_id: string) => {}),
  disableAutoLoop: vi.fn(async (_id: string) => {}),
})
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: () => store }))

const global = {
  plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
  stubs: {
    QBtn: {
      props: ['label', 'disable', 'loading'],
      template: '<button :disabled="disable || loading">{{ label }}<slot /></button>',
    },
    QChip: { template: '<div><slot /></div>' },
    QTooltip: { template: '<span><slot /></span>' },
  },
}

function queued(state: QueuedAutoLoopMessage['state'], id = 1): QueuedAutoLoopMessage {
  return {
    id,
    state,
    content: `Instruction ${id}`,
    clientMessageId: `client-${id}`,
    sessionId: null,
    createdAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.autoLoopStates = {
    'ws-1': {
      auto_loop: true,
      auto_loop_ready: true,
      phase: 'execution',
      state: 'blocked',
      reason: 'error',
      iteration: 3,
      tasks_done: 1,
      tasks_total: 3,
    },
  }
  store.autoLoopMessages = { 'ws-1': [] }
})

it('shows the waiting phase, iteration and scheduled retry without offering a premature resume', async () => {
  store.autoLoopStates['ws-1'] = {
    ...store.autoLoopStates['ws-1']!,
    phase: 'finalization',
    state: 'waiting',
    reason: 'quota',
    retry_at: '2026-09-17T18:30:00.000Z',
  }
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(store.fetchAutoLoopMessages).toHaveBeenCalledWith('ws-1')
  expect(view.text()).toContain('Waiting')
  expect(view.text()).toContain('Finalization')
  expect(view.text()).toContain('Iteration 3')
  expect(view.find('time').attributes('datetime')).toBe('2026-09-17T18:30:00.000Z')
  expect(view.find('[data-test="loop-resume"]').exists()).toBe(false)
  view.unmount()
})

it('requires an explicit decision on unknown delivery before exposing resume', async () => {
  store.autoLoopMessages['ws-1'] = [queued('unknown'), queued('pending', 2), queued('dispatching', 3)]
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(view.find('[data-test="loop-resume"]').exists()).toBe(false)
  expect(store.resolveAutoLoopMessage).not.toHaveBeenCalled()
  await view.get('[data-test="message-acknowledge-1"]').trigger('click')
  await flushPromises()
  expect(store.resolveAutoLoopMessage).toHaveBeenLastCalledWith('ws-1', 1, 'acknowledge')
  await view.get('[data-test="message-retry-1"]').trigger('click')
  await flushPromises()
  expect(store.resolveAutoLoopMessage).toHaveBeenLastCalledWith('ws-1', 1, 'retry')
  await view.get('[data-test="message-cancel-2"]').trigger('click')
  await flushPromises()
  expect(store.resolveAutoLoopMessage).toHaveBeenLastCalledWith('ws-1', 2, 'cancel')
  expect(view.find('[data-test="message-cancel-3"]').exists()).toBe(false)
  view.unmount()
})

it('offers resume only for a blocked loop and preserves the explicit stop action', async () => {
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await view.get('[data-test="loop-resume"]').trigger('click')
  await flushPromises()
  expect(store.enableAutoLoop).toHaveBeenCalledWith('ws-1')
  await view.get('[data-test="loop-stop"]').trigger('click')
  await flushPromises()
  expect(store.disableAutoLoop).toHaveBeenCalledWith('ws-1')
  view.unmount()
})

it('reports action failures and refreshes the queue when the workspace changes', async () => {
  store.enableAutoLoop.mockRejectedValueOnce(new Error('Resume failed'))
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await view.get('[data-test="loop-resume"]').trigger('click')
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain('Resume failed')
  await view.setProps({ workspaceId: 'ws-2' })
  await flushPromises()
  expect(store.fetchAutoLoopMessages).toHaveBeenCalledWith('ws-2')
  expect(view.find('[role="alert"]').exists()).toBe(false)
  view.unmount()
})

it.each(['missing', 'stopped'] as const)(
  'keeps a manual workspace panel hidden after a queue fetch failure with %s loop status',
  async (status) => {
    store.autoLoopStates =
      status === 'missing'
        ? {}
        : {
            'ws-1': {
              auto_loop: false,
              auto_loop_ready: false,
              phase: 'grooming',
              state: 'stopped',
              iteration: 0,
              tasks_done: 0,
              tasks_total: 0,
            },
          }
    store.fetchAutoLoopMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
    await flushPromises()
    expect(view.find('section').exists()).toBe(false)
    view.unmount()
  },
)

it('keeps queue fetch errors visible for an actual auto-loop', async () => {
  store.fetchAutoLoopMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe('Failed to fetch')
  expect(view.text()).toContain('Blocked')
  view.unmount()
})

it('hides the loop panel when switching to a manual workspace whose queue fetch fails', async () => {
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(view.find('section').exists()).toBe(true)

  store.fetchAutoLoopMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  await view.setProps({ workspaceId: 'ws-2' })
  await flushPromises()
  expect(store.fetchAutoLoopMessages).toHaveBeenCalledWith('ws-2')
  expect(view.find('section').exists()).toBe(false)
  view.unmount()
})

it('preserves unresolved instructions even without an active auto-loop when the queue fetch fails', async () => {
  store.autoLoopStates = {}
  store.autoLoopMessages['ws-1'] = [queued('unknown')]
  store.fetchAutoLoopMessages.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(view.find('[data-test="message-acknowledge-1"]').exists()).toBe(true)
  expect(view.get('[role="alert"]').text()).toBe('Failed to fetch')
  view.unmount()
})

it.each(['completed', 'stopped'] as const)(
  'remembers dismissal of a %s loop across navigation and remounts',
  async (state) => {
    store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state, auto_loop: false }
    store.autoLoopStates['ws-2'] = { ...store.autoLoopStates['ws-1']! }
    const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
    await flushPromises()
    await view.get('[data-test="loop-dismiss"]').trigger('click')
    expect(view.find('section').exists()).toBe(false)
    expect(store.disableAutoLoop).not.toHaveBeenCalled()
    expect(store.autoLoopStates['ws-1']?.state).toBe(state)

    await view.setProps({ workspaceId: 'ws-2' })
    expect(view.find('section').exists()).toBe(true)
    await view.setProps({ workspaceId: 'ws-1' })
    expect(view.find('section').exists()).toBe(false)
    view.unmount()

    const reopened = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
    await flushPromises()
    expect(reopened.find('section').exists()).toBe(false)
    reopened.unmount()
  },
)

it.each(['active', 'waiting', 'blocked'] as const)('does not offer dismissal for a %s loop', async (state) => {
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state }
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(view.find('section').exists()).toBe(true)
  expect(view.find('[data-test="loop-dismiss"]').exists()).toBe(false)
  view.unmount()
})

it('shows a restarted loop and its next completion after the previous banner was dismissed', async () => {
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state: 'completed', auto_loop: false }
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  await view.get('[data-test="loop-dismiss"]').trigger('click')
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state: 'active', auto_loop: true }
  await flushPromises()
  expect(view.find('section').exists()).toBe(true)
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state: 'completed', auto_loop: false }
  await flushPromises()
  expect(view.find('[data-test="loop-dismiss"]').exists()).toBe(true)
  view.unmount()
})

it('shows a different completed iteration after a reload', async () => {
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state: 'completed', auto_loop: false }
  const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  await view.get('[data-test="loop-dismiss"]').trigger('click')
  view.unmount()
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, iteration: 4 }
  const reopened = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
  await flushPromises()
  expect(reopened.find('section').exists()).toBe(true)
  reopened.unmount()
})

it.each(['pending', 'dispatching', 'unknown'] as const)(
  'reveals a dismissed panel with %s instructions and prevents hiding it',
  async (state) => {
    store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state: 'completed', auto_loop: false }
    const view = mount(AutoLoopStatusPanel, { props: { workspaceId: 'ws-1' }, global })
    await flushPromises()
    await view.get('[data-test="loop-dismiss"]').trigger('click')
    store.autoLoopMessages['ws-1'] = [queued(state)]
    await flushPromises()
    expect(view.find('section').exists()).toBe(true)
    expect(view.text()).toContain('Instruction 1')
    expect(view.find('[data-test="loop-dismiss"]').exists()).toBe(false)
    view.unmount()
  },
)

it.each(['blocked', 'waiting'] as const)('shows %s in the compact chip before grooming or progress', (state) => {
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state, auto_loop_ready: false }
  const view = mount(AutoLoopChip, { global })
  expect(view.text()).toContain(state === 'blocked' ? 'Blocked' : 'Waiting')
  expect(view.text()).not.toContain('preparing')
  view.unmount()
})
