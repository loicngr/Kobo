import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import StartReviewDialog from '../components/StartReviewDialog.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'

const workspace = {
  id: 'ws-1',
  engine: 'claude-code',
  model: 'claude-opus-4-7',
  reasoningEffort: 'high',
  agentPermissionMode: 'bypass' as const,
}
beforeEach(() => setActivePinia(createPinia()))
function mountDialog() {
  const stubs = Object.fromEntries(
    ['dialog', 'card', 'card-section', 'card-actions', 'separator', 'input', 'toggle', 'select', 'btn'].map((tag) => [
      `q-${tag}`,
      {
        name: `Q${tag
          .split('-')
          .map((s) => s[0]!.toUpperCase() + s.slice(1))
          .join('')}`,
        props: ['modelValue', 'options', 'disable', 'label', 'loading'],
        template: '<div><slot /></div>',
      },
    ]),
  )
  return shallowMount(StartReviewDialog, {
    props: { modelValue: true, loading: false, workspace, canReturnToSession: true },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })], stubs },
  })
}

it('starts with the workspace configuration and keeps the current session by default', async () => {
  const view = mountDialog()
  const selects = view.findAllComponents({ name: 'QSelect' })
  expect(selects.map((s) => s.props('modelValue'))).toEqual(['claude-code', 'claude-opus-4-7', 'high', 'bypass'])
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toEqual({
    engine: workspace.engine,
    model: workspace.model,
    reasoningEffort: 'high',
    agentPermissionMode: 'bypass',
    additionalInstructions: '',
    newSession: false,
    returnToSession: false,
  })
  view.unmount()
})

it('switches catalogues, forces a fresh session, and allows an explicit return with a summary', async () => {
  useSettingsStore().global.defaultModelByEngine.codex = 'gpt-5.4'
  const view = mountDialog()
  const engine = view.findAllComponents({ name: 'QSelect' })[0]!
  engine.vm.$emit('update:modelValue', 'codex')
  await view.vm.$nextTick()
  const selects = view.findAllComponents({ name: 'QSelect' })
  expect(selects[1]!.props('modelValue')).toBe('gpt-5.4')
  expect(selects[1]!.props('options').every((o: { value: string }) => !o.value.startsWith('claude-'))).toBe(true)
  const toggles = view.findAllComponents({ name: 'QToggle' })
  expect(toggles[0]!.props()).toMatchObject({ modelValue: true, disable: true })
  expect(toggles[1]!.props('modelValue')).toBe(false)
  toggles[1]!.vm.$emit('update:modelValue', true)
  await view.vm.$nextTick()
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
    engine: 'codex',
    model: 'gpt-5.4',
    newSession: true,
    returnToSession: true,
  })
  view.unmount()
})

it.each([1, 2, 3])('forces a new session when configuration field %i changes', async (field) => {
  const view = mountDialog()
  view
    .findAllComponents({ name: 'QSelect' })
    [field]!.vm.$emit('update:modelValue', ['unused', 'claude-sonnet-4-6', 'xhigh', 'strict'][field])
  await view.vm.$nextTick()
  expect(view.findAllComponents({ name: 'QToggle' })[0]!.props()).toMatchObject({ modelValue: true, disable: true })
  view.unmount()
})

it('resets on reopen and prevents duplicate submission while loading', async () => {
  const view = mountDialog()
  view.findAllComponents({ name: 'QSelect' })[0]!.vm.$emit('update:modelValue', 'codex')
  await view.setProps({ modelValue: false })
  await view.setProps({ modelValue: true })
  expect(view.findAllComponents({ name: 'QSelect' })[0]!.props('modelValue')).toBe('claude-code')
  expect(view.findAllComponents({ name: 'QToggle' })[0]!.props('modelValue')).toBe(false)
  await view.setProps({ loading: true })
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')).toBeUndefined()
  view.unmount()
})

it('requires a new session when the running model differs from the workspace default', async () => {
  const view = mountDialog()
  await view.setProps({ currentSession: { engine: 'claude-code', model: 'claude-sonnet-4-6' } })
  expect(view.findAllComponents({ name: 'QToggle' })[0]!.props()).toMatchObject({ modelValue: true, disable: true })
  view.unmount()
})

it('preserves review settings and instructions when polling refreshes the same workspace', async () => {
  const view = mountDialog()
  const selects = view.findAllComponents({ name: 'QSelect' })
  selects[0]!.vm.$emit('update:modelValue', 'codex')
  await view.vm.$nextTick()
  selects[1]!.vm.$emit('update:modelValue', 'gpt-6-astra')
  selects[2]!.vm.$emit('update:modelValue', 'high')
  selects[3]!.vm.$emit('update:modelValue', 'strict')
  view.findComponent({ name: 'QInput' }).vm.$emit('update:modelValue', 'Check session handling')
  view.findAllComponents({ name: 'QToggle' })[1]!.vm.$emit('update:modelValue', true)
  await view.vm.$nextTick()

  await view.setProps({ workspace: { ...workspace } })

  expect(selects.map((s) => s.props('modelValue'))).toEqual(['codex', 'gpt-6-astra', 'high', 'strict'])
  expect(view.findComponent({ name: 'QInput' }).props('modelValue')).toBe('Check session handling')
  expect(view.findAllComponents({ name: 'QToggle' })[1]!.props('modelValue')).toBe(true)
  await view.findAllComponents({ name: 'QBtn' }).at(-1)!.trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toEqual({
    engine: 'codex',
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    agentPermissionMode: 'strict',
    additionalInstructions: 'Check session handling',
    newSession: true,
    returnToSession: true,
  })
  view.unmount()
})

it('preserves a manually requested new session during polling but resets for another workspace', async () => {
  const view = mountDialog()
  view.findAllComponents({ name: 'QToggle' })[0]!.vm.$emit('update:modelValue', true)
  await view.setProps({ workspace: { ...workspace } })
  expect(view.findAllComponents({ name: 'QToggle' })[0]!.props('modelValue')).toBe(true)

  await view.setProps({ workspace: { ...workspace, id: 'ws-2', model: 'claude-sonnet-4-6' } })
  expect(view.findAllComponents({ name: 'QSelect' })[1]!.props('modelValue')).toBe('claude-sonnet-4-6')
  expect(view.findAllComponents({ name: 'QToggle' })[0]!.props('modelValue')).toBe(false)
  view.unmount()
})
