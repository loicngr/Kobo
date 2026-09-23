/**
 * Collapse a burst of calls into a single call on the next animation frame.
 *
 * Monaco fires `onDidScrollChange` once per frame while the user drags, and
 * the handler mutated a deeply reactive array — one write per comment zone —
 * so every frame triggered a full re-render, in cascade with the per-folder
 * comment counts. Coalescing turns N writes per frame into one.
 *
 * `schedule` and `cancel` are injectable so tests can drive frames
 * deterministically instead of waiting on a real animation frame.
 */
export function coalesceFrames(
  fn: () => void,
  schedule: (cb: () => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
): { request(): void; cancel(): void } {
  let pending: number | null = null
  const run = (): void => {
    pending = null
    fn()
  }
  return {
    request(): void {
      if (pending !== null) return
      pending = schedule(run)
    },
    cancel(): void {
      if (pending === null) return
      cancel(pending)
      pending = null
    },
  }
}
