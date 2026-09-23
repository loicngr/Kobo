import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceList from '../components/WorkspaceList.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('quasar')>()),
  useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, notify: vi.fn() }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const makeWorkspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  projectPath: '/tmp/project',
  sourceBranch: 'main',
  workingBranch: 'feature/test',
  status: 'idle',
  notionUrl: null,
  sentryUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-5',
  engine: 'claude-code',
  reasoningEffort: 'normal',
  agentPermissionMode: 'bypass',
  devServerStatus: 'stopped',
  hasUnread: false,
  archivedAt: null,
  favoritedAt: null,
  prWatchDisabledAt: null,
  tags: [],
  description: null,
  agentDescription: null,
  initialPrompt: null,
  prChangesDismissedAt: null,
  prCiFailureDismissedAt: null,
  worktreePurgedAt: null,
  worktreePurgeRestoreData: null,
  comparisonId: null,
  autoLoop: false,
  autoLoopReady: false,
  noProgressStreak: 0,
  worktreePath: '/tmp/project/.worktrees/feature/test',
  worktreeOwned: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useWorkspaceStore()
  for (const method of [
    'fetchWorkspaces',
    'fetchArchivedWorkspaces',
    'fetchPrSnapshots',
    'fetchAutoLoopStates',
    'fetchWorkspacesInfo',
  ] as const) {
    vi.spyOn(store, method).mockResolvedValue(undefined)
  }
  vi.spyOn(useSettingsStore(), 'fetchSettings').mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
})

it.each(['enter', 'click'])(
  'requires the working branch to delete via %s, accepts paste whitespace, and resets for another workspace',
  async (action) => {
    const store = useWorkspaceStore()
    const workspace = makeWorkspace({ name: 'Long workspace title with curly apostrophe ’ and trailing space ' })
    store.workspaces = [workspace]
    const remove = vi.spyOn(store, 'deleteWorkspace').mockResolvedValue({ warnings: [] })
    wrapper = shallowMount(WorkspaceList, {
      global: {
        plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
        renderStubDefaultSlot: true,
        stubs: {
          'q-badge': { name: 'QBadge', template: '<div><slot /></div>' },
          'q-btn': { name: 'QBtn', template: '<div><slot /></div>' },
          'q-card': { name: 'QCard', template: '<div><slot /></div>' },
          'q-card-actions': { name: 'QCardActions', template: '<div><slot /></div>' },
          'q-card-section': { name: 'QCardSection', template: '<div><slot /></div>' },
          'q-checkbox': { name: 'QCheckbox', template: '<div><slot /></div>' },
          'q-dialog': { name: 'QDialog', template: '<div><slot /></div>' },
          'q-icon': { name: 'QIcon', template: '<div><slot /></div>' },
          'q-input': { name: 'QInput', template: '<div><slot /></div>' },
          'q-separator': { name: 'QSeparator', template: '<div><slot /></div>' },
          'q-tooltip': { name: 'QTooltip', template: '<div><slot /></div>' },
        },
      },
    })
    await flushPromises()
    const card = wrapper.findComponent({ name: 'WorkspaceCard' })
    card.vm.$emit('delete', workspace, new Event('click'))
    await wrapper.vm.$nextTick()
    const dialog = wrapper.findComponent({ name: 'QDialog' })
    const input = dialog.findComponent({ name: 'QInput' })
    const button = dialog.findAllComponents({ name: 'QBtn' }).at(-1)!
    expect(dialog.text()).toContain(workspace.workingBranch)
    expect(input.attributes('placeholder')).toBe(workspace.workingBranch)
    expect(button.attributes('disable')).toBe('true')
    for (const invalid of [workspace.name, workspace.sourceBranch, 'FEATURE/test', 'feature/wrong']) {
      input.vm.$emit('update:modelValue', invalid)
      await wrapper.vm.$nextTick()
      expect(button.attributes('disable')).toBe('true')
      await input.trigger('keyup.enter')
      expect(remove).not.toHaveBeenCalled()
    }
    input.vm.$emit('update:modelValue', `  ${workspace.workingBranch} \n`)
    await wrapper.vm.$nextTick()
    expect(button.attributes('disable')).toBe('false')
    if (action === 'enter') await input.trigger('keyup.enter')
    else await button.trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledExactlyOnceWith(workspace.id, { deleteLocalBranch: true, deleteRemoteBranch: false })
    card.vm.$emit('delete', makeWorkspace({ id: 'ws-2', workingBranch: 'feature/second' }), new Event('click'))
    await wrapper.vm.$nextTick()
    expect(button.attributes('disable')).toBe('true')
  },
)
