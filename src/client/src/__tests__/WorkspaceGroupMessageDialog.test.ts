import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceGroupMessageDialog from '../components/WorkspaceGroupMessageDialog.vue'
import en from '../i18n/en'
import { useDevServerStore } from '../stores/dev-server'
import { useSettingsStore } from '../stores/settings'
import { apiFetch } from '../utils/api'

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }))
const box = { template: '<div><slot /></div>' }
const stubs = {
  QDialog: box,
  QCard: box,
  QCardSection: box,
  QCardActions: box,
  QSeparator: true,
  QBtn: { props: ['label', 'disable'], template: '<button :disabled="disable"><slot />{{ label }}</button>' },
  QCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template: `<label><input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', !modelValue)" />{{ label }}</label>`,
  },
  QInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<textarea :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
  },
  QSelect: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<select multiple @change="$emit('update:modelValue', Array.from($event.target.selectedOptions).map(o => o.value))"><option v-for="o in options" :key="o.value || o" :value="o.value || o">{{ o.label || o }}</option></select>`,
  },
}
const workspaces = [
  { id: 'one', name: 'One', tags: ['api'], status: 'idle', autoLoop: false, archivedAt: null, worktreePurgedAt: null },
  {
    id: 'two',
    name: 'Two',
    tags: ['ui'],
    status: 'executing',
    autoLoop: true,
    archivedAt: null,
    worktreePurgedAt: null,
  },
  {
    id: 'three',
    name: 'Three',
    tags: ['api'],
    status: 'executing',
    autoLoop: false,
    archivedAt: null,
    worktreePurgedAt: null,
  },
  { id: 'archived', name: 'Archived', tags: [], status: 'idle', archivedAt: 'yesterday', worktreePurgedAt: null },
]
function setup() {
  return mount(WorkspaceGroupMessageDialog, {
    props: { modelValue: true, workspaces },
    global: { stubs, plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
}
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  vi.resetAllMocks()
})
it('offers saved catalogue tags even without any tagged recipients, and updates after settings load', async () => {
  const wrapper = setup()
  await wrapper.setProps({ workspaces: [workspaces[0]!].map((w) => ({ ...w, tags: [] })) })
  useSettingsStore().global.tags = ['bug', 'feature', 'bug']
  await wrapper.vm.$nextTick()
  expect(wrapper.findAll('[data-test="tags"] option').map((option) => option.text())).toEqual(['bug', 'feature'])
  await wrapper.get('[data-test="tags"]').setValue(['bug'])
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(0)
  wrapper.unmount()
})
it('combines tag and status filters and excludes archived workspaces', async () => {
  const wrapper = setup()
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(3)
  await wrapper.get('[data-test="tags"]').setValue(['api'])
  await wrapper.get('[data-test="statuses"]').setValue(['executing'])
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(1)
  expect(wrapper.get('[data-recipient]').text()).toContain('Three')
  wrapper.unmount()
})
it('selects only running dev servers and reacts to live server status changes', async () => {
  const wrapper = setup()
  await wrapper.setProps({
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      devServerStatus: workspace.id === 'one' ? 'running' : 'stopped',
    })),
  })
  await wrapper.get('[data-test="dev-server-running"] input').setValue(true)
  expect(wrapper.findAll('[data-recipient]').map((item) => item.attributes('data-recipient'))).toEqual(['one'])
  await wrapper.get('[data-test="tags"]').setValue(['ui'])
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(0)
  const devServers = useDevServerStore()
  const status = { instanceName: '', projectName: '', httpPort: '', url: '', containers: [] }
  devServers.updateFromWsEvent('two', { ...status, status: 'starting' })
  await wrapper.vm.$nextTick()
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(0)
  devServers.updateFromWsEvent('two', { ...status, status: 'running' })
  await wrapper.vm.$nextTick()
  expect(wrapper.findAll('[data-recipient]').map((item) => item.attributes('data-recipient'))).toEqual(['two'])
  devServers.updateFromWsEvent('two', { ...status, status: 'stopped' })
  await wrapper.vm.$nextTick()
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(0)
  await wrapper.get('[data-test="dev-server-running"] input').setValue(false)
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(1)
  wrapper.unmount()
})
it('sends only checked recipients and displays individual outcomes', async () => {
  vi.mocked(apiFetch).mockImplementationOnce(async (_url, options) => {
    const body = options!.body as { requestId: string }
    return {
      id: body.requestId,
      createdAt: '',
      complete: true,
      recipients: [
        { workspaceId: 'two', name: 'Two', delivery: 'next_iteration', state: 'queued' },
        { workspaceId: 'three', name: 'Three', delivery: 'immediate', state: 'rejected', error: 'Unavailable' },
      ],
    }
  })
  const wrapper = setup()
  await wrapper.get('[data-recipient="one"] input').setValue(false)
  await wrapper.get('textarea').setValue('Please check the tests')
  await wrapper.get('[data-test="send"]').trigger('click')
  await flushPromises()
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/workspace-messages',
    expect.objectContaining({ body: expect.objectContaining({ workspaceIds: ['two', 'three'] }) }),
  )
  expect(wrapper.text()).toContain('Unavailable')
  expect(wrapper.findAll('[data-result]')).toHaveLength(2)
  wrapper.unmount()
})
