import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WhipOverlay from '../components/WhipOverlay.vue'
import en from '../i18n/en'
import { playWhipCrack } from '../utils/whip-audio'
import { dropWhip, stepWhip } from '../utils/whip-physics'

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

function mountOverlay(props = { soundEnabled: true, soundVolume: 0.4 }) {
  return mount(WhipOverlay, {
    attachTo: document.body,
    props,
    global: { plugins: [i18n] },
  })
}

describe('WhipOverlay', () => {
  let animationCallback: FrameRequestCallback | undefined
  const cancelAnimationFrame = vi.fn()

  beforeEach(() => {
    physics.result = { cracked: false, offscreen: false }
    animationCallback = undefined
    vi.clearAllMocks()
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

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)

    wrapper.unmount()

    expect(document.activeElement).toBe(previousButton)
  })

  it('activates with Space once and ignores repeated keys and cooldown duplicates', () => {
    const wrapper = mountOverlay()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(playWhipCrack).toHaveBeenCalledOnce()
    expect(wrapper.emitted('crack')).toHaveLength(1)
  })

  it('closes when the dropped rope leaves the viewport and cancels its frame on unmount', () => {
    const wrapper = mountOverlay({ soundEnabled: false, soundVolume: 0 })
    physics.result = { cracked: false, offscreen: true }

    animationCallback?.(16)
    expect(stepWhip).toHaveBeenCalled()
    expect(wrapper.emitted('closed')).toHaveLength(1)

    wrapper.unmount()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })
})
