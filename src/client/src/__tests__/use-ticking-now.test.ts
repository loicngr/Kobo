import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useTickingNow } from '../composables/use-ticking-now'

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value })
  document.dispatchEvent(new Event('visibilitychange'))
}

function host(active: () => boolean) {
  let now!: Readonly<{ value: number }>
  const wrapper = mount(
    defineComponent({
      setup() {
        now = useTickingNow(active)
        return () => h('div')
      },
    }),
  )
  return { wrapper, now: () => now.value }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'))
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useTickingNow', () => {
  it('advances once per second while active', () => {
    const { wrapper, now } = host(() => true)
    const start = now()
    vi.advanceTimersByTime(3000)
    expect(now() - start).toBe(3000)
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
  })

  it('creates no timer while inactive', () => {
    const { wrapper } = host(() => false)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('clears the timer when active becomes false and restarts when it returns', async () => {
    const active = ref(true)
    const { wrapper } = host(() => active.value)
    expect(vi.getTimerCount()).toBe(1)
    active.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(0)
    active.value = true
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
  })

  it('pauses while the tab is hidden and resumes with a fresh time on return', () => {
    const { wrapper, now } = host(() => true)
    setHidden(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    setHidden(false)
    expect(vi.getTimerCount()).toBe(1)
    expect(now()).toBe(Date.now())
    wrapper.unmount()
  })

  it('does not start a timer when mounted in a hidden tab', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const { wrapper } = host(() => true)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('clears its timer and listener when the host unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { wrapper } = host(() => true)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    setHidden(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one interval between subscribers and clears it with the last one', () => {
    const set = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const a = host(() => true)
    const b = host(() => true)
    expect(set).toHaveBeenCalledTimes(1)
    a.wrapper.unmount()
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(b.now()).toBe(Date.now())
    b.wrapper.unmount()
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
