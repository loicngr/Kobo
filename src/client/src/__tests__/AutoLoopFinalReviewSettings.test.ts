import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import AutoLoopFinalReviewSettings from '../components/AutoLoopFinalReviewSettings.vue'
import StartReviewDialog from '../components/StartReviewDialog.vue'
import en from '../i18n/en'

const workspace = {
  id: 'w',
  engine: 'codex',
  model: 'auto',
  reasoningEffort: 'high',
  agentPermissionMode: 'bypass' as const,
}
const configuration = {
  engine: 'codex',
  model: 'auto',
  reasoningEffort: 'high',
  additionalInstructions: 'Check migrations',
}
beforeEach(() => setActivePinia(createPinia()))
function panel() {
  return shallowMount(AutoLoopFinalReviewSettings, {
    props: { modelValue: null, workspace },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QToggle: { name: 'QToggle', props: ['modelValue', 'disable', 'label'], template: '<div />' } },
    },
  })
}

it('saves settings only after the user completes the dialog, and can disable them', async () => {
  const view = panel()
  view.findComponent({ name: 'QToggle' }).vm.$emit('update:modelValue', true)
  await view.vm.$nextTick()
  const dialog = view.findComponent(StartReviewDialog)
  expect(dialog.props('modelValue')).toBe(true)
  expect(view.emitted('update:modelValue')).toBeUndefined()
  dialog.vm.$emit('submit', { ...configuration, newSession: true, returnToSession: true, agentPermissionMode: 'plan' })
  await view.vm.$nextTick()
  expect(view.emitted('update:modelValue')?.[0]).toEqual([configuration])
  expect(dialog.props('modelValue')).toBe(false)
  await view.setProps({ modelValue: configuration })
  view.findComponent({ name: 'QToggle' }).vm.$emit('update:modelValue', false)
  expect(view.emitted('update:modelValue')?.[1]).toEqual([null])
  view.unmount()
})

it('closes unsaved settings when the selected workspace changes', async () => {
  const view = panel()
  view.findComponent({ name: 'QToggle' }).vm.$emit('update:modelValue', true)
  await view.setProps({ workspace: { ...workspace, id: 'other' } })
  expect(view.findComponent(StartReviewDialog).props('modelValue')).toBe(false)
  expect(view.emitted('update:modelValue')).toBeUndefined()
  view.unmount()
})

it('retains submitted instructions when the parent cannot persist them', async () => {
  const view = panel()
  const dialog = view.findComponent(StartReviewDialog)
  dialog.vm.$emit('submit', { ...configuration, newSession: true, returnToSession: true, agentPermissionMode: 'plan' })
  await view.setProps({ loading: true })
  // Failed PATCH: the persisted modelValue remains null.
  await view.setProps({ loading: false })
  view.findComponent({ name: 'QToggle' }).vm.$emit('update:modelValue', true)
  await view.vm.$nextTick()
  expect(dialog.props('modelValue')).toBe(true)
  expect(dialog.props('scheduledConfiguration')).toEqual(configuration)
  view.unmount()
})
