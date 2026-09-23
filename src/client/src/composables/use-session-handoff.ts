import { useSessionHandoffStore } from 'src/stores/session-handoff'
import { onScopeDispose, type Ref, watch } from 'vue'

/** WebSocket events provide live updates; polling covers missed events during a transfer. */
export function useSessionHandoff(workspaceId: Readonly<Ref<string | null>>) {
  const store = useSessionHandoffStore()
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  watch(
    workspaceId,
    (id) => {
      if (id) void store.refresh(id).catch(() => {})
    },
    { immediate: true },
  )
  watch(
    () => [workspaceId.value, workspaceId.value ? store.isActive(workspaceId.value) : false] as const,
    ([id, active]) => {
      const currentGeneration = ++generation
      clearTimeout(timer)
      if (!id || !active) return
      const poll = async () => {
        await store.refresh(id).catch(() => {})
        if (generation === currentGeneration && store.isActive(id)) timer = setTimeout(poll, 2000)
      }
      timer = setTimeout(poll, 2000)
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    generation++
    clearTimeout(timer)
  })
}
