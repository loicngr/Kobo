import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import AskUserQuestionPanel from '../components/AskUserQuestionPanel.vue'
import PermissionRequestPanel from '../components/PermissionRequestPanel.vue'
import QuotaFooter from '../components/QuotaFooter.vue'
import SessionHandoffDialog from '../components/SessionHandoffDialog.vue'
import StartReviewDialog from '../components/StartReviewDialog.vue'
import { EFFORT_OPTION_DEFS_BY_ENGINE } from '../constants/efforts'
import { MODEL_OPTION_DEFS_BY_ENGINE } from '../constants/models'
import { PERMISSION_MODES_BY_ENGINE } from '../constants/permissionModes'
import en from '../i18n/en'
import CreatePage from '../pages/CreatePage.vue'
import SettingsPage from '../pages/SettingsPage.vue'
import WorkspacePage from '../pages/WorkspacePage.vue'
import { useSessionHandoffStore } from '../stores/session-handoff'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'
import { useWorkspaceTemplatesStore } from '../stores/workspace-templates'

const { routeQuery } = vi.hoisted(() => ({ routeQuery: { engine: 'mistral-vibe' } }))
vi.mock('quasar', async (original) => ({
  ...(await original<typeof import('quasar')>()),
  useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, notify: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery, params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../composables/use-tours', () => ({ useTours: () => ({ scheduleAutoRun: vi.fn() }) }))

const stubs = Object.fromEntries(
  [
    'drawer',
    'option-group',
    'btn-dropdown',
    'slider',
    'popup-edit',
    'dialog',
    'card',
    'card-section',
    'card-actions',
    'separator',
    'input',
    'toggle',
    'select',
    'btn',
    'icon',
    'space',
    'tooltip',
    'stepper',
    'step',
    'stepper-navigation',
    'checkbox',
    'radio',
    'linear-progress',
    'menu',
    'expansion-item',
    'page',
    'avatar',
    'banner',
    'btn-toggle',
    'chip',
    'field',
    'item',
    'item-label',
    'item-section',
    'spinner-dots',
    'list',
    'badge',
    'spinner',
  ].map((tag) => [
    `q-${tag}`,
    {
      name: `Q${tag
        .split('-')
        .map((s) => s[0]!.toUpperCase() + s.slice(1))
        .join('')}`,
      props: ['modelValue', 'options', 'disable', 'label', 'loading', 'val', 'prefix', 'hint', 'rules', 'displayValue'],
      emits: ['update:modelValue', 'click'],
      template: '<div @click="$emit(\'click\')"><slot name="header" /><slot /><slot name="navigation" /></div>',
    },
  ]),
)
const global = { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })], stubs }
const workspace = {
  id: 'w',
  engine: 'mistral-vibe',
  model: 'auto',
  reasoningEffort: 'auto',
  agentPermissionMode: 'interactive',
} as Workspace
beforeEach(() => {
  setActivePinia(createPinia())
  routeQuery.engine = 'mistral-vibe'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ available: false, accounts: [] })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('offers native auto and execution-only permissions with safe settings defaults', () => {
  expect(MODEL_OPTION_DEFS_BY_ENGINE['mistral-vibe']?.map((x) => x.value)).toEqual(['auto'])
  expect(EFFORT_OPTION_DEFS_BY_ENGINE['mistral-vibe']?.map((x) => x.value)).toEqual(['auto'])
  expect(PERMISSION_MODES_BY_ENGINE['mistral-vibe']).toEqual(['interactive', 'strict', 'bypass'])
  expect(useSettingsStore().global.defaultPermissionModeByEngine['mistral-vibe']).toBe('interactive')
})

it('requires an explicit supported permission when transferring Plan to Vibe', async () => {
  const view = mount(SessionHandoffDialog, {
    props: {
      modelValue: true,
      workspace: {
        ...workspace,
        engine: 'claude-code',
        model: 'claude-sonnet-5-5',
        reasoningEffort: 'high',
        agentPermissionMode: 'plan',
      },
      sourceSessionId: 's',
      mode: 'switch',
      loading: false,
    },
    global,
  })
  const selects = view.findAllComponents({ name: 'QSelect' })
  selects[0]!.vm.$emit('update:modelValue', 'mistral-vibe')
  await view.vm.$nextTick()
  expect(selects[1]!.props('modelValue')).toBe('auto')
  expect(selects[2]!.props('modelValue')).toBe('auto')
  expect(selects[3]!.props('modelValue')).toBe('plan')
  expect(view.findAllComponents({ name: 'QBtn' }).at(-1)!.props('disable')).toBe(true)
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')).toBeUndefined()
  selects[3]!.vm.$emit('update:modelValue', 'interactive')
  await view.vm.$nextTick()
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
    target: { engine: 'mistral-vibe', agentPermissionMode: 'interactive' },
  })
  view.unmount()
})

it('transfers a Vibe source with existing history and without generating a summary', async () => {
  const view = mount(SessionHandoffDialog, {
    props: { modelValue: true, workspace, sourceSessionId: 's', mode: 'fresh', loading: false },
    global,
  })
  expect(view.findComponent({ name: 'QToggle' }).props()).toMatchObject({ modelValue: false, disable: true })
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({ generateSummary: false, sourceSessionId: 's' })
  view.unmount()
})

it.each(['immediate', 'auto-loop'] as const)('keeps Vibe selectable for a native review (%s)', async (mode) => {
  const view = mount(StartReviewDialog, {
    props: { modelValue: true, workspace, loading: false, canReturnToSession: false, mode },
    global,
  })
  const engines = view.findComponent({ name: 'QSelect' })
  expect(engines.props('options').map((x: { value: string }) => x.value)).toEqual([
    'claude-code',
    'codex',
    'mistral-vibe',
  ])
  expect(engines.props('modelValue')).toBe('mistral-vibe')
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
    engine: 'mistral-vibe',
    newSession: true,
    agentPermissionMode: 'interactive',
  })
  view.unmount()
})

it('does not discover accounts for a viewed Vibe session in a Claude workspace', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [{ ...workspace, engine: 'claude-code' }]
  store.selectedWorkspaceId = 'w'
  store.sessions = [{ id: 's', workspaceId: 'w', engine: 'mistral-vibe' } as never]
  store.selectedSessionId = 's'
  const view = mount(QuotaFooter, { global })
  await flushPromises()
  expect(view.find('[data-action="usage-menu"]').exists()).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  view.unmount()
})

it('disables remembered operations when Vibe metadata is missing', () => {
  const store = useWorkspaceStore()
  store.workspaces = [workspace]
  store.selectedWorkspaceId = 'w'
  vi.spyOn(store, 'peekPending').mockReturnValue({
    kind: 'permission',
    toolCallId: 't',
    toolName: 'bash',
    toolInput: { rawInput: {} },
  } as never)
  const view = mount(PermissionRequestPanel, { props: { workspaceId: 'w' }, global })
  expect(
    view
      .findAllComponents({ name: 'QBtn' })
      .find((x) => x.props('label') === en['permissionRequest.allowOperation'])
      ?.props('disable'),
  ).toBe(true)
  view.unmount()
})

it('renders native text and sends comma-bearing choices as typed selections', async () => {
  const store = useWorkspaceStore()
  vi.spyOn(store, 'peekPending').mockReturnValue({
    kind: 'question',
    toolCallId: 't',
    input: {
      questions: [
        { id: 'text', question: 'Text', freeText: true, options: [], isOther: false, required: true, minLength: 0 },
        {
          id: 'choices',
          question: 'Choices',
          multiSelect: true,
          options: [{ label: 'One, Two' }, { label: 'Three' }],
          isOther: false,
          required: true,
          minItems: 1,
        },
        { id: 'optional', question: 'Optional', freeText: true, options: [], isOther: false, required: false },
      ],
    },
  } as never)
  const submit = vi.spyOn(store, 'submitDeferredAnswer').mockResolvedValue()
  const view = mount(AskUserQuestionPanel, { props: { workspaceId: 'w' }, global })
  expect(view.findAllComponents({ name: 'QInput' })).toHaveLength(2)
  expect(view.findAllComponents({ name: 'QRadio' })).toHaveLength(0)
  view.findAllComponents({ name: 'QCheckbox' })[0]!.vm.$emit('update:modelValue', ['One, Two', 'Three'])
  await view.vm.$nextTick()
  // The optional field is last; advancing must allow the legally empty required string.
  const next = () =>
    view.findAllComponents({ name: 'QBtn' }).find((x) => x.props('label') === en['askUserQuestion.next'])!
  expect(next().props('disable')).toBe(false)
  await next().trigger('click')
  await next().trigger('click')
  await view
    .findAllComponents({ name: 'QBtn' })
    .find((x) => x.props('label') === en['askUserQuestion.submit'])!
    .trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenCalledWith(
    'w',
    { text: '', choices: 'One, Two, Three' },
    't',
    false,
    undefined,
    {
      choices: ['One, Two', 'Three'],
    },
    undefined,
  )
  view.unmount()
})

async function setupCreatePage(engine = 'mistral-vibe', permission?: string, discovery?: () => Promise<Response>) {
  routeQuery.engine = engine
  const settings = useSettingsStore()
  settings.loaded = true
  settings.global.defaultPermissionModeByEngine = {
    'claude-code': 'plan',
    codex: 'plan',
    ...(permission ? { 'mistral-vibe': permission } : {}),
  }
  vi.spyOn(settings, 'fetchSettings').mockResolvedValue()
  vi.spyOn(useWorkspaceTemplatesStore(), 'fetchTemplates').mockResolvedValue()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/api/engines/mistral-vibe/options') && discovery
        ? discovery()
        : Response.json(
            url === '/api/engines'
              ? [
                  { id: 'claude-code', displayName: 'Claude Code' },
                  { id: 'codex', displayName: 'Codex' },
                  { id: 'mistral-vibe', displayName: 'Mistral Vibe' },
                ]
              : [],
          ),
    ),
  )
  const view = shallowMount(CreatePage, {
    global: {
      ...global,
      stubs: { ...stubs, AutoLoopFinalReviewSettings: false },
      renderStubDefaultSlot: true,
      directives: { ripple: {}, 'close-popup': {} },
    },
  })
  await flushPromises()
  return view
}

it('creates a visibly interactive Vibe workspace from setup and preserves native presets', async () => {
  const view = await setupCreatePage()
  await flushPromises()
  const selects = () => view.findAllComponents({ name: 'QSelect' })
  const selected = (label: string) => selects().find((x) => x.props('label') === label)!
  expect(selected(en['engine.select']).props('modelValue')).toBe('mistral-vibe')
  expect(selected(en['agentPermissionMode.label']).props('modelValue')).toBe('interactive')
  expect(
    selected(en['engine.model'])
      .props('options')
      .map((x: { value: string }) => x.value),
  ).toEqual(['auto'])
  expect(view.find('[data-tour="create-comparison"]').exists()).toBe(false)
  const vm = view.vm as unknown as { applyPresetToForm(preset: Record<string, unknown>): Promise<void> }
  await vm.applyPresetToForm({ engine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
  await vm.applyPresetToForm({
    engine: 'mistral-vibe',
    model: 'auto',
    reasoningEffort: 'auto',
    agentPermissionMode: 'strict',
  })
  expect(selected(en['engine.select']).props('modelValue')).toBe('mistral-vibe')
  expect(selected(en['agentPermissionMode.label']).props('modelValue')).toBe('strict')
  expect(selected(en['engine.model']).props('modelValue')).toBe('auto')
  view.unmount()
})

it('omits untouched optional native fields and accepts explicit empty arrays', async () => {
  const store = useWorkspaceStore()
  vi.spyOn(store, 'peekPending').mockReturnValue({
    kind: 'question',
    toolCallId: 't',
    input: {
      questions: [
        {
          id: 'choices',
          question: 'Choices',
          multiSelect: true,
          options: [{ label: 'Three' }],
          isOther: false,
          required: false,
          minItems: 0,
        },
      ],
    },
  } as never)
  const submit = vi.spyOn(store, 'submitDeferredAnswer').mockResolvedValue()
  const view = mount(AskUserQuestionPanel, { props: { workspaceId: 'w' }, global })
  const button = () =>
    view.findAllComponents({ name: 'QBtn' }).find((x) => x.props('label') === en['askUserQuestion.submit'])!
  expect(button().props('disable')).toBe(false)
  await button().trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenLastCalledWith('w', {}, 't', false, undefined, undefined, undefined)
  view.findComponent({ name: 'QCheckbox' }).vm.$emit('update:modelValue', [])
  await view.vm.$nextTick()
  await button().trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenLastCalledWith('w', { choices: '' }, 't', false, undefined, { choices: [] }, undefined)
  view.unmount()
})

it('validates native text bounds and never treats a native value as synthetic Other', async () => {
  const store = useWorkspaceStore()
  vi.spyOn(store, 'peekPending').mockReturnValue({
    kind: 'question',
    toolCallId: 't',
    input: {
      questions: [
        {
          id: 'text',
          question: 'Text',
          freeText: true,
          options: [],
          isOther: false,
          required: true,
          minLength: 2,
          maxLength: 3,
        },
        { id: 'enum', question: 'Enum', options: [{ label: '__KOBO_OTHER__' }], isOther: false, required: true },
      ],
    },
  } as never)
  const submit = vi.spyOn(store, 'submitDeferredAnswer').mockResolvedValue()
  const view = mount(AskUserQuestionPanel, { props: { workspaceId: 'w' }, global })
  const next = () =>
    view.findAllComponents({ name: 'QBtn' }).find((x) => x.props('label') === en['askUserQuestion.next'])!
  expect(next().props('disable')).toBe(true)
  view.findComponent({ name: 'QInput' }).vm.$emit('update:modelValue', 'abcd')
  await view.vm.$nextTick()
  expect(next().props('disable')).toBe(true)
  view.findComponent({ name: 'QInput' }).vm.$emit('update:modelValue', 'abc')
  await view.vm.$nextTick()
  expect(next().props('disable')).toBe(false)
  await next().trigger('click')
  view.findComponent({ name: 'QRadio' }).vm.$emit('update:modelValue', '__KOBO_OTHER__')
  await view.vm.$nextTick()
  expect(view.findAllComponents({ name: 'QInput' })).toHaveLength(1)
  await view
    .findAllComponents({ name: 'QBtn' })
    .find((x) => x.props('label') === en['askUserQuestion.submit'])!
    .trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenCalledWith(
    'w',
    { text: 'abc', enum: '__KOBO_OTHER__' },
    't',
    false,
    undefined,
    undefined,
    undefined,
  )
  view.unmount()
})

it('labels current and historical Mistral sessions without a Claude fallback', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [{ ...workspace, name: 'Vibe workspace', status: 'idle' }]
  store.selectedWorkspaceId = 'w'
  store.sessions = [
    { id: 'current', workspaceId: 'w', engine: 'mistral-vibe', startedAt: new Date().toISOString(), status: 'running' },
    { id: 'old', workspaceId: 'w', engine: 'mistral-vibe', startedAt: new Date().toISOString(), status: 'completed' },
    { id: 'claude', workspaceId: 'w', engine: 'claude-code', startedAt: new Date().toISOString(), status: 'completed' },
  ] as never
  store.selectedSessionId = 'current'
  vi.spyOn(store, 'fetchPendingWakeup').mockResolvedValue()
  vi.spyOn(useSessionHandoffStore(), 'refresh').mockResolvedValue()
  const view = shallowMount(WorkspacePage, {
    global: { ...global, renderStubDefaultSlot: true, directives: { 'close-popup': {} } },
  })
  await flushPromises()
  expect(view.text()).toContain('Mistral Vibe')
  const vm = view.vm as unknown as { sessionOptions: Array<{ value: string; caption: string }> }
  expect(vm.sessionOptions.find((x) => x.value === 'current')?.caption).toContain('Mistral Vibe')
  expect(vm.sessionOptions.find((x) => x.value === 'old')?.caption).toContain('Mistral Vibe')
  expect(vm.sessionOptions.find((x) => x.value === 'claude')?.caption).toContain('Claude Code')
  view.unmount()
})

it('uses historical Claude accounts in a Vibe workspace, then hides them on return to Vibe', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [workspace]
  store.selectedWorkspaceId = 'w'
  store.sessions = [
    { id: 'claude', workspaceId: 'w', engine: 'claude-code' },
    { id: 'vibe', workspaceId: 'w', engine: 'mistral-vibe' },
  ] as never
  const view = mount(QuotaFooter, { global })
  await flushPromises()
  expect(fetch).not.toHaveBeenCalled()
  store.selectedSessionId = 'claude'
  await flushPromises()
  expect(fetch).toHaveBeenCalledWith('/api/usage/claude-code/accounts', expect.any(Object))
  expect(view.find('[data-action="usage-menu"]').exists()).toBe(true)
  const calls = vi.mocked(fetch).mock.calls.length
  store.selectedSessionId = 'vibe'
  await flushPromises()
  expect(view.find('[data-action="usage-menu"]').exists()).toBe(false)
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
  view.unmount()
})

it('accepts an explicitly selected empty native enum value', async () => {
  const store = useWorkspaceStore()
  vi.spyOn(store, 'peekPending').mockReturnValue({
    kind: 'question',
    toolCallId: 't',
    input: {
      questions: [
        {
          id: '__proto__',
          question: 'Value',
          options: [{ label: '' }, { label: 'filled' }],
          isOther: false,
          required: true,
          minLength: 0,
        },
      ],
    },
  } as never)
  const submit = vi.spyOn(store, 'submitDeferredAnswer').mockResolvedValue()
  const view = mount(AskUserQuestionPanel, { props: { workspaceId: 'w' }, global })
  const button = () =>
    view.findAllComponents({ name: 'QBtn' }).find((x) => x.props('label') === en['askUserQuestion.submit'])!
  expect(button().props('disable')).toBe(true)
  view.findAllComponents({ name: 'QRadio' })[0]!.vm.$emit('update:modelValue', '')
  await view.vm.$nextTick()
  expect(button().props('disable')).toBe(false)
  await button().trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenCalledWith(
    'w',
    Object.fromEntries([['__proto__', '']]),
    't',
    false,
    undefined,
    undefined,
    undefined,
  )
  view.unmount()
})

it.each(['interactive', 'bypass'])(
  'preserves an explicit Plan when switching to Vibe with a %s global default',
  async (mode) => {
    const view = await setupCreatePage('claude-code')
    useSettingsStore().global.defaultPermissionModeByEngine['mistral-vibe'] = mode
    const select = (label: string) =>
      view.findAllComponents({ name: 'QSelect' }).find((x) => x.props('label') === label)!
    select(en['agentPermissionMode.label']).vm.$emit('update:modelValue', 'plan')
    await view.vm.$nextTick()
    select(en['engine.select']).vm.$emit('update:modelValue', 'mistral-vibe')
    await view.vm.$nextTick()
    await assertPlanBlocksCreation(view)
    select(en['agentPermissionMode.label']).vm.$emit('update:modelValue', 'interactive')
    await view.vm.$nextTick()
    expect(
      view
        .findAllComponents({ name: 'QBtn' })
        .find((x) => x.props('label') === en['createPage.createWorkspace'])!
        .props('disable'),
    ).toBe(false)
    view.unmount()
  },
)

it.each([{ engine: 'mistral-vibe', agentPermissionMode: 'plan' }, { engine: 'mistral-vibe' }])(
  'preserves explicit or inherited Plan from the native preset %j',
  async (preset) => {
    const view = await setupCreatePage('claude-code')
    const permission = view
      .findAllComponents({ name: 'QSelect' })
      .find((x) => x.props('label') === en['agentPermissionMode.label'])!
    permission.vm.$emit('update:modelValue', 'plan')
    await view.vm.$nextTick()
    const vm = view.vm as unknown as { applyPresetToForm(value: Record<string, unknown>): Promise<void> }
    await vm.applyPresetToForm(preset)
    await assertPlanBlocksCreation(view)
    permission.vm.$emit('update:modelValue', 'strict')
    await view.vm.$nextTick()
    expect(
      view
        .findAllComponents({ name: 'QBtn' })
        .find((x) => x.props('label') === en['createPage.createWorkspace'])!
        .props('disable'),
    ).toBe(false)
    view.unmount()
  },
)

async function assertPlanBlocksCreation(view: ReturnType<typeof shallowMount>) {
  const permission = view
    .findAllComponents({ name: 'QSelect' })
    .find((x) => x.props('label') === en['agentPermissionMode.label'])!
  expect(permission.props('modelValue')).toBeNull()
  expect(permission.props('hint')).toBe(en['createPage.chooseNativePermissionMode'])
  expect(permission.props('displayValue')).toBeUndefined()
  expect(permission.props('rules')[0]()).toBe(en['createPage.chooseNativePermissionMode'])
  expect(permission.props('options').map((option: { value: string }) => option.value)).toEqual([
    'interactive',
    'strict',
    'bypass',
  ])
  expect(view.find('.agent-summary').exists()).toBe(true)
  expect(
    view
      .get('.agent-summary')
      .findAllComponents({ name: 'QChip' })
      .some((chip: { text(): string }) => chip.text() === en['agentPermissionMode.plan']),
  ).toBe(false)
  expect(
    view
      .findAllComponents({ name: 'QBtn' })
      .find((x) => x.props('label') === en['createPage.createWorkspace'])!
      .props('disable'),
  ).toBe(true)
  const create = vi.spyOn(useWorkspaceStore(), 'createWorkspace').mockResolvedValue(workspace)
  const vm = view.vm as unknown as {
    agentPermissionMode: string
    projectPath: string
    branch: string
    description: string
    validate(): unknown
    handleCreate(): Promise<void>
    applyProjectDefaults(path: string): void
  }
  expect(vm.agentPermissionMode).toBe('plan')
  vm.projectPath = '/demo'
  vm.branch = 'main'
  vm.description = 'Keep the plan read only'
  vm.applyProjectDefaults('/demo')
  expect(permission.props('modelValue')).toBeNull()
  expect(vm.validate()).toBeNull()
  await vm.handleCreate()
  expect(create).not.toHaveBeenCalled()
}

it('preserves a global Plan on direct Mistral creation until an explicit native choice', async () => {
  const view = await setupCreatePage('mistral-vibe', 'plan')
  await assertPlanBlocksCreation(view)
  const permission = view
    .findAllComponents({ name: 'QSelect' })
    .find((x) => x.props('label') === en['agentPermissionMode.label'])!
  permission.vm.$emit('update:modelValue', 'interactive')
  await view.vm.$nextTick()
  expect(permission.props('modelValue')).toBe('interactive')
  view.unmount()
})

it('inherits project Plan from a fresh Mistral creation', async () => {
  const view = await setupCreatePage()
  useSettingsStore().projects = [{ path: '/demo', agentPermissionMode: 'plan' } as never]
  const vm = view.vm as unknown as { applyProjectDefaults(path: string): void }
  vm.applyProjectDefaults('/demo')
  await view.vm.$nextTick()
  await assertPlanBlocksCreation(view)
  view.unmount()
})

it.each(['unknown', 'toString', '__proto__'])('falls back for unknown engine query %s', async (engine) => {
  const view = await setupCreatePage(engine)
  expect(
    view
      .findAllComponents({ name: 'QSelect' })
      .find((x) => x.props('label') === en['engine.select'])!
      .props('modelValue'),
  ).toBe('claude-code')
  view.unmount()
})

it('preserves stored Mistral Plan when saving unrelated settings, then saves an explicit native choice', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([])),
  )
  vi.spyOn(useWorkspaceTemplatesStore(), 'fetchTemplates').mockResolvedValue()
  const settings = useSettingsStore()
  settings.loaded = true
  settings.global.defaultPermissionModeByEngine['mistral-vibe'] = 'plan'
  settings.global.defaultModelByEngine['mistral-vibe'] = 'saved-native-alias'
  vi.spyOn(settings, 'fetchSettings').mockResolvedValue()
  vi.spyOn(settings, 'fetchActiveMcpServers').mockResolvedValue()
  vi.spyOn(settings, 'fetchGlobalDefaults').mockResolvedValue({} as never)
  vi.spyOn(settings, 'fetchVoiceModels').mockResolvedValue()
  vi.spyOn(settings, 'fetchVoiceRuntime').mockResolvedValue()
  const save = vi.spyOn(settings, 'updateGlobal').mockResolvedValue()
  const view = shallowMount(SettingsPage, { global: { ...global, directives: { ripple: {}, 'close-popup': {} } } })
  await flushPromises()
  const vm = view.vm as unknown as {
    globalMistralPermissionMode: string
    globalEditorCommand: string
    saveGlobal(): Promise<void>
  }
  expect(vm.globalMistralPermissionMode).toBe('plan')
  vm.globalEditorCommand = 'editor --wait'
  await vm.saveGlobal()
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      defaultModelByEngine: expect.objectContaining({ 'mistral-vibe': 'saved-native-alias' }),
      defaultPermissionModeByEngine: expect.objectContaining({ 'mistral-vibe': 'plan' }),
    }),
  )
  vm.globalMistralPermissionMode = 'strict'
  await vm.saveGlobal()
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultPermissionModeByEngine: expect.objectContaining({ 'mistral-vibe': 'strict' }) }),
  )
  view.unmount()
})

it.each(['claude-code', 'codex'])('keeps Plan visible and supported for %s creation', async (engine) => {
  const view = await setupCreatePage(engine)
  const permission = view
    .findAllComponents({ name: 'QSelect' })
    .find((x) => x.props('label') === en['agentPermissionMode.label'])!
  expect(permission.props('modelValue')).toBe('plan')
  expect(
    view
      .get('.agent-summary')
      .findAllComponents({ name: 'QChip' })
      .some((chip: { text(): string }) => chip.text() === en['agentPermissionMode.plan']),
  ).toBe(true)
  expect(
    view
      .findAllComponents({ name: 'QBtn' })
      .find((x) => x.props('label') === en['createPage.createWorkspace'])!
      .props('disable'),
  ).toBe(false)
  view.unmount()
})

it('preserves native presets and independent brainstorm thinking choices', async () => {
  const view = await setupCreatePage()
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    const model = url.searchParams.get('model') ?? 'iteration'
    const values = model === 'brainstorm' ? ['off', 'max'] : ['off', 'high']
    return Response.json({
      model: {
        currentValue: model,
        options: ['iteration', 'brainstorm'].map((value) => ({ value, name: `Native ${value}` })),
      },
      thinking: { currentValue: 'off', options: values.map((value) => ({ value, name: `Native ${value}` })) },
    })
  })
  const vm = view.vm as unknown as { applyPresetToForm(preset: Record<string, unknown>): Promise<void> }
  await vm.applyPresetToForm({
    engine: 'mistral-vibe',
    model: 'iteration',
    reasoningEffort: 'off',
    agentPermissionMode: 'interactive',
    autoLoop: true,
    brainstormModel: 'brainstorm',
    brainstormReasoningEffort: 'max',
  })
  await flushPromises()
  const selected = (label: string) =>
    view.findAllComponents({ name: 'QSelect' }).find((item) => item.props('label') === label)!
  expect(selected(en['engine.model']).props('modelValue')).toBe('iteration')
  expect(selected(en['engine.model']).props('options')).toContainEqual(
    expect.objectContaining({ label: 'Native iteration' }),
  )
  expect(selected(en['autoLoop.brainstormModelPrefix']).props('modelValue')).toBe('brainstorm')
  expect(
    view.get('[data-tour="create-brainstorm"]').findAllComponents({ name: 'QSelect' })[1]!.props('modelValue'),
  ).toBe('max')
  expect(
    view
      .get('[data-tour="create-brainstorm"]')
      .findAllComponents({ name: 'QSelect' })[1]!
      .props('options')
      .map((item: { value: string }) => item.value),
  ).toEqual(['auto', 'off', 'max'])
  view.unmount()
})

it.each(['failed', 'unavailable'])(
  'retains a saved native brainstorm alias during mount and %s discovery',
  async (outcome) => {
    let complete!: (response: Response) => void
    let fail!: (error: Error) => void
    const pending = new Promise<Response>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    localStorage.setItem(
      'kobo:create-page-prefs',
      JSON.stringify({ autoLoop: true, brainstormModel: 'saved-brainstorm' }),
    )
    useSettingsStore().global.defaultModelByEngine['mistral-vibe'] = 'saved-iteration'
    const view = await setupCreatePage('mistral-vibe', 'interactive', () =>
      pending.then((response) => response.clone()),
    )
    try {
      const brainstorm = () => view.get('[data-tour="create-brainstorm"]').findAllComponents({ name: 'QSelect' })[0]!
      expect(brainstorm().props('modelValue')).toBe('saved-brainstorm')
      if (outcome === 'failed') fail(new Error('Discovery unavailable'))
      else
        complete(
          Response.json({
            model: { currentValue: 'other', options: [{ value: 'other', name: 'Other' }] },
            thinking: { currentValue: 'off', options: [{ value: 'off', name: 'Off' }] },
          }),
        )
      await flushPromises()
      expect(brainstorm().props('modelValue')).toBe('saved-brainstorm')
      expect(brainstorm().props('options')).toContainEqual(
        expect.objectContaining({ value: 'saved-brainstorm', disable: true }),
      )
    } finally {
      view.unmount()
      localStorage.removeItem('kobo:create-page-prefs')
    }
  },
)

it.each(['failed', 'unavailable'])(
  'retains an enabled saved native final reviewer during mount and %s discovery',
  async (outcome) => {
    let complete!: (response: Response) => void
    let fail!: (error: Error) => void
    const pending = new Promise<Response>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    const configuration = {
      engine: 'mistral-vibe',
      model: 'saved-reviewer',
      reasoningEffort: 'off',
      additionalInstructions: 'Check migrations',
    }
    localStorage.setItem(
      'kobo:create-page-prefs',
      JSON.stringify({ autoLoop: true, autoLoopFinalReview: configuration }),
    )
    const view = await setupCreatePage('mistral-vibe', 'interactive', () =>
      pending.then((response) => response.clone()),
    )
    try {
      const reviewer = () => view.getComponent({ name: 'AutoLoopFinalReviewSettings' })
      expect(reviewer().props('modelValue')).toEqual(configuration)
      expect(reviewer().getComponent({ name: 'QToggle' }).props('modelValue')).toBe(true)
      expect(view.text()).toContain(en['engine.mistralOptionsLoading'])
      if (outcome === 'failed') fail(new Error('Discovery unavailable'))
      else
        complete(
          Response.json({
            model: { currentValue: 'other', options: [{ value: 'other', name: 'Other' }] },
            thinking: { currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] },
          }),
        )
      await flushPromises()
      expect(reviewer().props('modelValue')).toEqual(configuration)
      expect(reviewer().getComponent({ name: 'QToggle' }).props('modelValue')).toBe(true)
      view
        .findAllComponents({ name: 'QSelect' })
        .find((item) => item.props('label') === en['engine.effort'])!
        .vm.$emit('update:modelValue', 'off')
      await flushPromises()
      expect(JSON.parse(localStorage.getItem('kobo:create-page-prefs')!).autoLoopFinalReview).toEqual(configuration)
    } finally {
      view.unmount()
      localStorage.removeItem('kobo:create-page-prefs')
    }
  },
)

it.each(['plan', 'bypass'] as const)(
  'resets native manual reviews to Interactive on every open from %s',
  async (sourceMode) => {
    const view = mount(StartReviewDialog, {
      props: {
        modelValue: true,
        workspace: { ...workspace, agentPermissionMode: sourceMode },
        loading: false,
        canReturnToSession: true,
      },
      global,
    })
    const permission = () => view.findAllComponents({ name: 'QSelect' })[3]!
    expect(permission().props('modelValue')).toBe('interactive')
    expect(
      permission()
        .props('options')
        .map((o: { value: string }) => o.value),
    ).toEqual(['interactive', 'strict', 'bypass'])
    permission().vm.$emit('update:modelValue', 'strict')
    await view.vm.$nextTick()
    view.findAllComponents({ name: 'QToggle' })[1]!.vm.$emit('update:modelValue', true)
    await view.vm.$nextTick()
    expect(permission().props()).toMatchObject({ modelValue: 'strict', disable: false })
    expect(view.text()).not.toContain(en['review.readOnlyForced'])
    expect(view.text()).toContain(en['review.mistralNativeHint'])
    await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
    expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
      agentPermissionMode: 'strict',
      newSession: true,
      returnToSession: true,
    })
    await view.setProps({ modelValue: false })
    await view.setProps({ modelValue: true })
    expect(permission().props('modelValue')).toBe('interactive')
    view.unmount()
  },
)
it('discovers native final-review options using creation project context and preserves off on submit', async () => {
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      model: { currentValue: 'native-alias', options: [{ value: 'native-alias', name: 'Native reviewer' }] },
      thinking: {
        currentValue: 'off',
        options: [
          { value: 'off', name: 'Native off' },
          { value: 'max', name: 'Native max' },
        ],
      },
    }),
  )
  const view = mount(StartReviewDialog, {
    props: {
      modelValue: true,
      workspace: { ...workspace, id: 'create' },
      projectPath: '/selected/project',
      loading: false,
      canReturnToSession: true,
      mode: 'auto-loop',
      scheduledConfiguration: {
        engine: 'mistral-vibe',
        model: 'native-alias',
        reasoningEffort: 'off',
        additionalInstructions: 'Check all',
      },
    },
    global,
  })
  await flushPromises()
  const selects = view.findAllComponents({ name: 'QSelect' })
  expect(selects.map((s) => s.props('modelValue'))).toEqual(['mistral-vibe', 'native-alias', 'off', 'interactive'])
  expect(selects[3]!.props('disable')).toBe(true)
  expect(selects[1]!.props('options')).toContainEqual(
    expect.objectContaining({ value: 'native-alias', label: 'Native reviewer' }),
  )
  expect(selects[2]!.props('options')).toContainEqual(expect.objectContaining({ value: 'off', label: 'Native off' }))
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'))
  expect(urls.length).toBeGreaterThan(0)
  expect(
    urls.every(
      (url) => url.searchParams.get('projectPath') === '/selected/project' && !url.searchParams.has('workspaceId'),
    ),
  ).toBe(true)
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
    model: 'native-alias',
    reasoningEffort: 'off',
    agentPermissionMode: 'interactive',
  })
  await view.setProps({ modelValue: false })
  const count = vi.mocked(fetch).mock.calls.length
  await view.setProps({ projectPath: '/changed/project' })
  expect(vi.mocked(fetch).mock.calls).toHaveLength(count)
  view.unmount()
})
it('ignores a late native review catalogue after changing engine', async () => {
  let resolve!: (response: Response) => void
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const view = mount(StartReviewDialog, {
    props: { modelValue: true, workspace, loading: false, canReturnToSession: true },
    global,
  })
  view.findComponent({ name: 'QSelect' }).vm.$emit('update:modelValue', 'codex')
  await view.vm.$nextTick()
  resolve(
    Response.json({
      model: { currentValue: 'late', options: [{ value: 'late', name: 'Stale native' }] },
      thinking: { currentValue: 'off', options: [{ value: 'off', name: 'Off' }] },
    }),
  )
  await flushPromises()
  expect(view.findAllComponents({ name: 'QSelect' })[1]!.props('options')).not.toContainEqual(
    expect.objectContaining({ value: 'late' }),
  )
  view.unmount()
})

it('loads native aliases while rendering the actual permission field for unsupported Plan', async () => {
  useSettingsStore().global.defaultModelByEngine['mistral-vibe'] = 'mistral-medium-3.5'
  const view = await setupCreatePage('mistral-vibe', 'plan', async () =>
    Response.json({
      model: {
        currentValue: 'mistral-medium-3.5',
        options: [{ value: 'mistral-medium-3.5', name: 'Mistral Medium 3.5' }],
      },
      thinking: {
        currentValue: 'off',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'high', name: 'High' },
        ],
      },
    }),
  )
  const model = view.findAllComponents({ name: 'QSelect' }).find((x) => x.props('label') === en['engine.model'])!
  expect(model.props('modelValue')).toBe('mistral-medium-3.5')
  expect(model.props('options')).toContainEqual(
    expect.objectContaining({ value: 'mistral-medium-3.5', label: 'Mistral Medium 3.5', disable: false }),
  )
  expect((view.vm as unknown as { agentPermissionMode: string }).agentPermissionMode).toBe('plan')
  expect(
    view
      .findAllComponents({ name: 'QBtn' })
      .find((x) => x.props('label') === en['createPage.createWorkspace'])!
      .props('disable'),
  ).toBe(true)
  const permission = view
    .findAllComponents({ name: 'QSelect' })
    .find((x) => x.props('label') === en['agentPermissionMode.label'])!
  const { QSelect, Quasar } = await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
  const field = mount(QSelect, {
    props: {
      ...permission.props(),
      optionValue: 'value',
      optionLabel: 'label',
      emitValue: true,
      mapOptions: true,
      outlined: true,
      stackLabel: true,
      optionDisable: (view.vm as unknown as { isOptionDisabled: (option: unknown) => boolean }).isOptionDisabled,
    },
    global: { plugins: [Quasar] },
  })
  expect(field.find('.q-field__label').text()).toBe(en['agentPermissionMode.label'])
  expect(field.text()).toContain(en['createPage.chooseNativePermissionMode'])
  field.unmount()
  view.unmount()
})

it('shows native model and effort loading until discovery settles without changing saved choices', async () => {
  let complete!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    complete = resolve
  })
  localStorage.setItem(
    'kobo:create-page-prefs',
    JSON.stringify({ autoLoop: true, brainstormModel: 'saved-brainstorm' }),
  )
  useSettingsStore().global.defaultModelByEngine['mistral-vibe'] = 'saved-main'
  const view = await setupCreatePage('mistral-vibe', 'interactive', () => pending.then((response) => response.clone()))
  try {
    const fields = () =>
      view
        .findAllComponents({ name: 'QSelect' })
        .filter((field) =>
          [
            en['engine.model'],
            en['engine.effort'],
            en['autoLoop.brainstormModelPrefix'],
            en['autoLoop.brainstormReasoningPrefix'],
          ].includes(field.props('label')),
        )
    expect(fields()).toHaveLength(4)
    expect(fields().map((field) => field.props('loading'))).toEqual([true, true, true, true])
    complete(
      Response.json({
        model: {
          currentValue: 'saved-main',
          options: [
            { value: 'saved-main', name: 'Saved main' },
            { value: 'saved-brainstorm', name: 'Saved brainstorm' },
          ],
        },
        thinking: { currentValue: 'off', options: [{ value: 'off', name: 'Off' }] },
      }),
    )
    await flushPromises()
    expect(fields().map((field) => field.props('loading'))).toEqual([false, false, false, false])
    expect(fields()[0]!.props('modelValue')).toBe('saved-main')
    expect(fields()[2]!.props('modelValue')).toBe('saved-brainstorm')
  } finally {
    view.unmount()
    localStorage.removeItem('kobo:create-page-prefs')
  }
})
