import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { DEFAULT_MEMORY_LIMITS } from '../../../shared/memory-limits'
import MemoryLimitsEditor from '../components/memory/MemoryLimitsEditor.vue'
import fr from '../i18n/fr'

const global = {
  plugins: [createI18n({ legacy: false, locale: 'fr', messages: { fr } })],
  stubs: { QBtn: { template: '<button @click="$emit(\'click\')"><slot /></button>' } },
}
describe('MemoryLimitsEditor', () => {
  it('edits the parent draft and restores defaults without saving implicitly', async () => {
    const wrapper = mount(MemoryLimitsEditor, { props: { modelValue: { ...DEFAULT_MEMORY_LIMITS } }, global })
    expect(wrapper.findAll('input')).toHaveLength(12)
    await wrapper.get('input[name="conversationTokens"]').setValue(9000)
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([{ ...DEFAULT_MEMORY_LIMITS, conversationTokens: 9000 }])
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([DEFAULT_MEMORY_LIMITS])
  })
  it('shows an accessible error when the default page exceeds its ceiling', () => {
    const wrapper = mount(MemoryLimitsEditor, {
      props: { modelValue: { ...DEFAULT_MEMORY_LIMITS, pageMaxSize: 1 } },
      global,
    })
    expect(wrapper.get('[role="alert"]').text()).toBe(fr['memory.limits.invalid'])
  })
})
