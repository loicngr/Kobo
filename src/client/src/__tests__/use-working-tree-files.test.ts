import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useWorkingTreeFiles } from '../composables/use-working-tree-files'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.unstubAllGlobals()
})
function setup() {
  const workspace = ref('one')
  const counts = ref({ staged: 0, modified: 1, untracked: 0 })
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() =>
    useWorkingTreeFiles(
      () => workspace.value,
      () => counts.value,
    ),
  )!
  return { ...state, counts, workspace }
}
const file = (path: string) => ({ path, modified: true, staged: false, untracked: false })
const response = (paths: string[]) => ({ ok: true, json: async () => ({ files: paths.map(file) }) })
describe('working-tree file disclosure', () => {
  it('closes and clears the list when a refresh reports a clean worktree', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(['README.md'])))
    const state = setup()
    state.toggleWorkingTreeFiles()
    await flushPromises()
    expect(state.workingTreeFiles.value).toHaveLength(1)
    state.counts.value = { staged: 0, modified: 0, untracked: 0 }
    expect(state.showWorkingTreeFiles.value).toBe(false)
    expect(state.workingTreeFiles.value).toEqual([])
    state.counts.value = { staged: 0, modified: 1, untracked: 0 }
    expect(state.showWorkingTreeFiles.value).toBe(false)
  })
  it.each(['clean', 'switch', 'close'])('ignores an old file response after %s', async (reason) => {
    let finish!: (value: ReturnType<typeof response>) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    )
    const state = setup()
    state.toggleWorkingTreeFiles()
    if (reason === 'clean') state.counts.value = { staged: 0, modified: 0, untracked: 0 }
    else if (reason === 'switch') state.workspace.value = 'two'
    else state.toggleWorkingTreeFiles()
    finish(response(['stale.md']))
    await flushPromises()
    expect(state.showWorkingTreeFiles.value).toBe(false)
    expect(state.workingTreeFiles.value).toEqual([])
    expect(state.loadingWorkingTreeFiles.value).toBe(false)
  })
  it('refreshes an open list even when file counts stay the same', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(['old.md']))
      .mockResolvedValueOnce(response(['new.md']))
    vi.stubGlobal('fetch', fetcher)
    const state = setup()
    state.toggleWorkingTreeFiles()
    await flushPromises()
    state.counts.value = { staged: 0, modified: 1, untracked: 0 }
    await flushPromises()
    expect(state.showWorkingTreeFiles.value).toBe(true)
    expect(state.workingTreeFiles.value.map((f) => f.path)).toEqual(['new.md'])
  })
})
