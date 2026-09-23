import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import IntegrationConnectionSettings from '../components/IntegrationConnectionSettings.vue'
import en from '../i18n/en'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../utils/api', () => ({ apiFetch: api }))
const Input = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup:
    (p, { emit }) =>
    () =>
      h('input', {
        value: p.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
})
const Button = defineComponent({
  props: ['label', 'disable'],
  emits: ['click'],
  setup:
    (p, { emit }) =>
    () =>
      h('button', { disabled: p.disable, onClick: () => emit('click') }, p.label),
})
const Expansion = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
function setup() {
  return mount(IntegrationConnectionSettings, {
    props: { integration: 'notion' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QInput: Input, QBtn: Button, QExpansionItem: Expansion },
    },
  })
}
beforeEach(() => vi.resetAllMocks())
it('reads only status, replaces the full connection and clears local credential fields', async () => {
  api.mockResolvedValue({ configured: true })
  const wrapper = setup()
  await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/integrations/notion')
  expect(wrapper.findAll('input').map((input) => input.element.value)).toEqual(['', '', ''])
  expect(wrapper.findAll('input')[1].attributes('placeholder')).toContain('@notionhq/notion-mcp-server')
  expect(wrapper.findAll('input')[2].attributes('placeholder')).toContain('NOTION_TOKEN')
  await wrapper.findAll('input')[0].setValue('node')
  await wrapper.findAll('input')[1].setValue('["server.js"]')
  await wrapper.findAll('input')[2].setValue('{"TOKEN":"SECRET_CANARY"}')
  await wrapper.findAll('button')[0].trigger('click')
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith('/api/integrations/notion', {
    method: 'PUT',
    body: { command: 'node', args: ['server.js'], env: { TOKEN: 'SECRET_CANARY' } },
  })
  expect(wrapper.findAll('input')[2].element.value).toBe('')
  api.mockResolvedValue({ configured: false })
  await wrapper.findAll('button')[1].trigger('click')
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith('/api/integrations/notion', { method: 'PUT', body: 'null' })
})
it('keeps edits after failure and displays no provider error or secret', async () => {
  api.mockResolvedValueOnce({ configured: false }).mockRejectedValue(new Error('SECRET_CANARY'))
  const wrapper = setup()
  await flushPromises()
  await wrapper.findAll('input')[0].setValue('node')
  await wrapper.findAll('button')[0].trigger('click')
  await flushPromises()
  expect(wrapper.findAll('input')[0].element.value).toBe('node')
  expect(api).toHaveBeenLastCalledWith('/api/integrations/notion', {
    method: 'PUT',
    body: { command: 'node', args: [], env: {} },
  })
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('SECRET_CANARY')
})
