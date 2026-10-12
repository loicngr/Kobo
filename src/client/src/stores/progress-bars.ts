import { defineStore } from 'pinia'
import { apiFetch } from 'src/utils/api'
import { computed, onScopeDispose, ref } from 'vue'
import {
  PROGRESS_MAX_RETAINED,
  PROGRESS_SUCCESS_VISIBLE_MS,
  type ProgressBar,
  type ProgressBarList,
} from '../../../shared/progress-bars'

/** One selected conversation per pane; dismissed records remain as tombstones. */
export const useProgressBarsStore = defineStore('progress-bars', () => {
  const workspaceId = ref<string | null>(null)
  const sessionId = ref<string | null>(null)
  const records = ref<Record<string, ProgressBar>>({})
  const pendingDismissals = ref<Record<string, boolean>>({})
  const error = ref<'load' | 'dismiss' | null>(null)
  let dismissalErrorId: string | null = null
  const now = ref(Date.now())
  const clockOffset = ref(0)
  let generation = 0
  let refreshVersion = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const visible = computed(() =>
    Object.values(records.value)
      .filter(
        (item) =>
          !item.dismissed &&
          !pendingDismissals.value[item.id] &&
          !(
            item.status === 'succeeded' &&
            item.completedAt &&
            Date.parse(item.completedAt) + PROGRESS_SUCCESS_VISIBLE_MS <= now.value + clockOffset.value
          ),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  )

  function scheduleExpiry() {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    now.value = Date.now()
    // A failed close is actionable only while its own activity is still visible.
    if (error.value === 'dismiss' && !visible.value.some((item) => item.id === dismissalErrorId)) {
      error.value = null
      dismissalErrorId = null
    }
    const deadlines = visible.value.flatMap((item) =>
      item.status === 'succeeded' && item.completedAt
        ? [Date.parse(item.completedAt) + PROGRESS_SUCCESS_VISIBLE_MS - clockOffset.value]
        : [],
    )
    if (deadlines.length) expiryTimer = setTimeout(scheduleExpiry, Math.max(1, Math.min(...deadlines) - Date.now()))
  }
  function reset() {
    generation++
    refreshVersion++
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    workspaceId.value = null
    sessionId.value = null
    records.value = {}
    pendingDismissals.value = {}
    error.value = null
    dismissalErrorId = null
    clockOffset.value = 0
    now.value = Date.now()
  }
  function selectScope(workspace: string | null, session: string | null) {
    if (workspaceId.value === workspace && sessionId.value === session) return
    reset()
    workspaceId.value = workspace
    sessionId.value = session
  }
  function apply(item: ProgressBar) {
    if (item.workspaceId !== workspaceId.value || item.sessionId !== sessionId.value) return
    const previous = records.value[item.id]
    if (previous && item.revision <= previous.revision) return
    if (!previous && Object.keys(records.value).length >= PROGRESS_MAX_RETAINED) return
    records.value[item.id] = {
      ...item,
      // Dismissal is permanent, even if an out-of-order peer sent a newer snapshot.
      dismissed: item.dismissed || previous?.dismissed === true,
      dismissedAt: previous?.dismissedAt ?? item.dismissedAt,
    }
    scheduleExpiry()
  }
  async function refresh() {
    if (!workspaceId.value || !sessionId.value) return
    const scope = { workspaceId: workspaceId.value, sessionId: sessionId.value }
    const capturedGeneration = generation
    const version = ++refreshVersion
    const isCurrent = () => capturedGeneration === generation && version === refreshVersion
    let offset: number | null = 0
    try {
      do {
        const query: URLSearchParams = new URLSearchParams({ ...scope, limit: '100', offset: String(offset) })
        const page: ProgressBarList = await apiFetch<ProgressBarList>(`/api/progress-bars?${query}`)
        if (!isCurrent()) return
        const serverTime = Date.parse(page.serverTime)
        if (Number.isFinite(serverTime)) clockOffset.value = serverTime - Date.now()
        for (const item of page.items) apply(item)
        scheduleExpiry()
        const next: number | null = page.nextOffset
        if (next !== null && (next <= offset || next >= PROGRESS_MAX_RETAINED)) break
        offset = next
      } while (offset !== null)
      if (isCurrent() && error.value === 'load') error.value = null
    } catch {
      if (isCurrent()) error.value = 'load'
    }
  }
  async function dismiss(id: string): Promise<boolean> {
    if (!workspaceId.value || !sessionId.value || !records.value[id] || pendingDismissals.value[id]) return false
    const capturedGeneration = generation
    pendingDismissals.value[id] = true
    error.value = null
    dismissalErrorId = null
    scheduleExpiry()
    try {
      const item = await apiFetch<ProgressBar>(`/api/progress-bars/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        body: { workspaceId: workspaceId.value, sessionId: sessionId.value },
      })
      if (capturedGeneration !== generation) return false
      apply(item)
      return true
    } catch {
      if (capturedGeneration === generation && !records.value[id]?.dismissed) {
        error.value = 'dismiss'
        dismissalErrorId = id
      }
      return false
    } finally {
      if (capturedGeneration === generation) {
        delete pendingDismissals.value[id]
        scheduleExpiry()
      }
    }
  }
  onScopeDispose(reset)
  return {
    workspaceId,
    sessionId,
    records,
    pendingDismissals,
    error,
    visible,
    selectScope,
    apply,
    refresh,
    dismiss,
    reset,
  }
})
