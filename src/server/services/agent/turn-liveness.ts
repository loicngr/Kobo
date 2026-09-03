export interface TurnLiveness {
  start(): void
  activity(): void
  pause(): void
  resume(): void
  stop(): void
  /** Change the idle deadline; re-arms the pending timer with the new duration. */
  setTimeoutMs(ms: number): void
}

/**
 * Tracks a single active agent turn. Shared by every engine (D2): one module,
 * armed BEFORE the handshake, re-armed on ANY event, paused while a human
 * decision is pending, stopped in the cleanup block.
 *
 * A pending user decision deliberately pauses the deadline: the agent is
 * waiting on a human, not stalled.
 */
export function createTurnLiveness(input: { timeoutMs: number; onTimeout: () => void }): TurnLiveness {
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false
  let paused = false
  let timedOut = false
  let currentTimeoutMs = input.timeoutMs

  const arm = (): void => {
    if (!active || paused || timedOut) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!active || paused || timedOut) return
      timedOut = true
      input.onTimeout()
    }, currentTimeoutMs)
    timer.unref?.()
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
    setTimeoutMs(ms: number) {
      if (ms === currentTimeoutMs) return
      currentTimeoutMs = ms
      // Re-arm only if a deadline is currently pending; a paused/stopped
      // liveness picks the new duration up on its next arm().
      if (timer) arm()
    },
  }
}
