import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let rejectNextPlay = false

class FakeAudio {
  src: string
  volume = 1
  currentTime = 0
  rejectPlay = false
  private listeners = new Map<string, Set<() => void>>()
  play = vi.fn(() => (this.rejectPlay ? Promise.reject(new Error('blocked')) : Promise.resolve()))

  constructor(src: string) {
    this.src = src
    this.rejectPlay = rejectNextPlay
    rejectNextPlay = false
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: 'ended' | 'error'): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

let instances: FakeAudio[] = []

describe('playNotificationSound() volume application', () => {
  beforeEach(() => {
    instances = []
    rejectNextPlay = false
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

  it('plays queued sounds strictly one at a time', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')

    queueNotificationSound('hey.mp3', 0.25)
    queueNotificationSound('faaah.mp3', 0.75)

    expect(instances).toHaveLength(1)
    expect(instances[0]?.src).toContain('/sounds/hey.mp3')
    expect(instances[0]?.volume).toBe(0.25)

    instances[0]?.emit('ended')

    expect(instances).toHaveLength(2)
    expect(instances[1]?.src).toContain('/sounds/faaah.mp3')
    expect(instances[1]?.volume).toBe(0.75)
  })

  it('advances after a media error', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')
    queueNotificationSound('hey.mp3')
    queueNotificationSound('faaah.mp3')

    instances[0]?.emit('error')

    expect(instances[1]?.play).toHaveBeenCalledOnce()
  })

  it('advances after play rejects', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')
    rejectNextPlay = true
    queueNotificationSound('hey.mp3')
    queueNotificationSound('faaah.mp3')

    await Promise.resolve()
    await Promise.resolve()

    expect(instances.at(-1)?.src).toContain('/sounds/faaah.mp3')
  })

  it('does not enqueue audio for an explicit null override', async () => {
    setActivePinia(createPinia())
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore().global.audioNotifications = true
    const { notify } = await import('../utils/notifications')

    notify('Muted event', undefined, 'w1', null)

    expect(instances).toHaveLength(0)
  })
})
