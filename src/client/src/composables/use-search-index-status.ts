import { useSearchStore } from 'src/stores/search'
import { onMounted, onUnmounted } from 'vue'

/** Poll only while a search screen is visible and the backfill is incomplete. */
export function useSearchIndexStatus(refreshResults: () => Promise<void>) {
  const store = useSearchStore()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastVersion = ''
  async function poll() {
    await store.refreshIndexStatus(controller.signal)
    if (stopped) return
    const version = `${store.indexStatus.state}:${store.indexStatus.processed}`
    if (version !== lastVersion) {
      lastVersion = version
      await refreshResults()
    }
    if (!stopped && store.indexStatus.state === 'building') timer = setTimeout(() => void poll(), 1000)
  }
  onMounted(() => void poll())
  onUnmounted(() => {
    stopped = true
    controller.abort()
    clearTimeout(timer)
  })
  return store
}
