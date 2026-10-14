import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import GitPanel from '../components/GitPanel.vue'
import en from '../i18n/en'
import { type GitStats, useWorkspaceStore, type Workspace } from '../stores/workspace'

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), notify: vi.fn(), api: vi.fn() }))
vi.mock('quasar', () => ({ useQuasar: () => ({ dialog: mocks.dialog, notify: mocks.notify }) }))
vi.mock('src/composables/use-tours', () => ({ useTours: () => ({ scheduleAutoRun: vi.fn() }) }))
vi.mock('src/utils/api', async (original) => ({ ...(await original<object>()), apiFetchResponse: mocks.api }))

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

async function openDialog(methods = true) {
  if (!methods)
    vi.mocked(store.fetchGitStats).mockResolvedValue({
      ...stats,
      forge: { ...stats.forge!, capabilities: { ...stats.forge!.capabilities, mergeMethods: undefined } },
    })
  wrapper = shallowMount(GitPanel, {
    props: { workspace },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: { QBtn: { props: ['label', 'icon'], template: '<button :data-icon="icon">{{ label }}</button>' } },
    },
  })
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
})
afterEach(() => wrapper?.unmount())

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
