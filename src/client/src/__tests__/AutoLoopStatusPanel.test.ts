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

it.each(['blocked', 'waiting'] as const)('shows %s in the compact chip before grooming or progress', (state) => {
  store.autoLoopStates['ws-1'] = { ...store.autoLoopStates['ws-1']!, state, auto_loop_ready: false }
  const view = mount(AutoLoopChip, { global })
  expect(view.text()).toContain(state === 'blocked' ? 'Blocked' : 'Waiting')
  expect(view.text()).not.toContain('preparing')
  view.unmount()
})
