import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeAudio {
  src: string
  volume = 1
  currentTime = 0
  play = vi.fn(() => Promise.resolve())
  constructor(src: string) {
    this.src = src
  }
}

let instances: FakeAudio[] = []

describe('playNotificationSound() volume application', () => {
  beforeEach(() => {
    instances = []
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor(src: string) {
          super(src)
          instances.push(this)
        }
      } as unknown as typeof Audio,
    )
    vi.resetModules()
  })

  it('clamps volume above 1 down to 1', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('faaah.mp3', 5)
    expect(instances[0]?.volume).toBe(1)
  })

  it('clamps negative volume up to 0', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('faaah.mp3', -0.4)
    expect(instances[0]?.volume).toBe(0)
  })

  it('falls back to volume=1 when volume is undefined', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('hey.mp3')
    expect(instances[0]?.volume).toBe(1)
  })

  it('falls back to volume=1 when volume is NaN', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('hey.mp3', Number.NaN)
    expect(instances[0]?.volume).toBe(1)
  })

  it('applies a precise volume value (0.42) verbatim', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('hey.mp3', 0.42)
    expect(instances[0]?.volume).toBe(0.42)
  })
})
