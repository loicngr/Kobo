import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceBulkActions from '../components/WorkspaceBulkActions.vue'
import en from '../i18n/en'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

const mocks = vi.hoisted(() => ({ notify: vi.fn(), dialog: vi.fn(), request: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('quasar', () => ({ useQuasar: () => mocks }))
vi.mock('vue-router', () => ({ useRouter: () => ({ currentRoute: { value: { name: 'workspace' } }, push: vi.fn() }) }))
vi.mock('../stores/websocket', () => ({ useWebSocketStore: () => ({ unsubscribe: mocks.unsubscribe }) }))
vi.mock('../utils/api', () => ({ apiFetchOk: mocks.request }))
vi.mock('../utils/export-workspace-events', () => ({ exportWorkspaceEvents: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.dialog.mockReturnValue({ onOk: vi.fn() })
})
function setup() {
  const workspaces = [1, 2].map(
    (n) =>
      ({ id: `ws-${n}`, name: `Workspace ${n}`, workingBranch: `feature/${n}`, sourceBranch: 'main' }) as Workspace,
  )
  const store = useWorkspaceStore()
  store.workspaces = workspaces
  const wrapper = mount(WorkspaceBulkActions, {
    props: { workspaces },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      directives: { 'close-popup': {} },
      stubs: {
        StartReviewDialog: {
          name: 'StartReviewDialog',
          props: ['modelValue', 'workspace', 'loading', 'parallel'],
          emits: ['submit', 'update:modelValue'],
          template: '<div><slot name="context" /></div>',
        },
        QBtn: { template: '<button><slot /></button>' },
        QMenu: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button class="action"><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QIcon: true,
      },
    },
  })
  return { wrapper, store }
}
it('continues after a workspace fails and reports only completed IDs', async () => {
  const { wrapper, store } = setup()
  const archive = vi
    .spyOn(store, 'archiveWorkspace')
    .mockRejectedValueOnce(new Error('busy'))
    .mockResolvedValueOnce(store.workspaces[1]!)
  await wrapper.findAll('.action')[0]!.trigger('click')
  await flushPromises()
  expect(archive.mock.calls).toEqual([['ws-1'], ['ws-2']])
  expect(wrapper.emitted('completed')).toEqual([[['ws-2']]])
  expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: 'Workspace 1: busy' }))
})
it('requires exact branch names for deletion and freezes the confirmed targets', async () => {
  const { wrapper, store } = setup()
  const remove = vi.spyOn(store, 'deleteWorkspace').mockResolvedValue({ warnings: [] })
  await wrapper.findAll('.action')[2]!.trigger('click')
  const options = mocks.dialog.mock.calls[0]![0]
  expect(options.prompt.isValid('feature/1\nfeature/2')).toBe(true)
  expect(options.prompt.isValid('2')).toBe(false)
  expect(remove).not.toHaveBeenCalled()
  await wrapper.setProps({ workspaces: [store.workspaces[0]!] })
  mocks.dialog.mock.results[0]!.value.onOk.mock.calls[0][0]()
  await flushPromises()
  expect(remove.mock.calls).toEqual([
    ['ws-1', { confirmationBranch: 'feature/1', expectedArchivedAt: null, expectedSprintId: null }],
    ['ws-2', { confirmationBranch: 'feature/2', expectedArchivedAt: null, expectedSprintId: null }],
  ])
})
it('calls the existing git endpoint for every selected workspace', async () => {
  mocks.request.mockResolvedValue(undefined)
  const { wrapper, store } = setup()
  vi.spyOn(store, 'fetchGitStats').mockResolvedValue({} as never)
  await wrapper.findAll('.action')[5]!.trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls).toEqual([
    ['/api/workspaces/ws-1/fetch', { method: 'POST' }],
    ['/api/workspaces/ws-2/fetch', { method: 'POST' }],
  ])
})

it.each([
  [6, 'pull', false],
  [7, 'merge', true],
  [8, 'rebase', true],
  [4, 'run-setup-script', true],
] as const)('runs action %s through its existing endpoint after any confirmation', async (index, endpoint, confirm) => {
  const { wrapper, store } = setup()
  vi.spyOn(store, 'fetchGitStats').mockResolvedValue({} as never)
  await wrapper.findAll('.action')[index]!.trigger('click')
  if (confirm) {
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.dialog.mock.results[0]!.value.onOk.mock.calls[0][0]()
  }
  await flushPromises()
  expect(mocks.request.mock.calls).toEqual([
    [`/api/workspaces/ws-1/${endpoint}`, { method: 'POST' }],
    [`/api/workspaces/ws-2/${endpoint}`, { method: 'POST' }],
  ])
})
it('rejects changed branches after confirmation without deleting them', async () => {
  const { wrapper, store } = setup()
  const remove = vi.spyOn(store, 'deleteWorkspace').mockResolvedValue({ warnings: [] })
  await wrapper.findAll('.action')[2]!.trigger('click')
  store.workspaces[0]!.workingBranch = 'another-branch'
  mocks.dialog.mock.results[0]!.value.onOk.mock.calls[0][0]()
  await flushPromises()
  expect(remove.mock.calls).toEqual([
    ['ws-2', { confirmationBranch: 'feature/2', expectedArchivedAt: null, expectedSprintId: null }],
  ])
})
it('reports purge refusals and cleanup warnings', async () => {
  const { wrapper, store } = setup()
  vi.spyOn(store, 'purgeWorktree')
    .mockResolvedValueOnce({ ok: false, error: 'dirty worktree' })
    .mockResolvedValueOnce({ ok: true, warnings: ['cleanup failed'] })
  await wrapper.findAll('.action')[1]!.trigger('click')
  mocks.dialog.mock.results[0]!.value.onOk.mock.calls[0][0]()
  await flushPromises()
  expect(wrapper.emitted('completed')).toEqual([[['ws-2']]])
  expect(mocks.dialog).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: 'Workspace 1: dirty worktree\nWorkspace 2: cleanup failed' }),
  )
})

it('skips a workspace that became busy before setup confirmation', async () => {
  const { wrapper, store } = setup()
  await wrapper.findAll('.action')[4]!.trigger('click')
  store.workspaces[0]!.status = 'executing'
  mocks.dialog.mock.results[0]!.value.onOk.mock.calls[0][0]()
  await flushPromises()
  expect(mocks.request.mock.calls).toEqual([['/api/workspaces/ws-2/run-setup-script', { method: 'POST' }]])
  expect(wrapper.emitted('completed')).toEqual([[['ws-2']]])
})

it('launches reviews with the shared configuration on the captured selection and continues after errors', async () => {
  const { wrapper, store } = setup()
  await wrapper.findAll('.action')[9]!.trigger('click')
  const dialog = wrapper.findComponent({ name: 'StartReviewDialog' })
  expect(dialog.props('modelValue')).toBe(true)
  expect(dialog.props('workspace').id).toBe('ws-1')
  expect(mocks.request).not.toHaveBeenCalled()
  await wrapper.setProps({ workspaces: [store.workspaces[1]!] })
  const payload = {
    engine: 'codex',
    model: 'auto',
    reasoningEffort: 'high',
    agentPermissionMode: 'plan',
    additionalInstructions: 'Read only, no tests',
    newSession: true,
    returnToSession: false,
  }
  mocks.request.mockRejectedValueOnce(new Error('Review already running')).mockResolvedValueOnce(undefined)
  dialog.vm.$emit('submit', payload)
  await flushPromises()
  expect(mocks.request.mock.calls).toEqual([
    [
      '/api/workspaces/ws-1/start-review',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    ],
    [
      '/api/workspaces/ws-2/start-review',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    ],
  ])
  expect(wrapper.emitted('completed')).toEqual([[['ws-2']]])
  expect(dialog.props('modelValue')).toBe(false)
})
it('cancels the review configuration without sending requests', async () => {
  const { wrapper, store } = setup()
  store.workspaces[0]!.status = 'executing'
  await wrapper.findAll('.action')[9]!.trigger('click')
  const dialog = wrapper.findComponent({ name: 'StartReviewDialog' })
  expect(dialog.props('parallel')).toBe(true)
  dialog.vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(mocks.request).not.toHaveBeenCalled()
})
