import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import GitPanel from '../components/GitPanel.vue'
import PrPanel from '../components/PrPanel.vue'
import en from '../i18n/en'
import { type GitStats, useWorkspaceStore, type Workspace } from '../stores/workspace'

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), notify: vi.fn(), api: vi.fn(), deleteApi: vi.fn() }))
vi.mock('quasar', () => ({ useQuasar: () => ({ dialog: mocks.dialog, notify: mocks.notify }) }))
vi.mock('src/composables/use-tours', () => ({ useTours: () => ({ scheduleAutoRun: vi.fn() }) }))
vi.mock('src/utils/api', async (original) => ({
  ...(await original<object>()),
  apiFetchResponse: mocks.api,
  apiFetchResponseForStatus: mocks.deleteApi,
}))

const workspace = {
  id: 'ws-a',
  projectPath: '/repo',
  workingBranch: 'feature/a',
  sourceBranch: 'main',
  status: 'idle',
} as Workspace
const stats = {
  prUrl: 'https://github.com/o/r/pull/42',
  prState: 'OPEN',
  unpushedCount: 0,
  workingTree: { staged: 0, modified: 0, untracked: 0 },
  commitCount: 1,
  behindCount: 0,
  filesChanged: 1,
  insertions: 1,
  deletions: 0,
  forge: {
    id: 'github',
    capabilities: {
      canCreatePr: true,
      canChangePrBase: true,
      canMergeRequest: true,
      canDeleteRemoteBranch: true,
      mergeMethods: ['merge', 'squash', 'rebase'],
      requestTermShort: 'PR',
    },
    availability: { available: true },
  },
} as GitStats
let wrapper: VueWrapper
let confirm: (method?: unknown) => Promise<void>
let store: ReturnType<typeof useWorkspaceStore>

function mountPanel(shallow = true) {
  wrapper = mount(GitPanel, {
    shallow,
    props: { workspace },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      directives: { 'close-popup': {} },
      stubs: {
        ...(shallow
          ? Object.fromEntries(
              [
                'QTooltip',
                'QSpinner',
                'QIcon',
                'QItemSection',
                'QItem',
                'QList',
                'QBtnDropdown',
                'QMenu',
                'QCardSection',
                'QInput',
                'QCardActions',
                'QCard',
                'QDialog',
              ].map((name) => [name, true]),
            )
          : {}),
        QBtn: { props: ['label', 'icon'], template: '<button :data-icon="icon">{{ label }}</button>' },
        ActionAvailability: true,
        BranchDivergenceDialog: true,
        CompareCommitsDialog: true,
        DiffViewer: true,
        PrPanel: true,
      },
    },
  })
}

async function openDialog(methods = true, shallow = true) {
  if (!methods)
    vi.mocked(store.fetchGitStats).mockResolvedValue({
      ...stats,
      forge: { ...stats.forge!, capabilities: { ...stats.forge!.capabilities, mergeMethods: undefined } },
    })
  mountPanel(shallow)
  await flushPromises()
  await wrapper.get('button[data-icon="merge"]').trigger('click')
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  store = useWorkspaceStore()
  store.prSnapshots['ws-a'] = { readyToMerge: true, state: 'OPEN' } as never
  store.prSnapshots['ws-b'] = { readyToMerge: true, state: 'OPEN' } as never
  vi.spyOn(store, 'fetchGitStats').mockResolvedValue(stats)
  vi.spyOn(store, 'refreshPrSnapshot').mockResolvedValue(null)
  mocks.dialog.mockImplementation(() => ({
    onOk: (callback: typeof confirm) => {
      confirm = callback
    },
  }))
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ merged: false, branch: 'feature/a' }) })
  mocks.deleteApi.mockResolvedValue({ ok: true })
})
afterEach(() => wrapper?.unmount())

describe('GitPanel cached workspace stats', () => {
  it('preserves the PR panel across refreshes while keeping cached actions disabled', async () => {
    mountPanel()
    await flushPromises()
    const prPanel = wrapper.getComponent(PrPanel).vm
    let finish!: (value: GitStats) => void
    vi.mocked(store.fetchGitStats).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await wrapper.get('button[data-icon="refresh"]').trigger('click')
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
    expect(wrapper.getComponent(PrPanel).vm).toBe(prPanel)
    finish(stats)
    await flushPromises()
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.getComponent(PrPanel).vm).toBe(prPanel)
  })

  it('keeps the fresh read in charge when an agent-triggered refresh fires while it is pending', async () => {
    vi.useFakeTimers()
    try {
      store.gitStatsCache['ws-a'] = stats
      let finish!: (value: GitStats) => void
      vi.mocked(store.fetchGitStats).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      mountPanel()
      const original = vi.mocked(store.fetchGitStats).mock.calls[0][1]!
      expect(original.freshFetch).toBe(true)
      store.gitRefreshTrigger++
      await vi.advanceTimersByTimeAsync(3000)
      expect(store.fetchGitStats).toHaveBeenCalledOnce()
      expect(original.signal!.aborted).toBe(false)
      expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
      finish({ ...stats, commitCount: 7 })
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.text()).toContain('7 commits')
      expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires a fresh read for an agent-triggered retry after a failed refresh', async () => {
    vi.useFakeTimers()
    try {
      store.gitStatsCache['ws-a'] = stats
      vi.mocked(store.fetchGitStats).mockRejectedValueOnce(new Error('offline'))
      mountPanel()
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
      let finish!: (value: GitStats) => void
      vi.mocked(store.fetchGitStats).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      store.gitRefreshTrigger++
      await vi.advanceTimersByTimeAsync(3000)
      expect(store.fetchGitStats).toHaveBeenLastCalledWith('ws-a', expect.objectContaining({ freshFetch: true }))
      expect(wrapper.text()).toContain('offline')
      expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
      finish(stats)
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.find('.git-subcard--error').exists()).toBe(false)
      expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the target workspace cache and blocks actions until its fresh read completes', async () => {
    store.gitStatsCache['ws-a'] = { ...stats, commitCount: 4 }
    store.gitStatsCache['ws-b'] = { ...stats, commitCount: 9 }
    let finish!: (value: GitStats) => void
    vi.mocked(store.fetchGitStats).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mountPanel()
    expect(wrapper.text()).toContain('4 commits')
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[role="status"]').text()).toContain('read-only')
    await wrapper.get('.commit-toggle').trigger('click')
    expect(mocks.api).not.toHaveBeenCalled()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    wrapper.get('.commit-toggle').element.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    await wrapper.get('button[data-icon="merge"]').trigger('click')
    expect(mocks.dialog).not.toHaveBeenCalled()
    await wrapper.setProps({ workspace: { ...workspace, id: 'ws-b', workingBranch: 'feature/b' } })
    expect(wrapper.text()).toContain('9 commits')
    expect(wrapper.text()).not.toContain('4 commits')
    finish({ ...stats, commitCount: 12 })
    await flushPromises()
    expect(wrapper.text()).toContain('12 commits')
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="git-cache-status"]').exists()).toBe(false)
    await wrapper.get('button[data-icon="merge"]').trigger('click')
    expect(mocks.dialog).toHaveBeenCalledOnce()
  })

  it('keeps cached values read-only after failure and unlocks only after a successful retry', async () => {
    store.gitStatsCache['ws-a'] = { ...stats, commitCount: 4 }
    vi.mocked(store.fetchGitStats).mockRejectedValueOnce(new Error('offline'))
    mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('offline')
    expect(wrapper.text()).toContain('4 commits')
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
    store.gitStatsCache['ws-a'] = { ...stats, commitCount: 7 }
    await flushPromises()
    expect(wrapper.text()).toContain('4 commits')
    vi.mocked(store.fetchGitStats).mockResolvedValueOnce({ ...stats, commitCount: 8 })
    await wrapper.get('.git-subcard--error button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('8 commits')
    expect(wrapper.find('.git-subcard--error').exists()).toBe(false)
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
  })

  it('ignores a previous workspace failure while the new workspace is loading', async () => {
    store.gitStatsCache['ws-a'] = { ...stats, commitCount: 4 }
    store.gitStatsCache['ws-b'] = { ...stats, commitCount: 9 }
    let failOld!: (reason: Error) => void
    let finishNew!: (value: GitStats) => void
    vi.mocked(store.fetchGitStats)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve
          }),
      )
    mountPanel()
    await wrapper.setProps({ workspace: { ...workspace, id: 'ws-b' } })
    failOld(new Error('old failure'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('old failure')
    expect(wrapper.text()).toContain('9 commits')
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeDefined()
    finishNew(stats)
    await flushPromises()
    expect(wrapper.get('[data-testid="git-content"]').attributes('disabled')).toBeUndefined()
  })

  it('uses the full loader only when the selected workspace has no cached stats', () => {
    vi.mocked(store.fetchGitStats).mockImplementation(() => new Promise(() => {}))
    mountPanel()
    expect(wrapper.find('[data-testid="git-content"]').exists()).toBe(false)
    expect(wrapper.find('q-spinner-stub').attributes('size')).toBe('32px')
  })
})

describe('GitPanel PR merge confirmation', () => {
  it.each(['merge', 'squash', 'rebase'])('offers strategies and sends only the confirmed %s choice', async (method) => {
    await openDialog()
    expect(mocks.api).not.toHaveBeenCalled()
    const options = mocks.dialog.mock.calls[0]![0].options
    expect(options.model).toBe('merge')
    expect(options.items.map((item: { value: string }) => item.value)).toEqual(['merge', 'squash', 'rebase'])
    await confirm(method)
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith('/api/workspaces/ws-a/merge-pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    })
  })

  it('keeps the provider default when no explicit strategies are supported', async () => {
    await openDialog(false)
    expect(mocks.dialog.mock.calls[0]![0].options).toBeUndefined()
    await confirm()
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith('/api/workspaces/ws-a/merge-pr', { method: 'POST' })
  })

  it('does not merge a different workspace after navigation', async () => {
    await openDialog()
    await wrapper.setProps({ workspace: { ...workspace, id: 'ws-b' } })
    await flushPromises()
    await confirm('squash')
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('offers an explicit admin retry after a policy refusal, preserving the method', async () => {
    await openDialog()
    mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'merge_policy_blocked' }) })
    await confirm('squash')
    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Merge blocked by GitHub',
        cancel: expect.objectContaining({ label: 'Keep protections' }),
        ok: expect.objectContaining({ label: 'Merge as administrator' }),
      }),
    )
    await confirm()
    expect(mocks.api).toHaveBeenLastCalledWith('/api/workspaces/ws-a/merge-pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'squash', admin: true }),
    })
  })

  it('ignores an admin confirmation after navigating to another workspace', async () => {
    await openDialog()
    mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'merge_policy_blocked' }) })
    await confirm('squash')
    await wrapper.setProps({ workspace: { ...workspace, id: 'ws-b' } })
    await flushPromises()
    await confirm()
    expect(mocks.api).toHaveBeenCalledTimes(1)
  })

  it('ignores an admin confirmation after the panel is unmounted', async () => {
    await openDialog()
    mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'merge_policy_blocked' }) })
    await confirm('squash')
    wrapper.unmount()
    await confirm()
    expect(mocks.api).toHaveBeenCalledTimes(1)
  })

  it('announces a confirmed admin merge and offers branch deletion', async () => {
    await openDialog()
    mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'merge_policy_blocked' }) })
    await confirm('squash')
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ merged: true, branch: 'feature/a' }) })
    await confirm()
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive', message: 'PR merged' }))
    expect(mocks.dialog).toHaveBeenCalledTimes(3)
  })

  it('offers branch deletion immediately while refreshed Git stats are still pending', async () => {
    await openDialog()
    let release!: (value: GitStats) => void
    vi.mocked(store.fetchGitStats).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ merged: true, branch: 'feature/a' }) })
    const merging = confirm('merge')
    try {
      await flushPromises()
      expect(mocks.dialog).toHaveBeenCalledTimes(2)
      expect(store.refreshPrSnapshot).toHaveBeenCalledWith('ws-a')
    } finally {
      release(stats)
      await merging
    }
  })

  it('keeps the real deletion dialog and its workspace through the archive redirect', async () => {
    const { Quasar, Dialog } = await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/workspace/ws-a', component: { render: () => null } },
        { path: '/', component: { render: () => null } },
      ],
    })
    const app = createApp({ render: () => h('main') })
    app.use(router)
    app.use(Quasar, { plugins: { Dialog } })
    const root = document.createElement('div')
    document.body.append(root)
    app.mount(root)
    await router.push('/workspace/ws-a')
    await router.isReady()
    mocks.dialog.mockImplementation(Dialog.create)
    vi.useFakeTimers()
    const settle = async () => {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
    }
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.q-dialog button')].find((el) => el.textContent === label)
    try {
      await openDialog(true, false)
      await settle()
      mocks.api.mockResolvedValueOnce({ ok: true, json: async () => ({ merged: true, branch: 'feature/a' }) })
      button('Merge PR')!.click()
      await settle()
      expect(button('Delete remote branch')).toBeDefined()
      store.selectedWorkspaceId = null
      await router.push('/')
      wrapper.unmount()
      store.selectedWorkspaceId = 'ws-b'
      await settle()
      expect(button('Delete remote branch')).toBeDefined()
      expect(mocks.deleteApi).not.toHaveBeenCalled()
      button('Delete remote branch')!.click()
      await settle()
      expect(mocks.deleteApi).toHaveBeenCalledExactlyOnceWith('/api/workspaces/ws-a/delete-remote-branch', {
        method: 'POST',
      })
      expect(document.querySelector('.q-dialog')).toBeNull()
    } finally {
      button('Cancel')?.click()
      await settle()
      app.unmount()
      root.remove()
      vi.useRealTimers()
    }
  })

  it('does not offer another admin retry when GitHub still refuses', async () => {
    await openDialog()
    mocks.api.mockResolvedValue({ ok: false, json: async () => ({ code: 'merge_policy_blocked' }) })
    await confirm('rebase')
    await confirm()
    expect(mocks.dialog).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'negative',
        message:
          'Administrator merge could not be confirmed. Check the PR status, your permissions and repository rules.',
      }),
    )
  })

  it('does not announce success when the merge is not confirmed', async () => {
    await openDialog()
    await confirm('squash')
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }))
    expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }))
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
  })

  it('shows a failed merge without offering branch deletion', async () => {
    await openDialog()
    mocks.api.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Squash disabled' }) })
    await confirm('squash')
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative', message: 'Squash disabled' }))
    expect(mocks.dialog).toHaveBeenCalledTimes(1)
  })
})
