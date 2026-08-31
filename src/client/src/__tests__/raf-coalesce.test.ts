import { describe, expect, it, vi } from 'vitest'

/** Deterministic stand-in for requestAnimationFrame. */
function manualScheduler() {
  const queued: Array<() => void> = []
  return {
    schedule: (cb: () => void) => queued.push(cb),
    cancel: (id: number) => queued.splice(id - 1, 1),
    flush: () => {
      const pending = queued.splice(0, queued.length)
      for (const cb of pending) cb()
    },
    get size() {
      return queued.length
    },
  }
}

describe('coalesceFrames', () => {
  it('collapses a burst of requests into a single call', async () => {
    const { coalesceFrames } = await import('../utils/raf-coalesce')
    const scheduler = manualScheduler()
    const fn = vi.fn()
    const coalescer = coalesceFrames(fn, scheduler.schedule, scheduler.cancel)

    // Monaco fires onDidScrollChange once per frame while dragging; the naive
    // handler mutated one reactive field per comment zone on every one.
    for (let i = 0; i < 20; i++) coalescer.request()
    expect(fn).not.toHaveBeenCalled()

    scheduler.flush()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('accepts a new request after the frame ran', async () => {
    const { coalesceFrames } = await import('../utils/raf-coalesce')
    const scheduler = manualScheduler()
    const fn = vi.fn()
    const coalescer = coalesceFrames(fn, scheduler.schedule, scheduler.cancel)

    coalescer.request()
    scheduler.flush()
    coalescer.request()
    scheduler.flush()

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel drops the pending frame', async () => {
    const { coalesceFrames } = await import('../utils/raf-coalesce')
    const scheduler = manualScheduler()
    const fn = vi.fn()
    const coalescer = coalesceFrames(fn, scheduler.schedule, scheduler.cancel)

    coalescer.request()
    coalescer.cancel()
    scheduler.flush()

    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel is a no-op when nothing is pending', async () => {
    const { coalesceFrames } = await import('../utils/raf-coalesce')
    const scheduler = manualScheduler()
    const coalescer = coalesceFrames(vi.fn(), scheduler.schedule, scheduler.cancel)
    expect(() => coalescer.cancel()).not.toThrow()
  })
})
