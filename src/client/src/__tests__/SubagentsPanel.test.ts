import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import SubagentsPanel from '../components/SubagentsPanel.vue'
import { useWorkspaceStore } from '../stores/workspace'

// Stub Quasar components — they're registered globally at runtime but in tests
// we only care about the text content, not the rendered icons/spinners.
const globalStubs = {
  'q-icon': { template: '<i class="q-icon"><slot /></i>' },
  'q-spinner-dots': { template: '<span class="q-spinner-dots"></span>' },
}

function mountPanel() {
  return mount(SubagentsPanel, { global: { stubs: globalStubs } })
}

describe('SubagentsPanel.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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

  it('renders multiple subagents in startedAt order', async () => {
    const store = useWorkspaceStore()
    store.selectedWorkspaceId = 'ws-1'
    store.upsertSubagent('ws-1', { toolUseId: 'a', description: 'First' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    store.upsertSubagent('ws-1', { toolUseId: 'b', description: 'Second' })

    const wrapper = mountPanel()
    const items = wrapper.findAll('.subagent-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('First')
    expect(items[1].text()).toContain('Second')
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
})
