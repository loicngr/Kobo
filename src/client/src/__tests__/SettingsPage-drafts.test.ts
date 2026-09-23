import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import IntegrationConnectionSettings from '../components/IntegrationConnectionSettings.vue'
import SettingsNavList from '../components/SettingsNavList.vue'
import WorkflowPolicyEditor from '../components/WorkflowPolicyEditor.vue'
import en from '../i18n/en'
import SettingsPage from '../pages/SettingsPage.vue'
import { type ProjectSettings, useSettingsStore } from '../stores/settings'
import { useWorkspaceTemplatesStore } from '../stores/workspace-templates'
import { _clearUnsavedScopesForTest, hasUnsavedWork } from '../utils/unsaved-guard'

const { api, notify } = vi.hoisted(() => ({ api: vi.fn(), notify: vi.fn() }))
vi.mock('../utils/api', () => ({ apiFetch: api }))
vi.mock('quasar', () => ({ useQuasar: () => ({ notify, screen: { lt: { sm: false, md: false } } }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('../composables/use-tours', () => ({ useTours: () => ({ scheduleAutoRun: vi.fn() }) }))

const Field = defineComponent({
  inheritAttrs: false,
  props: ['modelValue', 'label', 'disable'],
  emits: ['update:modelValue'],
  setup:
    (props, { emit, attrs }) =>
    () =>
      h('input', {
        ...attrs,
        disabled: props.disable,
        'aria-label': props.label,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
      }),
})
const Button = defineComponent({
  props: ['label', 'disable', 'loading'],
  emits: ['click'],
  setup:
    (props, { emit }) =>
    () =>
      h('button', { disabled: props.disable || props.loading, onClick: () => emit('click') }, props.label),
})
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
const wrappers: Array<ReturnType<typeof shallowMount>> = []
async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useSettingsStore()
  store.loaded = true
  store.global.workflowPolicy = { commit: 'automatic', push: 'automatic', publish: 'automatic' }
  store.projects = [
    { path: '/a', displayName: 'A', workflowPolicy: { push: 'manual' } },
    { path: '/b', displayName: 'B', workflowPolicy: {} },
  ] as ProjectSettings[]
  vi.spyOn(store, 'fetchSettings').mockResolvedValue(undefined)
  vi.spyOn(store, 'fetchActiveMcpServers').mockResolvedValue(undefined)
  vi.spyOn(store, 'fetchGlobalDefaults').mockResolvedValue({} as Awaited<ReturnType<typeof store.fetchGlobalDefaults>>)
  vi.spyOn(store, 'fetchVoiceModels').mockResolvedValue(undefined)
  vi.spyOn(store, 'fetchVoiceRuntime').mockResolvedValue(undefined)
  vi.spyOn(useWorkspaceTemplatesStore(), 'fetchTemplates').mockResolvedValue(undefined)
  api.mockImplementation(async (url: string, options?: { body: Record<string, unknown> }) => {
    if (url === '/api/settings/global') return { ...store.global, ...options?.body }
    if (url.startsWith('/api/settings/projects/')) return { ...store.projects[0], ...options?.body }
    return { configured: false }
  })
  const wrapper = shallowMount(SettingsPage, {
    global: {
      plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })],
      renderStubDefaultSlot: true,
      directives: { 'close-popup': {} },
      stubs: {
        QPage: Slot,
        QBtn: Button,
        QInput: Field,
        QSelect: Field,
        QExpansionItem: Slot,
        QIcon: true,
        QSpace: true,
        QItemSection: Slot,
        QItem: Slot,
        QSeparator: true,
        QList: Slot,
        QDrawer: Slot,
        QTooltip: Slot,
        QToggle: Field,
        QOptionGroup: Field,
        QBtnDropdown: Slot,
        QSlider: Field,
        QChip: Slot,
        QLinearProgress: true,
        QItemLabel: Slot,
        QAvatar: Slot,
        QPopupEdit: true,
        QDialog: true,
        QCard: Slot,
        QCardSection: Slot,
        QCardActions: Slot,
        QBadge: Slot,
        QSpinner: true,
        QSpinnerDots: true,
        QCheckbox: Field,
        QBanner: Slot,
        QTabs: Slot,
        QTab: true,
        QTabPanels: Slot,
        QTabPanel: Slot,
        QScrollArea: Slot,
        WorkflowPolicyEditor: false,
        IntegrationConnectionSettings: false,
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  async function tab(value: string) {
    wrapper.getComponent(SettingsNavList).vm.$emit('select', value)
    await flushPromises()
  }
  const vm = wrapper.vm as unknown as {
    savebarSave(): void
    selectedProjectIndex: number
    applyCopyFrom(path: string): void
  }
  return { wrapper, store, tab, vm }
}
beforeEach(() => {
  vi.clearAllMocks()
  _clearUnsavedScopesForTest()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('network') ? { urls: [], token: '', enabled: false, behindProxy: false } : []),
    })),
  )
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('settings drafts', () => {
  it.each(['notion', 'sentry'])(
    'disables the %s legacy selector while a direct connection is stored and restores it after clearing',
    async (integrationName) => {
      const { wrapper, tab } = await setup()
      api.mockResolvedValue({ configured: true })
      await tab(integrationName)
      const selector = () => wrapper.get(`[data-test="${integrationName}-mcp-key"]`)
      expect(selector().attributes('disabled')).toBeDefined()
      expect(wrapper.text()).toContain('The saved direct connection takes priority')
      api.mockResolvedValue({ configured: false })
      await wrapper.getComponent(IntegrationConnectionSettings).findAll('button')[1]!.trigger('click')
      await flushPromises()
      expect(selector().attributes('disabled')).toBeUndefined()
    },
  )

  it('does not clear newer integration edits when a previous submission finishes after a tab change', async () => {
    const { wrapper, tab } = await setup()
    await tab('notion')
    let integration = wrapper.getComponent(IntegrationConnectionSettings)
    await integration.findAll('input')[0]!.setValue('original-command')
    let finish!: (result: { configured: boolean }) => void
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await integration.findAll('button')[0]!.trigger('click')
    await tab('general')
    await tab('notion')
    integration = wrapper.getComponent(IntegrationConnectionSettings)
    await integration.findAll('input')[0]!.setValue('new-command')
    finish({ configured: true })
    await flushPromises()
    expect(integration.findAll('input')[0]!.element.value).toBe('new-command')
    expect(hasUnsavedWork()).toBe(true)
  })

  it('clears a successfully submitted integration draft even after leaving its tab', async () => {
    const { wrapper, tab } = await setup()
    await tab('notion')
    const integration = wrapper.getComponent(IntegrationConnectionSettings)
    await integration.findAll('input')[0]!.setValue('node')
    let finish!: (result: { configured: boolean }) => void
    api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await integration.findAll('button')[0]!.trigger('click')
    await tab('general')
    finish({ configured: true })
    await flushPromises()
    expect(hasUnsavedWork()).toBe(false)
    await tab('notion')
    expect(wrapper.getComponent(IntegrationConnectionSettings).findAll('input')[0]!.element.value).toBe('')
  })

  it('keeps workflow edits across tabs and store refreshes, then saves through the main button', async () => {
    const { wrapper, store, tab, vm } = await setup()
    await tab('git')
    const editor = wrapper.findComponent(WorkflowPolicyEditor)
    expect(editor.exists()).toBe(true)
    editor.vm.$emit('update:modelValue', { commit: 'manual', push: 'manual', publish: 'manual' })
    await flushPromises()
    expect(hasUnsavedWork()).toBe(true)
    store.global = { ...store.global, workflowPolicy: { ...store.global.workflowPolicy } }
    await tab('general')
    await tab('git')
    expect(wrapper.getComponent(WorkflowPolicyEditor).props('modelValue').push).toBe('manual')
    vm.savebarSave()
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/settings/global',
      expect.objectContaining({
        body: expect.objectContaining({ workflowPolicy: { commit: 'manual', push: 'manual', publish: 'manual' } }),
      }),
    )
    expect(hasUnsavedWork()).toBe(false)
  })

  it('retains a failed workflow save and saves project inheritance without copying the global policy', async () => {
    const { wrapper, store, tab, vm } = await setup()
    await tab('projects')
    vm.selectedProjectIndex = 0
    await flushPromises()
    const editor = wrapper.findComponent(WorkflowPolicyEditor)
    expect(editor.exists()).toBe(true)
    expect(editor.props('modelValue')).toEqual({ push: 'manual' })
    editor.vm.$emit('update:modelValue', {})
    await flushPromises()
    store.global = { ...store.global, workflowPolicy: { commit: 'manual', push: 'manual', publish: 'manual' } }
    api.mockRejectedValueOnce(new Error('offline'))
    vm.savebarSave()
    await flushPromises()
    expect(hasUnsavedWork()).toBe(true)
    expect(wrapper.getComponent(WorkflowPolicyEditor).props('modelValue')).toEqual({})
    vm.savebarSave()
    await flushPromises()
    expect(api).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/settings/projects/'),
      expect.objectContaining({ body: expect.objectContaining({ workflowPolicy: {} }) }),
    )
    expect(hasUnsavedWork()).toBe(false)
    vm.selectedProjectIndex = 1
    await flushPromises()
    expect(wrapper.getComponent(WorkflowPolicyEditor).props('modelValue')).toEqual({})
    store.projects[0]!.workflowPolicy = { publish: 'manual' }
    vm.applyCopyFrom('/a')
    await flushPromises()
    expect(wrapper.getComponent(WorkflowPolicyEditor).props('modelValue')).toEqual({ publish: 'manual' })
    wrapper.getComponent(WorkflowPolicyEditor).vm.$emit('update:modelValue', {})
    await flushPromises()
    expect(store.projects[0]!.workflowPolicy).toEqual({ publish: 'manual' })
  })

  it('keeps integration secrets across tabs, guards departure, and excludes them from settings saves', async () => {
    const { wrapper, tab, vm } = await setup()
    await tab('notion')
    let integration = wrapper.getComponent(IntegrationConnectionSettings)
    await integration.findAll('input')[0]!.setValue('node')
    await integration.findAll('input')[2]!.setValue('{"TOKEN":"SECRET_DRAFT"}')
    expect(hasUnsavedWork()).toBe(true)
    await tab('sentry')
    expect(wrapper.getComponent(IntegrationConnectionSettings).findAll('input')[0]!.element.value).toBe('')
    await tab('notion')
    integration = wrapper.getComponent(IntegrationConnectionSettings)
    expect(integration.findAll('input')[2]!.element.value).toContain('SECRET_DRAFT')
    await tab('git')
    wrapper
      .getComponent(WorkflowPolicyEditor)
      .vm.$emit('update:modelValue', { commit: 'manual', push: 'manual', publish: 'manual' })
    await flushPromises()
    vm.savebarSave()
    await flushPromises()
    const settingsCalls = api.mock.calls.filter(([url]) => String(url).startsWith('/api/settings/'))
    expect(JSON.stringify(settingsCalls)).not.toContain('SECRET_DRAFT')
    for (let index = 0; index < localStorage.length; index++) {
      expect(localStorage.getItem(localStorage.key(index)!)).not.toContain('SECRET_DRAFT')
    }
    expect(hasUnsavedWork()).toBe(true)
    await tab('notion')
    integration = wrapper.getComponent(IntegrationConnectionSettings)
    api.mockRejectedValueOnce(new Error('SECRET_DRAFT'))
    await integration.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(integration.findAll('input')[2]!.element.value).toContain('SECRET_DRAFT')
    expect(integration.text()).not.toContain('SECRET_DRAFT')
    await integration.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(hasUnsavedWork()).toBe(false)
    await tab('general')
    await tab('notion')
    expect(wrapper.getComponent(IntegrationConnectionSettings).findAll('input')[2]!.element.value).toBe('')
  })
})
