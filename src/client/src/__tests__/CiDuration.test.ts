import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import CiDuration from '../components/CiDuration.vue'
import en from '../i18n/en'

const T0 = '2026-11-18T10:00:00Z'
const iso = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString()
const running = { status: 'in_progress', startedAt: iso(0), completedAt: null }
const finished = { status: 'completed', startedAt: iso(0), completedAt: iso(45) }
let set: ReturnType<typeof vi.spyOn>
let clear: ReturnType<typeof vi.spyOn>
const render = (props: Record<string, unknown>) =>
  mount(CiDuration, {
    props,
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso(10)))
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  set = vi.spyOn(globalThis, 'setInterval')
  clear = vi.spyOn(globalThis, 'clearInterval')
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CiDuration', () => {
  it('shares one interval between five running items and clears it when the last unmounts', async () => {
    const views = Array.from({ length: 5 }, () => render({ item: running }))
    expect(set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(views[0]?.text()).toBe('13 s')
    for (const view of views.slice(0, 4)) view.unmount()
    expect(clear).not.toHaveBeenCalled()
    views[4]?.unmount()
    expect(clear).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('never subscribes for a finished item and shows its fixed time', async () => {
    const view = render({ item: finished, prefix: ' · ' })
    expect(set).not.toHaveBeenCalled()
    expect(view.text()).toBe('· 45 s')
    view.unmount()
  })

  it('renders nothing and creates no timer for an item without dates', () => {
    const view = render({ item: { status: 'completed' } })
    expect(view.text()).toBe('')
    expect(set).not.toHaveBeenCalled()
    view.unmount()
  })

  it('shows the wall-clock span of a list with a Total label', () => {
    const view = render({ items: [finished, { ...finished, startedAt: iso(5), completedAt: iso(60) }], total: true })
    expect(view.text()).toBe('Total: 1 min 00 s')
    view.unmount()
  })

  it('shows nothing for a running item and no timer when not live', () => {
    const view = render({ item: running, live: false })
    expect(view.text()).toBe('')
    expect(set).not.toHaveBeenCalled()
    view.unmount()
  })
})
