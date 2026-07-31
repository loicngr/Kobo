export interface TurnLiveness {
  start(): void
  activity(): void
  pause(): void
  resume(): void
  stop(): void
}

/**
 * Tracks a single active Codex turn. A pending user decision deliberately
 * pauses the deadline: the agent is waiting on a human, not stalled.
 */
export function createTurnLiveness(input: { timeoutMs: number; onTimeout: () => void }): TurnLiveness {
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false
  let paused = false
  let timedOut = false

  const arm = (): void => {
    if (!active || paused || timedOut) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!active || paused || timedOut) return
      timedOut = true
      input.onTimeout()
    }, input.timeoutMs)
  }

  return {
    start() {
      active = true
      paused = false
      timedOut = false
      arm()
    },
    activity() {
      arm()
    },
    pause() {
      paused = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
    resume() {
      if (!active || !paused) return
      paused = false
      arm()
    },
    stop() {
      active = false
      paused = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
