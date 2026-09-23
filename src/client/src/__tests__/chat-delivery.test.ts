import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatDeliveryTracker } from '../services/chat-delivery'

afterEach(() => vi.useRealTimers())

describe('chat delivery', () => {
  it('requires a matching workspace and message, and tolerates duplicate acknowledgements', async () => {
    const tracker = new ChatDeliveryTracker()
    const confirmed = vi.fn()
    const delivery = tracker.wait('a', 'id', 'timeout').then(confirmed)
    tracker.settle('b', 'id')
    tracker.settle('a', 'another')
    await Promise.resolve()
    expect(confirmed).not.toHaveBeenCalled()
    tracker.settle('a', 'id')
    tracker.settle('a', 'id')
    await delivery
    expect(confirmed).toHaveBeenCalledTimes(1)
  })
  it('rejects only the failed send', async () => {
    const tracker = new ChatDeliveryTracker()
    const first = tracker.wait('a', 'first', 'timeout')
    const second = tracker.wait('a', 'second', 'timeout')
    const rejected = expect(first).rejects.toThrow('compacting')
    tracker.settle('a', 'first', new Error('compacting'))
    tracker.settle('a', 'second')
    await rejected
    await second
  })
  it('retains drafts by rejecting pending sends after disconnect or 30 seconds', async () => {
    vi.useFakeTimers()
    const tracker = new ChatDeliveryTracker()
    const first = expect(tracker.wait('a', 'first', 'timeout')).rejects.toThrow('offline')
    tracker.disconnect('offline')
    await first
    const second = expect(tracker.wait('a', 'second', 'timeout')).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(30_000)
    await second
    expect(vi.getTimerCount()).toBe(0)
  })
})
