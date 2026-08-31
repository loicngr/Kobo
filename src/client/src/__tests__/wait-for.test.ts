import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

describe('waitForCondition', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves immediately when the condition already holds', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref(5)
    await expect(waitForCondition(source, (v) => v > 0, 1000)).resolves.toBe(true)
  })

  it('resolves as soon as the value changes, without waiting for a poll tick', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref(0)
    const settled = vi.fn()
    const promise = waitForCondition(source, (v) => v > 0, 5000).then(settled)

    expect(settled).not.toHaveBeenCalled()
    source.value = 1
    await nextTick()
    await promise
    // No timer had to fire: the old busy loop woke up fifty times a second and
    // could not react faster than its own interval.
    expect(settled).toHaveBeenCalledWith(true)
  })

  it('resolves false when the timeout expires', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref(0)
    const promise = waitForCondition(source, (v) => v > 0, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBe(false)
  })

  it('stops watching once resolved', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref(0)
    const predicate = vi.fn((v: number) => v > 0)
    const promise = waitForCondition(source, predicate, 5000)
    source.value = 1
    await nextTick()
    await promise
    const callsAtResolution = predicate.mock.calls.length

    source.value = 2
    await nextTick()
    source.value = 3
    await nextTick()

    expect(predicate.mock.calls.length).toBe(callsAtResolution)
  })

  it('clears its timer once resolved so no stray callback fires', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref(0)
    const promise = waitForCondition(source, (v) => v > 0, 1000)
    source.value = 1
    await nextTick()
    await expect(promise).resolves.toBe(true)
    // If the timeout were still armed, advancing past it would be the moment
    // a stray `finish(false)` callback could fire. It must resolve cleanly
    // instead of throwing (vitest 4's advanceTimersByTimeAsync resolves with
    // a fluent `vi` reference rather than `undefined`, hence not asserting
    // the resolved value itself).
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow()
  })

  it('accepts a getter as the source', async () => {
    const { waitForCondition } = await import('../utils/wait-for')
    const source = ref('pending')
    const promise = waitForCondition(
      () => source.value,
      (v) => v === 'done',
      5000,
    )
    source.value = 'done'
    await nextTick()
    await expect(promise).resolves.toBe(true)
  })
})
