import { onBeforeUnmount, type Ref, readonly, ref, watch } from 'vue'

// One page-wide clock: the interval exists while at least one subscriber is active and the tab is visible.
const shared = ref(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

function sync() {
  const run = subscribers > 0 && !document.hidden
  if (run && timer === undefined) {
    shared.value = Date.now()
    timer = setInterval(() => {
      shared.value = Date.now()
    }, 1000)
  } else if (!run && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

function subscribe() {
  if (subscribers++ === 0) document.addEventListener('visibilitychange', sync)
  sync()
}

function unsubscribe() {
  if (--subscribers === 0) document.removeEventListener('visibilitychange', sync)
  sync()
}

/**
 * The shared `now` ref (updated every second while any subscriber is active and the tab is visible; no timer
 * otherwise, and no request). Only read it where a tick should re-render: finished items must not read it.
 */
export function useTickingNow(active: () => boolean): Readonly<Ref<number>> {
  let subscribed = false
  watch(
    active,
    (value) => {
      if (value === subscribed) return
      subscribed = value
      if (value) subscribe()
      else unsubscribe()
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    if (subscribed) unsubscribe()
    subscribed = false
  })
  return readonly(shared)
}
