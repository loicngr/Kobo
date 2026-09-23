import { onScopeDispose, ref, watch } from 'vue'

interface WorkingTreeFile {
  path: string
  staged: boolean
  modified: boolean
  untracked: boolean
}
interface WorkingTreeCounts {
  staged: number
  modified: number
  untracked: number
}

export function useWorkingTreeFiles(
  workspaceId: () => string | undefined,
  counts: () => WorkingTreeCounts | null | undefined,
) {
  const showWorkingTreeFiles = ref(false)
  const loadingWorkingTreeFiles = ref(false)
  const workingTreeFiles = ref<WorkingTreeFile[]>([])
  let request: AbortController | undefined

  function reset() {
    request?.abort()
    request = undefined
    showWorkingTreeFiles.value = false
    loadingWorkingTreeFiles.value = false
    workingTreeFiles.value = []
  }

  async function refresh() {
    const id = workspaceId()
    if (!id) return
    request?.abort()
    const controller = new AbortController()
    request = controller
    loadingWorkingTreeFiles.value = true
    try {
      const response = await fetch(`/api/workspaces/${id}/working-tree-files`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { files: WorkingTreeFile[] }
      if (request !== controller || controller.signal.aborted || workspaceId() !== id) return
      workingTreeFiles.value = body.files
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return
      console.error('[GitPanel] fetchWorkingTreeFiles failed:', error)
      workingTreeFiles.value = []
    } finally {
      if (request === controller) loadingWorkingTreeFiles.value = false
    }
  }

  function toggleWorkingTreeFiles() {
    if (showWorkingTreeFiles.value) {
      reset()
      return
    }
    showWorkingTreeFiles.value = true
    void refresh()
  }

  watch(
    [workspaceId, counts],
    ([id, tree], [previousId]) => {
      if (id !== previousId || (tree && tree.staged + tree.modified + tree.untracked === 0)) reset()
      else if (tree && showWorkingTreeFiles.value) void refresh()
    },
    { flush: 'sync', deep: true },
  )
  onScopeDispose(reset)
  return { showWorkingTreeFiles, loadingWorkingTreeFiles, workingTreeFiles, toggleWorkingTreeFiles }
}
