import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { MANUAL_WORKFLOW_POLICY, WORKFLOW_ACTIONS, type WorkflowPolicy } from '../../../shared/workflow-policy'
import WorkspaceToolbarSelectors from '../components/WorkspaceToolbarSelectors.vue'
import en from '../i18n/en'

vi.mock('src/components/AutoLoopChip.vue', () => ({
  default: defineComponent({ setup: () => () => h('div') }),
}))

const Select = defineComponent({
  props: ['modelValue', 'options', 'label', 'disable'],
  emits: ['update:modelValue'],
  setup:
    (p, { emit }) =>
    () =>
      h(
        'select',
        {
          disabled: p.disable,
          value: p.modelValue,
          onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
        },
        (p.options as Array<{ label: string; value: string }>).map((option) =>
          h('option', { value: option.value }, option.label),
        ),
      ),
})
const Passthrough = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})

const globalOptions = {
  plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
  stubs: {
    QItem: Passthrough,
    QItemSection: Passthrough,
    QItemLabel: Passthrough,
    QSelect: Select,
    QIcon: true,
    QTooltip: true,
    QBtn: true,
    QMenu: true,
    QList: Passthrough,
    QSeparator: true,
  },
}

function props(policy: WorkflowPolicy, workflowLocked: boolean, section: 'configuration' | 'session') {
  return {
    section,
    sessions: [],
    sessionOptions: [],
    permissionModeOptions: [{ label: 'Bypass', value: 'bypass' }],
    modelOptions: [{ label: 'Auto', value: 'auto' }],
    reasoningOptions: [{ label: 'Medium', value: 'medium' }],
    pendingSpawnChanges: new Set<'model' | 'reasoningEffort' | 'agentPermissionMode'>(),
    creatingSession: false,
    canDeleteSession: () => false,
    workflowPolicy: policy,
    workflowLocked,
    permissionMode: 'bypass' as const,
    model: 'auto',
    reasoningEffort: 'medium',
  }
}

function setup(
  policy: WorkflowPolicy = { ...MANUAL_WORKFLOW_POLICY },
  workflowLocked = false,
  section: 'configuration' | 'session' = 'configuration',
) {
  return mount(WorkspaceToolbarSelectors, { props: props(policy, workflowLocked, section), global: globalOptions })
}

beforeEach(() => setActivePinia(createPinia()))

it('renders one selector per Git workflow action', () => {
  const wrapper = setup()
  for (const action of WORKFLOW_ACTIONS) {
    expect(wrapper.find(`[data-test="workflow-${action}"]`).exists(), action).toBe(true)
  }
})

it('reports the picked mode for the right action', async () => {
  const wrapper = setup()
  const select = wrapper.find('[data-test="workflow-push"]')
  ;(select.element as HTMLSelectElement).value = 'automatic'
  await select.trigger('change')
  expect(wrapper.emitted('updateWorkflow')).toEqual([['push', 'automatic']])
})

it('shows the stored mode of each action', () => {
  const wrapper = setup({ commit: 'automatic', push: 'manual', publish: 'automatic' })
  expect((wrapper.find('[data-test="workflow-commit"]').element as HTMLSelectElement).value).toBe('automatic')
  expect((wrapper.find('[data-test="workflow-push"]').element as HTMLSelectElement).value).toBe('manual')
})

// The backend answers 409 while a controller is alive, so the selectors say so
// up front rather than letting the click fail.
it('disables every selector while an agent is running', () => {
  const wrapper = setup({ ...MANUAL_WORKFLOW_POLICY }, true)
  for (const action of WORKFLOW_ACTIONS) {
    expect(wrapper.find(`[data-test="workflow-${action}"]`).attributes('disabled'), action).toBeDefined()
  }
})

it('leaves the selectors out of the session menu', () => {
  expect(
    setup({ ...MANUAL_WORKFLOW_POLICY }, false, 'session')
      .find('[data-test="workflow-commit"]')
      .exists(),
  ).toBe(false)
})
