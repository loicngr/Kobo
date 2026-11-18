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

it('shows a selection scope label and ticks every recipient again when the reset key changes', async () => {
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)' })
  expect(wrapper.text()).toContain('Selection (3)')
  await wrapper.get('[data-recipient="one"] input').setValue(false)
  await wrapper.get('[data-test="tags"]').setValue(['ui'])
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(1)
  await wrapper.setProps({ resetKey: 1 })
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(3)
  expect(wrapper.findAll('[data-recipient] input').every((input) => (input.element as HTMLInputElement).checked)).toBe(
    true,
  )
  wrapper.unmount()
})
it('does not show the scope label over a recovered request receipt', async () => {
  sessionStorage.setItem(
    'kobo:group-message-request',
    JSON.stringify({ requestId: 'r-1', workspaceIds: ['one'], content: 'hello' }),
  )
  vi.mocked(apiFetch).mockResolvedValue({ id: 'r-1', createdAt: '', complete: true, recipients: [] })
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)' })
  await flushPromises()
  expect(wrapper.find('[data-recipient]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Selection (3)')
  expect(apiFetch).not.toHaveBeenCalledWith('/api/workspace-messages', expect.objectContaining({ method: 'POST' }))
  wrapper.unmount()
})

const STORED = JSON.stringify({ requestId: 'r-1', workspaceIds: ['one'], content: 'hello' })
const caption = en['groupMessage.selectionPending']
it('explains that a stored completed receipt hides the selection, then shows the selection once dismissed', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockResolvedValue({ id: 'r-1', createdAt: '', complete: true, recipients: [] })
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)', fromSelection: true })
  await flushPromises()
  expect(wrapper.text()).toContain(caption)
  expect(wrapper.find('[data-recipient]').exists()).toBe(false)
  expect(wrapper.find('textarea').exists()).toBe(false)
  const dismiss = wrapper.findAll('button').find((b) => b.text() === en['groupMessage.newMessage'])!
  await dismiss.trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain(caption)
  expect(wrapper.text()).toContain('Selection (3)')
  expect(wrapper.findAll('[data-recipient]')).toHaveLength(3)
  expect(wrapper.findAll('[data-recipient] input').every((i) => (i.element as HTMLInputElement).checked)).toBe(true)
  wrapper.unmount()
})
it('keeps an unfinished stored request untouched when opened from a selection', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockResolvedValue({ id: 'r-1', createdAt: '', complete: false, recipients: [] })
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)', fromSelection: true })
  await flushPromises()
  expect(wrapper.text()).toContain(caption)
  expect(wrapper.find('[data-recipient]').exists()).toBe(false)
  expect(wrapper.findAll('button').some((b) => b.text() === en['groupMessage.newMessage'])).toBe(false)
  expect(sessionStorage.getItem('kobo:group-message-request')).toBe(STORED)
  expect(apiFetch).not.toHaveBeenCalledWith('/api/workspace-messages', expect.objectContaining({ method: 'POST' }))
  wrapper.unmount()
})
it('shows no caption over a stored receipt for a megaphone opening', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockResolvedValue({ id: 'r-1', createdAt: '', complete: true, recipients: [] })
  const wrapper = setup()
  await flushPromises()
  expect(wrapper.text()).not.toContain(caption)
  wrapper.unmount()
})
it('keeps the typed draft when the reset key changes', async () => {
  const wrapper = setup()
  await wrapper.get('textarea').setValue('my draft')
  await wrapper.setProps({ resetKey: 1, fromSelection: true })
  expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('my draft')
  wrapper.unmount()
})
it('retains ticks and filters across openings that do not bump the reset key', async () => {
  const wrapper = setup()
  await wrapper.get('[data-recipient="one"] input').setValue(false)
  await wrapper.get('[data-test="tags"]').setValue(['api'])
  await wrapper.setProps({ modelValue: false })
  await wrapper.setProps({ modelValue: true, workspaces: [...workspaces], scope: 'All' })
  expect(wrapper.findAll('[data-recipient]').map((r) => r.attributes('data-recipient'))).toEqual(['one', 'three'])
  expect((wrapper.get('[data-recipient="one"] input').element as HTMLInputElement).checked).toBe(false)
  wrapper.unmount()
})

function receiptOf(ids: string[]) {
  return async (_url: string, options?: { body?: unknown }) => {
    const body = (options?.body ?? { requestId: 'r-1' }) as { requestId: string }
    return {
      id: body.requestId,
      createdAt: '',
      complete: true,
      recipients: ids.map((workspaceId) => ({
        workspaceId,
        name: workspaceId,
        delivery: 'immediate',
        state: 'queued',
      })),
    }
  }
}
async function sendFrom(wrapper: ReturnType<typeof setup>) {
  await wrapper.get('textarea').setValue('go')
  await wrapper.get('[data-test="send"]').trigger('click')
  await flushPromises()
}
it('shows no caption on the receipt of a message sent from a selection without any stored request', async () => {
  vi.mocked(apiFetch).mockImplementation(receiptOf(['one', 'two', 'three']) as never)
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)', fromSelection: true, resetKey: 1 })
  expect(wrapper.text()).not.toContain(caption)
  await sendFrom(wrapper)
  expect(wrapper.find('[data-result]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain(caption)
  wrapper.unmount()
})
it('shows the caption only on the receipt that was pending at opening, not after dismissing and sending', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockImplementation(receiptOf(['one']) as never)
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)', fromSelection: true })
  await flushPromises()
  expect(wrapper.text()).toContain(caption)
  await wrapper
    .findAll('button')
    .find((b) => b.text() === en['groupMessage.newMessage'])!
    .trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain(caption)
  await sendFrom(wrapper)
  expect(wrapper.find('[data-result]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain(caption)
  wrapper.unmount()
})
it('follows the source of each opening when a stored request is left undismissed', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockImplementation(receiptOf(['one']) as never)
  const wrapper = setup()
  await wrapper.setProps({ scope: 'Selection (3)', fromSelection: true, resetKey: 1 })
  await flushPromises()
  expect(wrapper.text()).toContain(caption)
  await wrapper.setProps({ modelValue: false })
  await wrapper.setProps({ modelValue: true, fromSelection: false, scope: 'All' })
  await flushPromises()
  expect(wrapper.text()).not.toContain(caption)
  await wrapper.setProps({ modelValue: false })
  await wrapper.setProps({ modelValue: true, fromSelection: true, scope: 'Selection (3)', resetKey: 2 })
  await flushPromises()
  expect(wrapper.text()).toContain(caption)
  wrapper.unmount()
})
it('evaluates the caption from the request restored at mount', async () => {
  sessionStorage.setItem('kobo:group-message-request', STORED)
  vi.mocked(apiFetch).mockImplementation(receiptOf(['one']) as never)
  const fromSelection = mount(WorkspaceGroupMessageDialog, {
    props: { modelValue: true, workspaces, scope: 'Selection (3)', fromSelection: true },
    global: { stubs, plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  await flushPromises()
  expect(fromSelection.text()).toContain(caption)
  fromSelection.unmount()
})
