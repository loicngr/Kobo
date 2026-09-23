import { describe, expect, it, vi } from 'vitest'
import { createTurnLiveness } from '../../server/services/agent/turn-liveness.js'

describe('createTurnLiveness', () => {
  it('times out an active turn after inactivity', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

    liveness.start()
    vi.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not time out while waiting for user input', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

    liveness.start()
    liveness.pause()
    vi.advanceTimersByTime(1_000)

    expect(onTimeout).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('rearms its deadline on activity', () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

    liveness.start()
    vi.advanceTimersByTime(800)
    liveness.activity()
    vi.advanceTimersByTime(800)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  describe('setTimeoutMs', () => {
    it('growing the timeout mid-flight extends the deadline from the current arm point', () => {
      vi.useFakeTimers()
      const onTimeout = vi.fn()
      const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

      liveness.start()
      vi.advanceTimersByTime(400)
      liveness.setTimeoutMs(10_000)

      // Past the original 1_000ms deadline — must not have fired since the
      // deadline was extended before it elapsed.
      vi.advanceTimersByTime(700)
      expect(onTimeout).not.toHaveBeenCalled()

      // Re-armed at the 400ms mark for 10_000ms — fires at 400 + 10_000.
      vi.advanceTimersByTime(10_000 - 700)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('shrinking the timeout mid-flight fires promptly from the re-arm point', () => {
      vi.useFakeTimers()
      const onTimeout = vi.fn()
      const liveness = createTurnLiveness({ timeoutMs: 10_000, onTimeout })

      liveness.start()
      vi.advanceTimersByTime(5_000)
      liveness.setTimeoutMs(1_000)

      // Re-armed from now (the 5_000ms mark) for 1_000ms, not from the
      // original start — fires at 5_000 + 1_000, well before the original
      // 10_000ms deadline would have.
      vi.advanceTimersByTime(999)
      expect(onTimeout).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('does not start a timer while paused, then fires after the new duration from resume', () => {
      vi.useFakeTimers()
      const onTimeout = vi.fn()
      const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

      liveness.start()
      liveness.pause()
      liveness.setTimeoutMs(2_000)

      // No timer pending while paused — advancing well past the new value
      // must not fire anything.
      vi.advanceTimersByTime(5_000)
      expect(onTimeout).not.toHaveBeenCalled()

      liveness.resume()
      vi.advanceTimersByTime(1_999)
      expect(onTimeout).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('is a no-op when called with the current duration and does not disrupt the countdown', () => {
      vi.useFakeTimers()
      const onTimeout = vi.fn()
      const liveness = createTurnLiveness({ timeoutMs: 1_000, onTimeout })

      liveness.start()
      vi.advanceTimersByTime(800)
      liveness.setTimeoutMs(1_000)

      // If setTimeoutMs had reset the countdown from this point, the
      // deadline would now land at 800 + 1_000 instead of the original
      // 1_000 — advancing just past the original deadline proves it did not.
      vi.advanceTimersByTime(199)
      expect(onTimeout).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })
})
