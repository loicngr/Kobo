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
})
