import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WhipOverlay from '../components/WhipOverlay.vue'
import en from '../i18n/en'
import { playWhipCrack } from '../utils/whip-audio'
import { dropWhip, stepWhip, WHIP_CONFIG } from '../utils/whip-physics'

const physics = vi.hoisted(() => ({
  result: { cracked: false, offscreen: false },
  state: {
    points: [
      { x: 10, y: 20, previousX: 10, previousY: 20 },
      { x: 30, y: 35, previousX: 30, previousY: 35 },
      { x: 50, y: 45, previousX: 50, previousY: 45 },
    ],
    dropping: false,
    spawnedAt: 0,
    lastCrackAt: Number.NEGATIVE_INFINITY,
  },
}))

vi.mock('../utils/whip-physics', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/whip-physics')>()
  return {
    ...original,
    createWhip: vi.fn(() => physics.state),
    dropWhip: vi.fn(),
    stepWhip: vi.fn(() => physics.result),
  }
})

vi.mock('../utils/whip-audio', () => ({
  playWhipCrack: vi.fn(),
}))

const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  lineCap: 'round',
  lineJoin: 'round',
  strokeStyle: '',
  lineWidth: 1,
}

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const mountedOverlays: ReturnType<typeof mount>[] = []

function mountOverlay(props = { soundEnabled: true, soundVolume: 0.4 }) {
  const wrapper = mount(WhipOverlay, {
    attachTo: document.body,
    props,
    global: { plugins: [i18n] },
  })
  mountedOverlays.push(wrapper)
  return wrapper
}

function unmountOverlay(wrapper: (typeof mountedOverlays)[number]): void {
  wrapper.unmount()
  const index = mountedOverlays.indexOf(wrapper)
  if (index >= 0) mountedOverlays.splice(index, 1)
}

describe('WhipOverlay', () => {
  let animationCallback: FrameRequestCallback | undefined
  const cancelAnimationFrame = vi.fn()

  beforeEach(() => {
    physics.result = { cracked: false, offscreen: false }
    physics.state.lastCrackAt = Number.NEGATIVE_INFINITY
    animationCallback = undefined
    vi.clearAllMocks()
    vi.mocked(stepWhip).mockImplementation(() => physics.result)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        animationCallback = callback
        return 42
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
  })

  afterEach(() => {
    for (const wrapper of mountedOverlays.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('emits each detected crack and plays sound with the supplied preferences', () => {
    const wrapper = mountOverlay()
    physics.result = { cracked: true, offscreen: false }

    animationCallback?.(16)

    expect(wrapper.emitted('crack')).toHaveLength(1)
    expect(playWhipCrack).toHaveBeenCalledWith({ enabled: true, volume: 0.4 })
  })

  it('caps the canvas backing store at twice the viewport size on high-DPR displays', () => {
    vi.stubGlobal('devicePixelRatio', 3)

    mountOverlay()
    const canvas = document.querySelector<HTMLCanvasElement>('.whip-canvas')!

    expect(canvas.width).toBeLessThanOrEqual(window.innerWidth * 2)
    expect(canvas.height).toBeLessThanOrEqual(window.innerHeight * 2)
  })

  it('drops on primary pointer input and closes on Escape', () => {
    const wrapper = mountOverlay()
    const canvas = document.querySelector<HTMLCanvasElement>('.whip-canvas')

    canvas?.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(dropWhip).toHaveBeenCalledWith(physics.state)
    expect(wrapper.emitted('closed')).toHaveLength(1)
  })

  it('focuses an accessible dialog, activates it with the keyboard, and restores focus on unmount', () => {
    const previousButton = document.createElement('button')
    document.body.append(previousButton)
    previousButton.focus()

    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Interactive whip')
    expect(dialog.getAttribute('aria-describedby')).toBe('whip-overlay-instructions')
    expect(document.activeElement).toBe(dialog)
    expect(document.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true')

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    dialog.dispatchEvent(enter)

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)
    expect(enter.defaultPrevented).toBe(true)

    unmountOverlay(wrapper)

    expect(document.activeElement).toBe(previousButton)
  })

  it('traps Tab and Shift+Tab focus on the dialog', () => {
    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    dialog.dispatchEvent(tab)

    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)

    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    dialog.dispatchEvent(shiftTab)

    expect(shiftTab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)
    expect(wrapper.emitted('crack')).toBeUndefined()
  })

  it('prevents repeated and cooldown Space keys without emitting another crack', () => {
    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    const firstSpace = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    dialog.dispatchEvent(firstSpace)
    const repeatedSpace = new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true })
    dialog.dispatchEvent(repeatedSpace)
    const cooldownSpace = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    dialog.dispatchEvent(cooldownSpace)

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)
    expect(firstSpace.defaultPrevented).toBe(true)
    expect(repeatedSpace.defaultPrevented).toBe(true)
    expect(cooldownSpace.defaultPrevented).toBe(true)
  })

  it('prevents repeated Enter keys without emitting another crack', () => {
    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    const firstEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    dialog.dispatchEvent(firstEnter)
    const repeatedEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(repeatedEnter)

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)
    expect(firstEnter.defaultPrevented).toBe(true)
    expect(repeatedEnter.defaultPrevented).toBe(true)
  })

  it('shares the keyboard crack cooldown with the next physics frame', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.mocked(stepWhip).mockImplementation((state, input) => ({
      cracked: input.now - state.lastCrackAt >= WHIP_CONFIG.crackCooldownMs,
      offscreen: false,
    }))
    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    animationCallback?.(101)

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)
  })

  it('closes when the dropped rope leaves the viewport and cancels its frame on unmount', () => {
    const wrapper = mountOverlay({ soundEnabled: false, soundVolume: 0 })
    physics.result = { cracked: false, offscreen: true }

    animationCallback?.(16)
    expect(stepWhip).toHaveBeenCalled()
    expect(wrapper.emitted('closed')).toHaveLength(1)

    unmountOverlay(wrapper)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })
})
