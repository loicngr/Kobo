import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anchorPresent, clickAnchor, waitForVisible } from '../tours/dom'

/** happy-dom lays nothing out: give `el` a box (and a rect) by hand. */
function layOut(el: HTMLElement, rect: Partial<DOMRect>): void {
  Object.defineProperty(el, 'offsetWidth', { value: 10, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: 10, configurable: true })
  el.getClientRects = () => [{}] as unknown as DOMRectList
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, ...rect }) as DOMRect
}

describe('anchorPresent', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is false when no element carries the data-tour attribute', () => {
    expect(anchorPresent('create-brainstorm')).toBe(false)
  })

  it('is true once an element carries the data-tour attribute', () => {
    document.body.innerHTML = '<div data-tour="create-brainstorm"></div>'
    expect(anchorPresent('create-brainstorm')).toBe(true)
    expect(anchorPresent('create-comparison')).toBe(false)
  })
})

describe('waitForVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('resolves true once the element has a rect inside the viewport', async () => {
    const pending = waitForVisible('[data-tour="x"]', 1000)
    await vi.advanceTimersByTimeAsync(100)
    const el = document.createElement('div')
    el.dataset.tour = 'x'
    layOut(el, {})
    document.body.appendChild(el)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false after the timeout when the element never shows up', async () => {
    const pending = waitForVisible('[data-tour="missing"]', 500)
    await vi.advanceTimersByTimeAsync(600)
    await expect(pending).resolves.toBe(false)
  })

  it('resolves false when the element has a box but sits entirely off-screen', async () => {
    const el = document.createElement('div')
    el.dataset.tour = 'drawer'
    // A Quasar drawer hidden by translateX keeps its size but lives left of the viewport.
    layOut(el, { left: -300, right: -10, x: -300 })
    document.body.appendChild(el)
    const pending = waitForVisible('[data-tour="drawer"]', 200)
    await vi.advanceTimersByTimeAsync(300)
    await expect(pending).resolves.toBe(false)
  })

  it('polls with timers, not animation frames, so hidden tabs still make progress', async () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    try {
      const pending = waitForVisible('[data-tour="missing"]', 100)
      await vi.advanceTimersByTimeAsync(200)
      await expect(pending).resolves.toBe(false)
      expect(raf).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('clickAnchor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('clicks the anchor and reports whether the awaited anchor became visible', async () => {
    const button = document.createElement('button')
    button.dataset.tour = 'open'
    const onClick = vi.fn(() => {
      const panel = document.createElement('div')
      panel.dataset.tour = 'panel'
      layOut(panel, {})
      document.body.appendChild(panel)
    })
    button.addEventListener('click', onClick)
    document.body.appendChild(button)

    const pending = clickAnchor('open', 'panel')
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe(true)
    expect(onClick).toHaveBeenCalledTimes(1)

    const failed = clickAnchor('open', 'never')
    await vi.advanceTimersByTimeAsync(2100)
    await expect(failed).resolves.toBe(false)
  })
})
