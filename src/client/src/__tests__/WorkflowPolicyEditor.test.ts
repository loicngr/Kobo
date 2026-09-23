import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import WorkflowPolicyEditor from '../components/WorkflowPolicyEditor.vue'
import en from '../i18n/en'

const Select = defineComponent({
  props: ['modelValue', 'options', 'label'],
  emits: ['update:modelValue'],
  template: '<div />',
})
describe('workflow policy editor', () => {
  it('edits actions independently and can restore inheritance', () => {
    const wrapper = mount(WorkflowPolicyEditor, {
      props: { modelValue: { commit: 'manual', push: 'automatic' }, inherit: true },
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })], stubs: { QSelect: Select } },
    })
    const selectors = wrapper.findAllComponents(Select)
    expect(selectors).toHaveLength(3)
    selectors[2]!.vm.$emit('update:modelValue', 'automatic')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      { commit: 'manual', push: 'automatic', publish: 'automatic' },
    ])
    selectors[0]!.vm.$emit('update:modelValue', '')
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([{ push: 'automatic' }])
    expect(wrapper.text()).toContain('never authorizes merging')
  })
})
