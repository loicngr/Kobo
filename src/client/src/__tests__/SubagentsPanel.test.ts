import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SubagentsPanel from '../components/SubagentsPanel.vue'
import en from '../i18n/en'
import { useWorkspaceStore } from '../stores/workspace'

const notify = vi.fn()
vi.mock('quasar', async (original) => ({ ...(await original<object>()), useQuasar: () => ({ notify }) }))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

// Stub Quasar components — they're registered globally at runtime but in tests
// we only care about the text content, not the rendered icons/spinners.
const globalStubs = {
  'q-icon': {
    props: ['name', 'color'],
    template: '<i class="q-icon" :data-name="name" :data-color="color"><slot /></i>',
  },
  'q-tooltip': { template: '<span class="q-tooltip"><slot /></span>' },
  'q-spinner-dots': { template: '<span class="q-spinner-dots"></span>' },
  'q-btn': {
    props: ['icon', 'label', 'disable', 'loading'],
    emits: ['click'],
    template:
      '<button class="q-btn" :data-icon="icon" :disabled="disable || loading" @click="$emit(\'click\')">{{ label }}<slot /></button>',
  },
  SubagentActivity: { template: '<div class="subagent-activity-stub">activity</div>' },
}

function mountPanel() {
  return mount(SubagentsPanel, { global: { stubs: globalStubs, plugins: [i18n] } })
}

describe('SubagentsPanel.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('shows empty state when no subagents', () => {
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('No sub-agent activity yet')
  })

  it('renders a running subagent with its description', () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', {
      toolUseId: 'tool-1',
      description: 'Fix the broken test',
      status: 'running',
      lastToolName: 'Bash',
      toolUses: 3,
      totalTokens: 1500,
      durationMs: 5200,
    })

    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('Fix the broken test')
    expect(wrapper.text()).toContain('Bash')
    expect(wrapper.text()).toContain('3 tools')
    expect(wrapper.text()).toContain('1.5k tok')
    expect(wrapper.text()).toContain('5.2s')
  })

  it('opens and closes an activity card from mouse and keyboard', async () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'tool-1', description: 'Inspect logs', status: 'running' })
    const wrapper = mountPanel()
    const summary = wrapper.get('.subagent-summary')

    await summary.trigger('click')
    expect(wrapper.find('.subagent-activity-stub').exists()).toBe(true)
    expect(summary.attributes('aria-expanded')).toBe('true')

    await summary.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('.subagent-activity-stub').exists()).toBe(false)
  })

  it('renders multiple subagents with newest first', async () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'a', description: 'First' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    store.upsertSubagent('ws-1', { toolUseId: 'b', description: 'Second' })

    const wrapper = mountPanel()
    const items = wrapper.findAll('.subagent-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('Second')
    expect(items[1].text()).toContain('First')
  })

  it('formats duration correctly', async () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'a', description: 'Quick', durationMs: 500 })
    store.upsertSubagent('ws-1', { toolUseId: 'b', description: 'Medium', durationMs: 15_000 })
    store.upsertSubagent('ws-1', { toolUseId: 'c', description: 'Long', durationMs: 125_000 })

    const wrapper = mountPanel()
    const text = wrapper.text()
    expect(text).toContain('500ms')
    expect(text).toContain('15.0s')
    expect(text).toContain('2m 5s')
  })

  it('formats token counts with k/M suffixes', () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'a', description: 'Small', totalTokens: 500 })
    store.upsertSubagent('ws-1', { toolUseId: 'b', description: 'Medium', totalTokens: 2_500 })
    store.upsertSubagent('ws-1', { toolUseId: 'c', description: 'Large', totalTokens: 1_500_000 })

    const wrapper = mountPanel()
    const text = wrapper.text()
    expect(text).toContain('500 tok')
    expect(text).toContain('2.5k tok')
    expect(text).toContain('1.5M tok')
  })

  it.each([
    ['running', 'play_circle', 'green-4', 'Running'],
    ['done', 'check_circle', 'kobo-3', 'Completed'],
    ['failed', 'error', 'negative', 'Failed'],
    ['stopped', 'stop_circle', 'warning', 'Stopped'],
  ] as const)('renders a %s sub-agent with its own icon, colour and label', (status, icon, color, label) => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'a', description: 'Task', status })

    const wrapper = mountPanel()
    const statusIcon = wrapper.find('.subagent-item .q-icon')
    expect(statusIcon.attributes('data-name')).toBe(icon)
    expect(statusIcon.attributes('data-color')).toBe(color)
    expect(statusIcon.find('.q-tooltip').text()).toBe(label)
  })

  it('marks an ambient sub-agent as a background watcher', () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'mon', description: 'Wait for CI', status: 'running', ambient: true })

    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('Wait for CI')
    expect(wrapper.text()).toContain('Background watcher')
  })

  describe('stopping sub-agents', () => {
    function selectWorkspace(engine: string) {
      const store = useWorkspaceStore()
      store.workspaces = [{ id: 'ws-1', engine } as unknown as (typeof store.workspaces)[number]]
      store.selectedWorkspaceId = 'ws-1'
      return store
    }

    it('shows a stop button only on running cards, and Stop all while one runs', () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'run', taskId: 'task-run', description: 'Runs', status: 'running' })
      store.upsertSubagent('ws-1', { toolUseId: 'done', description: 'Done', status: 'done' })

      const wrapper = mountPanel()
      expect(wrapper.findAll('.subagent-stop-btn')).toHaveLength(1)
      const running = wrapper.findAll('.subagent-item').find((item) => item.text().includes('Runs'))
      expect(running?.find('.subagent-stop-btn').exists()).toBe(true)
      expect(wrapper.find('.subagents-stop-all-btn').exists()).toBe(true)
    })

    it('offers Stop all for a running ambient watcher alone', () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'mon', description: 'Watch CI', status: 'running', ambient: true })

      const wrapper = mountPanel()
      expect(wrapper.find('.subagent-stop-btn').exists()).toBe(true)
      expect(wrapper.find('.subagents-stop-all-btn').exists()).toBe(true)
    })

    it('hides Stop all when nothing runs', () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'done', description: 'Done', status: 'done' })

      const wrapper = mountPanel()
      expect(wrapper.find('.subagent-stop-btn').exists()).toBe(false)
      expect(wrapper.find('.subagents-stop-all-btn').exists()).toBe(false)
    })

    it('shows no stop control on an engine that cannot stop a sub-agent', () => {
      const store = selectWorkspace('codex')
      store.upsertSubagent('ws-1', { toolUseId: 'run', description: 'Runs', status: 'running' })

      const wrapper = mountPanel()
      expect(wrapper.find('.subagent-stop-btn').exists()).toBe(false)
      expect(wrapper.find('.subagents-stop-all-btn').exists()).toBe(false)
    })

    it('stops one card by its canonical id and disables its button while in flight', async () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'run', taskId: 'task-run', description: 'Runs', status: 'running' })
      let resolve!: (n: number) => void
      const stop = vi.spyOn(store, 'stopSubagents').mockImplementation(
        () =>
          new Promise<number>((r) => {
            resolve = r
          }),
      )

      const wrapper = mountPanel()
      await wrapper.find('.subagent-stop-btn').trigger('click')
      expect(stop).toHaveBeenCalledWith('ws-1', 'task-run')
      expect(wrapper.find('.subagent-stop-btn').attributes('disabled')).toBeDefined()

      resolve(1)
      await flushPromises()
      expect(wrapper.find('.subagent-stop-btn').attributes('disabled')).toBeUndefined()
      // The card is not changed optimistically: it waits for the stopped event.
      expect(store.currentSubagents[0].status).toBe('running')
    })

    it('uses the tool call id when the task id is unknown', async () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'run', description: 'Runs', status: 'running' })
      const stop = vi.spyOn(store, 'stopSubagents').mockResolvedValue(1)

      const wrapper = mountPanel()
      await wrapper.find('.subagent-stop-btn').trigger('click')
      expect(stop).toHaveBeenCalledWith('ws-1', 'run')
    })

    it('Stop all calls the action without an id', async () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'run', description: 'Runs', status: 'running' })
      const stop = vi.spyOn(store, 'stopSubagents').mockResolvedValue(1)

      const wrapper = mountPanel()
      await wrapper.find('.subagents-stop-all-btn').trigger('click')
      expect(stop).toHaveBeenCalledWith('ws-1')
    })

    it('notifies the error when the stop fails', async () => {
      const store = selectWorkspace('claude-code')
      store.upsertSubagent('ws-1', { toolUseId: 'run', description: 'Runs', status: 'running' })
      vi.spyOn(store, 'stopSubagents').mockRejectedValue(new Error('not running'))

      const wrapper = mountPanel()
      await wrapper.find('.subagent-stop-btn').trigger('click')
      await flushPromises()
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }))
      expect(String(notify.mock.calls[0][0].message)).toContain('not running')
      expect(wrapper.find('.subagent-stop-btn').attributes('disabled')).toBeUndefined()
    })
  })
})
