import { type WatchSource, watch } from 'vue'

/**
 * Resolve as soon as `source` satisfies `predicate`, or after `timeoutMs`.
 *
 * Replaces the `while (…) await sleep(50)` busy loops: those woke the event
 * loop twenty to fifty times a second for up to fifteen seconds, and could
 * never react faster than their own polling interval. Returns true when the
 * predicate was met, false on timeout.
 */
export function waitForCondition<T>(
  source: WatchSource<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let stop: (() => void) | null = null

    const finish = (met: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      // `stop` may still be undefined when the predicate holds on the
      // immediate run — the guard below unwatches in that case.
      stop?.()
      resolve(met)
    }

    stop = watch(
      source,
      (value) => {
        if (predicate(value)) finish(true)
      },
      { immediate: true },
    )

    if (settled) {
      // The immediate run already matched: the watcher we just created has to
      // go, since `finish` ran before `stop` was assigned.
      stop()
      return
    }

    timer = setTimeout(() => finish(false), timeoutMs)
  })
}
