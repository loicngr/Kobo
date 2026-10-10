import { onScopeDispose, ref } from 'vue'
import type { GroupMessageBatch, GroupMessageInput } from '../../../shared/workspace-group-messages'
import { apiFetch } from '../utils/api'

const STORAGE_KEY = 'kobo:group-message-request'
function tabStorage(): Storage | undefined {
  try {
    return sessionStorage
  } catch {
    return undefined
  }
}
function restoreRequest(storage: Storage | undefined): GroupMessageInput | null {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    return value &&
      typeof value.requestId === 'string' &&
      /^[\w-]+$/.test(value.requestId) &&
      typeof value.content === 'string' &&
      Array.isArray(value.workspaceIds) &&
      value.workspaceIds.every((id: unknown) => typeof id === 'string')
      ? value
      : null
  } catch {
    return null
  }
}

/** Keep the intended payload on ambiguous errors; only an explicit retry may POST it again. */
export function useGroupMessages() {
  // Capture this tab’s storage; another tab must never replace or clear its receipt.
  const storage = tabStorage()
  const request = ref<GroupMessageInput | null>(restoreRequest(storage))
  const batch = ref<GroupMessageBatch | null>(null)
  const busy = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let generation = 0
  function persist() {
    try {
      if (request.value) storage?.setItem(STORAGE_KEY, JSON.stringify(request.value))
      else storage?.removeItem(STORAGE_KEY)
    } catch {
      /* The current tab still retains the pending request. */
    }
  }
  function stopPolling() {
    clearTimeout(timer)
    timer = undefined
  }
  function poll() {
    stopPolling()
    if (!disposed && batch.value && !batch.value.complete)
      timer = setTimeout(() => {
        void refresh()
      }, 1_500)
  }
  async function perform(submit: boolean) {
    if (!request.value || busy.value || disposed) return
    stopPolling()
    const current = generation
    const input = { ...request.value, workspaceIds: [...request.value.workspaceIds] }
    busy.value = true
    error.value = ''
    try {
      const result = submit
        ? await apiFetch<GroupMessageBatch>('/api/workspace-messages', { method: 'POST', body: input })
        : await apiFetch<GroupMessageBatch>(`/api/workspace-messages/${input.requestId}`)
      if (disposed || current !== generation) return
      batch.value = result
      poll()
    } catch (cause) {
      if (!disposed && current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (!disposed && current === generation) busy.value = false
    }
  }
  async function send(workspaceIds: string[], content: string) {
    if (busy.value || request.value || !content.trim() || workspaceIds.length === 0) return
    request.value = {
      requestId: Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-'),
      workspaceIds: [...workspaceIds],
      content,
    }
    persist()
    await perform(true)
  }
  async function retry() {
    await perform(true)
  }
  async function refresh() {
    await perform(false)
  }
  function reset() {
    if (busy.value || (batch.value && !batch.value.complete)) return
    generation++
    stopPolling()
    request.value = null
    batch.value = null
    error.value = ''
    persist()
  }
  onScopeDispose(() => {
    disposed = true
    generation++
    stopPolling()
  })
  return { request, batch, busy, error, send, retry, refresh, reset }
}
