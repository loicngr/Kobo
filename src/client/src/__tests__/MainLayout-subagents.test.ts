import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '../i18n/en'
import MainLayout from '../layouts/MainLayout.vue'
import { useWorkspaceStore } from '../stores/workspace'

vi.mock('quasar', async (original) => ({
  ...(await original<object>()),
  useQuasar: () => ({ screen: { width: 1400, lt: { md: false } } }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ name: 'workspace', params: { id: 'w' }, query: {} }) }))
vi.mock('../composables/use-tours', () => ({
  useTours: () => ({ scheduleAutoRun: vi.fn(), migrateLegacyFlag: vi.fn() }),
}))

vi.mock('../components/GitPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../components/DocumentsPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../components/TerminalPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../components/SchedulePanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../components/MemoryPanel.vue', () => ({ default: { template: '<div />' } }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ sounds: [], documents: [], proposals: [] })),
  )
})
afterEach(() => vi.unstubAllGlobals())

it.each(['claude-code', 'codex'])(
  'shows %s reviewer subagents on Vibe and follows session selection',
  async (engine) => {
    const store = useWorkspaceStore()
    store.workspaces = [{ id: 'w', engine: 'mistral-vibe' }] as typeof store.workspaces
    store.selectedWorkspaceId = 'w'
    store.sessions = [
      { id: 'source', workspaceId: 'w', engine: 'mistral-vibe', role: 'primary', status: 'running' },
      { id: 'review', workspaceId: 'w', engine, role: 'parallel-review', status: 'running' },
    ] as typeof store.sessions
    store.selectedSessionId = 'review'
    const wrapper = shallowMount(MainLayout, {
      global: {
        plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
        renderStubDefaultSlot: true,
        stubs: Object.fromEntries(
          [
            'q-layout',
            'q-drawer',
            'q-tabs',
            'q-badge',
            'q-icon',
            'q-btn',
            'q-banner',
            'q-tab',
            'q-tab-panels',
            'q-tab-panel',
            'q-separator',
            'q-tooltip',
            'q-page-container',
            'router-view',
            'GitPanel',
            'DocumentsPanel',
            'TerminalPanel',
            'SchedulePanel',
            'MemoryPanel',
          ].map((name) => [name, true]),
        ),
      },
    })
    try {
      expect(wrapper.find('[data-tour="ws-tabnav-subagents"]').exists()).toBe(true)
      expect(wrapper.findComponent({ name: 'SubagentsPanel' }).exists()).toBe(true)
      wrapper.findComponent({ name: 'QTabs' }).vm.$emit('update:modelValue', 'subagents')
      store.selectedSessionId = 'source'
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-tour="ws-tabnav-subagents"]').exists()).toBe(false)
      expect(wrapper.findComponent({ name: 'SubagentsPanel' }).exists()).toBe(false)
      expect(localStorage.getItem('kobo:rightTab')).toBe('tasks')
      store.workspaces[0]!.engine = 'claude-code'
      store.sessions[1]!.engine = 'mistral-vibe'
      store.selectedSessionId = 'review'
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-tour="ws-tabnav-subagents"]').exists()).toBe(false)
      store.selectedSessionId = null
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-tour="ws-tabnav-subagents"]').exists()).toBe(true)
    } finally {
      await flushPromises()
      wrapper.unmount()
    }
  },
)
