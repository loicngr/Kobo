import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WhipOverlay from '../components/WhipOverlay.vue'
import { dropWhip, stepWhip } from '../utils/whip-physics'
import { playWhipCrack } from '../utils/whip-audio'

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

describe('WhipOverlay', () => {
  let animationCallback: FrameRequestCallback | undefined
  const cancelAnimationFrame = vi.fn()

  beforeEach(() => {
    physics.result = { cracked: false, offscreen: false }
    animationCallback = undefined
    vi.clearAllMocks()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
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
    const wrapper = mount(WhipOverlay, {
      attachTo: document.body,
      props: { soundEnabled: true, soundVolume: 0.4 },
    })
    physics.result = { cracked: true, offscreen: false }

    animationCallback?.(16)

    expect(wrapper.emitted('crack')).toHaveLength(1)
    expect(playWhipCrack).toHaveBeenCalledWith({ enabled: true, volume: 0.4 })
  })

  it('drops on primary pointer input and closes on Escape', () => {
    const wrapper = mount(WhipOverlay, {
      attachTo: document.body,
      props: { soundEnabled: true, soundVolume: 0.4 },
    })
    const canvas = document.querySelector<HTMLCanvasElement>('.whip-overlay')

    canvas?.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(dropWhip).toHaveBeenCalledWith(physics.state)
    expect(wrapper.emitted('closed')).toHaveLength(1)
  })

  it('closes when the dropped rope leaves the viewport and cancels its frame on unmount', () => {
    const wrapper = mount(WhipOverlay, {
      attachTo: document.body,
      props: { soundEnabled: false, soundVolume: 0 },
    })
    physics.result = { cracked: false, offscreen: true }

    animationCallback?.(16)
    expect(stepWhip).toHaveBeenCalled()
    expect(wrapper.emitted('closed')).toHaveLength(1)

    wrapper.unmount()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })
})
