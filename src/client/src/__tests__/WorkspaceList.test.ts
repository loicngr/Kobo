import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceList from '../components/WorkspaceList.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { ALL_SPRINTS, useSprintStore } from '../stores/sprints'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

vi.mock('quasar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('quasar')>()),
  useQuasar: () => ({ screen: { lt: { sm: false, md: false } }, platform: { has: { touch: false } }, notify: vi.fn() }),
}))
const { push, replace, currentRoute } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  currentRoute: { value: { name: 'workspace', params: {} as { id?: string }, query: {} as Record<string, string> } },
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push, replace, currentRoute }),
}))

const makeWorkspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  sprintId: null,
  slackChannelId: null,
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
  push.mockReset().mockResolvedValue(undefined)
  replace.mockReset().mockResolvedValue(undefined)
  currentRoute.value = { name: 'workspace', params: {}, query: {} }
  sessionStorage.removeItem('kobo:active-sprint')
  vi.spyOn(useSprintStore(), 'fetchSprints').mockResolvedValue(undefined)
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
  useSettingsStore().loaded = true
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  localStorage.removeItem('kobo:tag-filter')
})

function mountList() {
  return shallowMount(WorkspaceList, mountOptions())
}

function mountOptions() {
  return {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      renderStubDefaultSlot: true,
      stubs: {
        'q-tabs': { name: 'QTabs', template: '<div><slot /></div>' },
        'q-tab': { name: 'QTab', template: '<div />' },
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
  }
}

it.each(['enter', 'click'])(
  'requires the working branch to delete via %s, accepts paste whitespace, and resets for another workspace',
  async (action) => {
    const store = useWorkspaceStore()
    const workspace = makeWorkspace({ name: 'Long workspace title with curly apostrophe ’ and trailing space ' })
    store.workspaces = [workspace]
    const remove = vi.spyOn(store, 'deleteWorkspace').mockResolvedValue({ warnings: [] })
    wrapper = mountList()
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

it('filters live workspaces by the stored tag selection (OR)', async () => {
  localStorage.setItem('kobo:tag-filter', JSON.stringify(['docs', 'back']))
  const store = useWorkspaceStore()
  store.workspaces = [
    makeWorkspace({ id: 'docs', tags: ['docs'] }),
    makeWorkspace({ id: 'back', tags: ['back'] }),
    makeWorkspace({ id: 'none', tags: [] }),
  ]
  wrapper = mountList()
  await flushPromises()
  const shown = wrapper.findAllComponents({ name: 'WorkspaceCard' }).map((c) => c.props('workspace').id)
  expect(shown).toEqual(expect.arrayContaining(['docs', 'back']))
  expect(shown).not.toContain('none')
  const menu = wrapper.findComponent({ name: 'WorkspaceTagFilterMenu' })
  expect(menu.props('tags')).toEqual(expect.arrayContaining([{ tag: 'docs', count: 1 }]))
})

it('ignores a stored tag that no workspace carries any more', async () => {
  localStorage.setItem('kobo:tag-filter', JSON.stringify(['ghost']))
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace({ id: 'a', tags: [] }), makeWorkspace({ id: 'b', tags: ['docs'] })]
  store.archivedLoaded = true
  wrapper = mountList()
  await flushPromises()
  const shown = wrapper.findAllComponents({ name: 'WorkspaceCard' }).map((c) => c.props('workspace').id)
  expect(shown).toEqual(expect.arrayContaining(['a', 'b']))
  expect(localStorage.getItem('kobo:tag-filter')).toBe('[]')
})

it('keeps a tag only carried by archived workspaces until they are loaded', async () => {
  // Live workspaces load first, archived ones right after: pruning in between
  // dropped archived-only tags from the remembered selection.
  localStorage.setItem('kobo:tag-filter', JSON.stringify(['legacy']))
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace({ id: 'live', tags: [] })]
  wrapper = mountList()
  await flushPromises()
  expect(localStorage.getItem('kobo:tag-filter')).toBe('["legacy"]')
})

it('keeps the remembered selection while no workspace is loaded yet', async () => {
  localStorage.setItem('kobo:tag-filter', JSON.stringify(['docs']))
  wrapper = mountList()
  await flushPromises()
  expect(localStorage.getItem('kobo:tag-filter')).toBe('["docs"]')
})

it('offers catalogue tags and preserves a configured selection while settings are loading', async () => {
  localStorage.setItem('kobo:tag-filter', JSON.stringify(['bug']))
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace({ tags: [] })]
  store.archivedLoaded = true
  const settings = useSettingsStore()
  settings.loaded = false
  wrapper = mountList()
  await flushPromises()
  expect(localStorage.getItem('kobo:tag-filter')).toBe('["bug"]')
  settings.global.tags = ['bug', 'feature']
  settings.loaded = true
  await flushPromises()
  const menu = wrapper.findComponent({ name: 'WorkspaceTagFilterMenu' })
  expect(menu.props('tags')).toEqual([
    { tag: 'bug', count: 0 },
    { tag: 'feature', count: 0 },
  ])
  expect(menu.props('modelValue')).toEqual(['bug'])
  expect(wrapper.findAllComponents({ name: 'WorkspaceCard' })).toHaveLength(0)
})

it('starts independent loads together and polls active workspaces before archives/settings finish', async () => {
  const store = useWorkspaceStore()
  let resolveWorkspaces!: () => void
  let resolveArchives!: () => void
  let resolveSettings!: () => void
  vi.mocked(store.fetchWorkspaces).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveWorkspaces = resolve
      }),
  )
  vi.mocked(store.fetchArchivedWorkspaces).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveArchives = resolve
      }),
  )
  vi.mocked(useSettingsStore().fetchSettings).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveSettings = resolve
      }),
  )
  wrapper = mountList()
  expect(store.fetchWorkspaces).toHaveBeenCalled()
  expect(store.fetchArchivedWorkspaces).toHaveBeenCalled()
  expect(useSettingsStore().fetchSettings).toHaveBeenCalled()
  resolveWorkspaces()
  await flushPromises()
  expect(store.fetchWorkspacesInfo).toHaveBeenCalled()
  resolveArchives()
  resolveSettings()
  await flushPromises()
})

it('does not resume initialization or install polling after unmount during loading', async () => {
  const store = useWorkspaceStore()
  let resolveWorkspaces!: () => void
  vi.mocked(store.fetchWorkspaces).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveWorkspaces = resolve
      }),
  )
  wrapper = mountList()
  wrapper.unmount()
  wrapper = undefined
  resolveWorkspaces()
  await flushPromises()
  expect(store.fetchWorkspacesInfo).not.toHaveBeenCalled()
})

it('filters the drawer by sprint without changing the global workspace list', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's1' }), makeWorkspace({ id: 'two', sprintId: 's2' })]
  sprints.active = 's1'
  wrapper = mountList()
  await flushPromises()
  expect(wrapper.findAllComponents({ name: 'WorkspaceCard' }).map((card) => card.props('workspace').id)).toEqual([
    'one',
  ])
  expect(store.workspaces.map((workspace) => workspace.id)).toEqual(['one', 'two'])
})

describe('drawer-muted workspaces', () => {
  const muted = { muteBrowser: false, muteSound: false, muteToast: false, muteDrawer: true, keepQuestions: false }
  const labels = () => wrapper!.findAllComponents({ name: 'QTab' }).map((tab) => tab.attributes('label'))

  it('is not counted in the sprint tab attention counts', async () => {
    const store = useWorkspaceStore()
    store.workspaces = [
      makeWorkspace({ id: 'loud', status: 'error' }),
      makeWorkspace({ id: 'quiet', status: 'error', notificationPrefs: muted }),
    ]
    wrapper = mountList()
    await flushPromises()
    expect(labels()[0]).toMatch(/\(1\)$/)
  })

  describe('border colour passed to the card', () => {
    const ciFailed = {
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      base: 'main',
      reviewDecision: null,
      author: { login: 'a' },
      assignees: [],
      reviewers: [],
      labels: [],
      ci: { rollup: 'FAILURE', checks: [] },
      updatedAt: '',
      unresolvedReviewThreadsCount: 0,
      readyToMerge: false,
    }
    const borderOf = async (prefs?: typeof muted) => {
      const store = useWorkspaceStore()
      store.workspaces = [makeWorkspace({ id: 'w', status: 'idle', ...(prefs ? { notificationPrefs: prefs } : {}) })]
      store.prSnapshots = { w: ciFailed as never }
      wrapper = mountList()
      await flushPromises()
      const card = wrapper.findComponent({ name: 'WorkspaceCard' })
      return [card.props('variant'), card.props('borderColor')]
    }

    it('keeps the attention border when unmuted', async () => {
      expect(await borderOf()).toEqual(['attention', 'var(--kobo-danger)'])
    })

    it('uses the ordinary border of its group when muted', async () => {
      expect(await borderOf(muted)).toEqual(['idle', 'var(--kobo-border-strong)'])
    })
  })

  it('is grouped by activity, never in the attention variant', async () => {
    const store = useWorkspaceStore()
    store.workspaces = [makeWorkspace({ id: 'quiet', status: 'error', notificationPrefs: muted })]
    wrapper = mountList()
    await flushPromises()
    const cards = wrapper.findAllComponents({ name: 'WorkspaceCard' })
    expect(cards.map((card) => [card.props('workspace').id, card.props('variant')])).toEqual([['quiet', 'idle']])
    expect(labels()[0]).not.toMatch(/\(\d+\)$/)
  })
})

it('changes the sprint only after the router accepts returning home', async () => {
  const sprints = useSprintStore()
  wrapper = mountList()
  await flushPromises()
  push.mockResolvedValueOnce({ type: 4 })
  wrapper.findComponent({ name: 'QTabs' }).vm.$emit('update:modelValue', 's1')
  await flushPromises()
  expect(sprints.active).toBe(ALL_SPRINTS)
  push.mockResolvedValueOnce(undefined)
  wrapper.findComponent({ name: 'QTabs' }).vm.$emit('update:modelValue', 's1')
  await flushPromises()
  expect(sprints.active).toBe('s1')
  expect(push).toHaveBeenLastCalledWith({ name: 'workspace', query: { sprint: 's1' } })
})

it('proposes the new sprint when the viewed workspace is reassigned remotely', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's1' })]
  store.selectedWorkspaceId = 'one'
  sprints.active = 's1'
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: 's1' } }
  wrapper = mountList()
  await flushPromises()
  store.workspaces[0]!.sprintId = 's2'
  await flushPromises()
  expect(replace).toHaveBeenCalledWith({
    name: 'workspace',
    state: { koboSprintContext: true },
    params: { id: 'one' },
    query: { sprint: 's2' },
  })
  expect(store.selectedWorkspaceId).toBe('one')
})

it('keeps the deleted sprint selected when the dirty guard rejects the fallback', async () => {
  const sprints = useSprintStore()
  sprints.active = 's1'
  sprints.sprints = [{ id: 's1', name: 'Sprint', sortOrder: 0, createdAt: '', updatedAt: '' }]
  sprints.loaded = true
  currentRoute.value = { name: 'workspace', params: {}, query: { sprint: 's1' } }
  push.mockResolvedValue({ type: 4 })
  wrapper = mountList()
  await flushPromises()
  sprints.sprints = []
  await flushPromises()
  expect(push).toHaveBeenCalledWith({ name: 'workspace', query: { sprint: '__none__' } })
  expect(sprints.active).toBe('s1')
})

it('keeps the tab on first hydration of an open workspace that is not in it', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  sprints.active = 's1'
  store.selectedWorkspaceId = 'one'
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: 's1' } }
  wrapper = mountList()
  await flushPromises()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's2' })]
  await flushPromises()
  expect(replace).not.toHaveBeenCalled()
  expect(sprints.active).toBe('s1')
})

it('does not rewrite the route when the selection moves to a workspace of another sprint', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's1' }), makeWorkspace({ id: 'two', sprintId: 's2' })]
  store.selectedWorkspaceId = 'one'
  sprints.active = 's1'
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: 's1' } }
  wrapper = mountList()
  await flushPromises()
  currentRoute.value = { name: 'workspace', params: { id: 'two' }, query: { sprint: 's1' } }
  store.selectedWorkspaceId = 'two'
  await flushPromises()
  expect(replace).not.toHaveBeenCalled()
  expect(sprints.active).toBe('s1')
  expect(currentRoute.value.query.sprint).toBe('s1')
})

it('does nothing when an open workspace that was not in the active tab is reassigned', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's2' })]
  store.selectedWorkspaceId = 'one'
  sprints.active = 's1'
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: 's1' } }
  wrapper = mountList()
  await flushPromises()
  store.workspaces[0]!.sprintId = 's3'
  await flushPromises()
  expect(replace).not.toHaveBeenCalled()
  expect(sprints.active).toBe('s1')
})

it('does nothing on the All tab when the open workspace is reassigned', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's1' })]
  store.selectedWorkspaceId = 'one'
  sprints.active = ALL_SPRINTS
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: ALL_SPRINTS } }
  wrapper = mountList()
  await flushPromises()
  store.workspaces[0]!.sprintId = 's2'
  await flushPromises()
  expect(replace).not.toHaveBeenCalled()
})

it('follows a reassignment from the active tab to the no-sprint tab', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'one', sprintId: 's1' })]
  store.selectedWorkspaceId = 'one'
  sprints.active = 's1'
  currentRoute.value = { name: 'workspace', params: { id: 'one' }, query: { sprint: 's1' } }
  wrapper = mountList()
  await flushPromises()
  store.workspaces[0]!.sprintId = null
  await flushPromises()
  expect(replace).toHaveBeenCalledWith(expect.objectContaining({ query: { sprint: '__none__' } }))
})

it('moves focus from the first card when the open workspace is not in the list', async () => {
  const store = useWorkspaceStore()
  const sprints = useSprintStore()
  store.workspaces = [makeWorkspace({ id: 'a', sprintId: 's1' }), makeWorkspace({ id: 'open', sprintId: 's2' })]
  store.selectedWorkspaceId = 'open'
  sprints.active = 's1'
  currentRoute.value = { name: 'workspace', params: { id: 'open' }, query: { sprint: 's1' } }
  const host = document.createElement('div')
  document.body.appendChild(host)
  wrapper = shallowMount(WorkspaceList, { ...mountOptions(), attachTo: host })
  await flushPromises()
  const list = wrapper.element.querySelector('[role="listbox"]') as HTMLElement
  const cards = ['a', 'b'].map((id) => {
    const card = document.createElement('div')
    card.setAttribute('data-testid', 'workspace-card')
    card.tabIndex = 0
    card.id = `card-${id}`
    list.appendChild(card)
    return card
  })
  expect(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))).not.toThrow()
  expect(document.activeElement).toBe(cards[0])
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(cards[1])
  host.remove()
})

it('confirms a missing sprint with a fresh catalogue before falling back', async () => {
  const sprints = useSprintStore()
  let finish!: () => void
  vi.mocked(sprints.fetchSprints).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  sprints.loaded = true
  currentRoute.value = { name: 'workspace', params: {}, query: { sprint: 'new' } }
  wrapper = mountList()
  await flushPromises()
  expect(push).not.toHaveBeenCalled()
  sprints.sprints = [{ id: 'new', name: 'New', sortOrder: 0, createdAt: '', updatedAt: '' }]
  finish()
  await flushPromises()
  expect(push).not.toHaveBeenCalled()
})

it('acknowledges an unread workspace when clicking its already open card', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace({ hasUnread: true })]
  store.selectedWorkspaceId = 'ws-1'
  currentRoute.value = { name: 'workspace', params: { id: 'ws-1' }, query: { sprint: ALL_SPRINTS } }
  const markRead = vi.spyOn(store, 'markRead').mockResolvedValue(undefined)
  // A real router supplies a duplicated-navigation failure for an unchanged URL.
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }] })
  await router.push('/')
  push.mockResolvedValueOnce(await router.push('/'))
  wrapper = mountList()
  await flushPromises()
  wrapper.findComponent({ name: 'WorkspaceCard' }).vm.$emit('select', 'ws-1')
  await flushPromises()
  expect(markRead).toHaveBeenCalledExactlyOnceWith('ws-1')
})

it('does not acknowledge a workspace when navigation is refused', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace({ hasUnread: true })]
  store.selectedWorkspaceId = 'ws-1'
  currentRoute.value = { name: 'workspace', params: { id: 'ws-1' }, query: {} }
  const markRead = vi.spyOn(store, 'markRead').mockResolvedValue(undefined)
  push.mockResolvedValueOnce({ type: 4 })
  wrapper = mountList()
  await flushPromises()
  wrapper.findComponent({ name: 'WorkspaceCard' }).vm.$emit('select', 'ws-1')
  await flushPromises()
  expect(markRead).not.toHaveBeenCalled()
})

it('does not restart an in-flight selection on repeated clicks and permits retry after refusal', async () => {
  useWorkspaceStore().workspaces = [makeWorkspace()]
  let finish!: (value: unknown) => void
  push.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  wrapper = mountList()
  await flushPromises()
  const card = wrapper.findComponent({ name: 'WorkspaceCard' })
  card.vm.$emit('select', 'ws-1')
  card.vm.$emit('select', 'ws-1')
  card.vm.$emit('select', 'ws-1')
  expect(push).toHaveBeenCalledTimes(1)
  finish({ type: 4 })
  await flushPromises()
  card.vm.$emit('select', 'ws-1')
  await flushPromises()
  expect(push).toHaveBeenCalledTimes(2)
})

it('clears bulk selection when changing sprint and does not restore it on return', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace()]
  const sprints = useSprintStore()
  sprints.setActive(ALL_SPRINTS)
  wrapper = mountList()
  await flushPromises()
  wrapper.findComponent({ name: 'WorkspaceCard' }).vm.$emit('toggleSelection', 'ws-1')
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'WorkspaceBulkActions' }).props('workspaces')).toHaveLength(1)
  sprints.setActive('another-sprint')
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'WorkspaceBulkActions' }).props('workspaces')).toEqual([])
  sprints.setActive(ALL_SPRINTS)
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'WorkspaceBulkActions' }).props('workspaces')).toEqual([])
})

it('clears bulk selection when the search filter changes', async () => {
  const store = useWorkspaceStore()
  store.workspaces = [makeWorkspace()]
  useSprintStore().setActive(ALL_SPRINTS)
  wrapper = mountList()
  await flushPromises()
  wrapper.findComponent({ name: 'WorkspaceCard' }).vm.$emit('toggleSelection', 'ws-1')
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'WorkspaceBulkActions' }).props('workspaces')).toHaveLength(1)
  wrapper.findComponent({ name: 'QInput' }).vm.$emit('update:modelValue', 'Test')
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'WorkspaceBulkActions' }).props('workspaces')).toEqual([])
})

it('opens the notifications dialog for the workspace of the context-menu event', async () => {
  const store = useWorkspaceStore()
  const workspace = makeWorkspace({ id: 'w-notif' })
  store.workspaces = [workspace]
  wrapper = mountList()
  await flushPromises()
  wrapper.findComponent({ name: 'WorkspaceCard' }).vm.$emit('notifications', workspace)
  await wrapper.vm.$nextTick()
  const dialog = wrapper.findComponent({ name: 'WorkspaceNotificationsDialog' })
  expect(dialog.props()).toMatchObject({ modelValue: true, workspaceId: 'w-notif' })
})

describe('group message from the multi-selection', () => {
  async function selectBoth() {
    const store = useWorkspaceStore()
    store.workspaces = [
      makeWorkspace({ id: 'ws-1', name: 'One' }),
      makeWorkspace({ id: 'ws-2', name: 'Two', worktreePurgedAt: '2026-01-02T00:00:00Z' }),
      makeWorkspace({ id: 'ws-3', name: 'Three' }),
    ]
    useSprintStore().setActive(ALL_SPRINTS)
    wrapper = mountList()
    await flushPromises()
    for (const id of ['ws-1', 'ws-2', 'ws-3'])
      wrapper!.findAllComponents({ name: 'WorkspaceCard' })[0]!.vm.$emit('toggleSelection', id)
    await wrapper.vm.$nextTick()
    return wrapper
  }
  const dialog = () => wrapper!.findComponent({ name: 'WorkspaceGroupMessageDialog' })

  it('opens the existing dialog with the receivable selected workspaces and a selection label', async () => {
    await selectBoth()
    wrapper!.findComponent({ name: 'WorkspaceBulkActions' }).vm.$emit('message', ['ws-1', 'ws-2', 'ws-3'])
    await wrapper!.vm.$nextTick()
    expect(dialog().props('modelValue')).toBe(true)
    expect(
      dialog()
        .props('workspaces')
        .map((w: Workspace) => w.id),
    ).toEqual(['ws-1', 'ws-3'])
    expect(dialog().props('scope')).toBe('Selection (2)')
    expect(dialog().props('fromSelection')).toBe(true)
  })

  it('leaves the selection intact when the dialog opens and closes', async () => {
    await selectBoth()
    const bulk = () => wrapper!.findComponent({ name: 'WorkspaceBulkActions' })
    bulk().vm.$emit('message', ['ws-1', 'ws-2', 'ws-3'])
    await wrapper!.vm.$nextTick()
    expect(bulk().props('workspaces')).toHaveLength(3)
    dialog().vm.$emit('update:modelValue', false)
    await wrapper!.vm.$nextTick()
    expect(dialog().props('modelValue')).toBe(false)
    expect(bulk().props('workspaces')).toHaveLength(3)
  })

  it('keeps the megaphone on the non-archived workspaces of the sprint scope', async () => {
    await selectBoth()
    await wrapper!.get('[data-tour="group-message"]').trigger('click')
    expect(dialog().props('modelValue')).toBe(true)
    expect(
      dialog()
        .props('workspaces')
        .map((w: Workspace) => w.id),
    ).toEqual(['ws-1', 'ws-2', 'ws-3'])
    expect(dialog().props('scope')).toBe(en['sprints.all'])
    expect(dialog().props('fromSelection')).toBe(false)
  })

  it('resets the dialog recipients when the opening source changes', async () => {
    await selectBoth()
    const key = () => dialog().props('resetKey')
    const initial = key()
    wrapper!.findComponent({ name: 'WorkspaceBulkActions' }).vm.$emit('message', ['ws-1'])
    await wrapper!.vm.$nextTick()
    expect(key()).not.toBe(initial)
    const afterSelection = key()
    await wrapper!.get('[data-tour="group-message"]').trigger('click')
    expect(key()).not.toBe(afterSelection)
    const afterMegaphone = key()
    await wrapper!.get('[data-tour="group-message"]').trigger('click')
    expect(key()).toBe(afterMegaphone)
  })
})
