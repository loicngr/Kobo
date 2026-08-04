import { describe, expect, it, vi } from 'vitest'
import { playWhipCrack } from '../utils/whip-audio'

function createFakeAudioContext() {
  const frequency = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
  const gainValue = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
  const oscillator = {
    type: 'sine',
    frequency,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  }
  const gain = {
    gain: gainValue,
    connect: vi.fn(),
  }
  const context = {
    currentTime: 2,
    destination: { name: 'destination' },
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
    close: vi.fn(async () => undefined),
  }

  return { context, frequency, gainValue, oscillator, gain }
}

describe('whip audio', () => {
  it('does not create an audio context when sound is disabled', () => {
    const createAudioContext = vi.fn()

    playWhipCrack({ enabled: false, volume: 1, createAudioContext })

    expect(createAudioContext).not.toHaveBeenCalled()
  })

  it('synthesizes a short frequency and gain sweep at clamped volume', async () => {
    const { context, frequency, gainValue, oscillator, gain } = createFakeAudioContext()

    playWhipCrack({
      enabled: true,
      volume: 2,
      createAudioContext: () => context as unknown as AudioContext,
    })

    expect(oscillator.type).toBe('square')
    expect(frequency.setValueAtTime).toHaveBeenCalledWith(1_800, 2)
    expect(frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(120, 2.09)
    expect(gainValue.setValueAtTime).toHaveBeenCalledWith(1, 2)
    expect(gainValue.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 2.09)
    expect(oscillator.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(context.destination)
    expect(oscillator.start).toHaveBeenCalledWith(2)
    expect(oscillator.stop).toHaveBeenCalledWith(2.1)

    oscillator.onended?.()
    await Promise.resolve()
    expect(context.close).toHaveBeenCalledOnce()
  })
})
