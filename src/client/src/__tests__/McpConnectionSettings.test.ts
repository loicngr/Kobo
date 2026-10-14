import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import McpConnectionSettings from '../components/McpConnectionSettings.vue'
import en from '../i18n/en'

const { api, copy } = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn() }))
vi.mock('../utils/api', () => ({ apiFetch: api }))
vi.mock('quasar', () => ({ copyToClipboard: copy, useQuasar: () => ({ notify: vi.fn() }) }))
const Button = defineComponent({
  props: ['label', 'disable'],
  emits: ['click'],
  setup:
    (props, { emit }) =>
    () =>
      h('button', { disabled: props.disable, onClick: () => emit('click') }, props.label),
})
const Field = defineComponent({
  props: ['label', 'modelValue'],
  emits: ['update:modelValue'],
  setup: () => () => h('input'),
})
const InputField = defineComponent({ ...Field, name: 'InputField' })
const ToggleField = defineComponent({ ...Field, name: 'ToggleField' })
const Pass = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})
beforeEach(() => {
  vi.clearAllMocks()
  copy.mockResolvedValue(undefined)
  api.mockImplementation(async (url, options) => {
    if (url === '/api/settings/mcp')
      return {
        localUrl: 'http://127.0.0.1:3000/api/mcp',
        lanUrls: [],
        networkEnabled: false,
        behindProxy: false,
        proxyHostname: null,
        localRequiresToken: true,
        stdio: null,
      }
    if (url === '/api/workspaces') return [{ id: 'a', name: 'Workspace A' }]
    if (options?.method === 'POST')
      return {
        token: 'dedicated-secret',
        credential: {
          id: 'key-1',
          name: 'Client',
          allWorkspaces: false,
          workspaceIds: ['a'],
          tools: ['get_workspace'],
          expiresAt: null,
        },
      }
    if (options?.method === 'DELETE') return { ok: true }
    return {
      credentials: [],
      tools: [
        { name: 'get_workspace', readOnly: true },
        { name: 'send_workspace_message', readOnly: false },
      ],
    }
  })
})
it('copies only newly issued MCP credentials and never the administrator token', async () => {
  const wrapper = mount(McpConnectionSettings, {
    props: { token: 'administrator-secret', networkEnabled: false, behindProxy: false },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtn: Button,
        QInput: InputField,
        QSelect: Field,
        QToggle: ToggleField,
        QList: Pass,
        QItem: Pass,
        QItemSection: Pass,
        QItemLabel: Pass,
        QBanner: Pass,
        QSpinner: Pass,
      },
    },
  })
  await flushPromises()
  const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)!
  expect(button(en['settings.mcp.copyWithToken']).attributes('disabled')).toBeDefined()
  expect(wrapper.html()).not.toContain('administrator-secret')
  wrapper
    .findAllComponents(InputField)
    .find((item) => item.props('label') === en['settings.mcp.keyName'])!
    .vm.$emit('update:modelValue', 'Client')
  wrapper
    .findAllComponents(Field)
    .find((item) => item.props('label') === en['settings.mcp.workspaces'])!
    .vm.$emit('update:modelValue', ['a'])
  await flushPromises()
  await button(en['settings.mcp.createKey']).trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledWith(
    '/api/mcp-credentials',
    expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ allWorkspaces: false, workspaceIds: ['a'], tools: ['get_workspace'] }),
    }),
  )
  await button(en['settings.mcp.copyWithToken']).trigger('click')
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('Bearer dedicated-secret'))
  expect(JSON.stringify(copy.mock.calls)).not.toContain('administrator-secret')
  await button(en['settings.mcp.revoke']).trigger('click')
  await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/mcp-credentials/key-1', { method: 'DELETE' })
  expect(button(en['settings.mcp.copyWithToken']).attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
