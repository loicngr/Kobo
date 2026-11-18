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
    playNotificationSound('ready.wav', 5)
    expect(instances[0]?.volume).toBe(1)
  })

  it('clamps negative volume up to 0', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('ready.wav', -0.4)
    expect(instances[0]?.volume).toBe(0)
  })

  it('falls back to volume=1 when volume is undefined', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('neutral.wav')
    expect(instances[0]?.volume).toBe(1)
  })

  it('falls back to volume=1 when volume is NaN', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('neutral.wav', Number.NaN)
    expect(instances[0]?.volume).toBe(1)
  })

  it('applies a precise volume value (0.42) verbatim', async () => {
    const { playNotificationSound } = await import('../utils/notifications')
    playNotificationSound('neutral.wav', 0.42)
    expect(instances[0]?.volume).toBe(0.42)
  })

  it('plays queued sounds strictly one at a time', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')

    queueNotificationSound('neutral.wav', 0.25)
    queueNotificationSound('ready.wav', 0.75)

    expect(instances).toHaveLength(1)
    expect(instances[0]?.src).toContain('/sounds/neutral.wav')
    expect(instances[0]?.volume).toBe(0.25)

    instances[0]?.emit('ended')

    expect(instances).toHaveLength(2)
    expect(instances[1]?.src).toContain('/sounds/ready.wav')
    expect(instances[1]?.volume).toBe(0.75)
  })

  it('plays background notifications immediately instead of waiting for the queue', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const { queueNotificationSound } = await import('../utils/notifications')

    queueNotificationSound('neutral.wav', 0.4)
    queueNotificationSound('ready.wav', 0.7)

    expect(instances).toHaveLength(2)
    expect(instances[0]?.play).toHaveBeenCalledOnce()
    expect(instances[1]?.play).toHaveBeenCalledOnce()
    expect(instances[1]?.volume).toBe(0.7)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('advances after a media error', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')
    queueNotificationSound('neutral.wav')
    queueNotificationSound('ready.wav')

    instances[0]?.emit('error')

    expect(instances[1]?.play).toHaveBeenCalledOnce()
  })

  it('advances after play rejects', async () => {
    const { queueNotificationSound } = await import('../utils/notifications')
    rejectNextPlay = true
    queueNotificationSound('neutral.wav')
    queueNotificationSound('ready.wav')

    await Promise.resolve()
    await Promise.resolve()

    expect(instances.at(-1)?.src).toContain('/sounds/ready.wav')
  })

  it('does not enqueue audio for an explicit null override', async () => {
    setActivePinia(createPinia())
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore().global.audioNotifications = true
    const { notify } = await import('../utils/notifications')

    notify('Muted event', undefined, 'w1', null)

    expect(instances).toHaveLength(0)
  })

  it('queues an override with its per-event volume', async () => {
    setActivePinia(createPinia())
    const { notify } = await import('../utils/notifications')

    notify('Question', undefined, 'w1', 'ready.wav', 0.42, true)

    expect(instances).toHaveLength(1)
    expect(instances[0]?.src).toContain('/sounds/ready.wav')
    expect(instances[0]?.volume).toBe(0.42)
  })

  it('honors a disabled per-event audio toggle', async () => {
    setActivePinia(createPinia())
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore().global.audioNotifications = true
    const { notify } = await import('../utils/notifications')

    notify('Question', undefined, 'w1', 'ready.wav', 0.42, false)

    expect(instances).toHaveLength(0)
  })

  describe('per-workspace notification prefs', () => {
    const OFF = {
      muteBrowser: false,
      muteSound: false,
      muteToast: false,
      muteDrawer: false,
      keepQuestions: false,
    }
    const browserSpy = vi.fn()

    async function setup(prefs?: Partial<typeof OFF>, soundGlobal = true) {
      setActivePinia(createPinia())
      const { useSettingsStore } = await import('../stores/settings')
      const { useWorkspaceStore } = await import('../stores/workspace')
      const settings = useSettingsStore()
      settings.global.audioNotifications = soundGlobal
      settings.global.browserNotifications = true
      if (prefs) {
        useWorkspaceStore().workspaces = [
          { id: 'w1', notificationPrefs: { ...OFF, ...prefs } } as unknown as import('../stores/workspace').Workspace,
        ]
      }
      return (await import('../utils/notifications')).notify
    }

    beforeEach(() => {
      browserSpy.mockClear()
      vi.stubGlobal(
        'Notification',
        Object.assign(
          class {
            constructor(title: string) {
              browserSpy(title)
            }
          },
          { permission: 'granted' },
        ),
      )
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    })

    it('does not mute anything when the workspace is unknown', async () => {
      const notify = await setup()
      notify('Done', undefined, 'w1', 'ready.wav', 1, true)
      expect(instances).toHaveLength(1)
      expect(browserSpy).toHaveBeenCalledOnce()
    })

    it('muteBrowser silences only the browser notification', async () => {
      const notify = await setup({ muteBrowser: true })
      notify('Done', undefined, 'w1', 'ready.wav', 1, true)
      expect(browserSpy).not.toHaveBeenCalled()
      expect(instances).toHaveLength(1)
    })

    it('muteSound silences only the sound', async () => {
      const notify = await setup({ muteSound: true })
      notify('Done', undefined, 'w1', 'ready.wav', 1, true)
      expect(instances).toHaveLength(0)
      expect(browserSpy).toHaveBeenCalledOnce()
    })

    it('keepQuestions restores the sound for a question but not for a plain event', async () => {
      const notify = await setup({ muteSound: true, keepQuestions: true })
      notify('Done', undefined, 'w1', 'ready.wav', 1, true)
      expect(instances).toHaveLength(0)
      notify('Question', undefined, 'w1', 'ready.wav', 1, true, undefined, { question: true })
      expect(instances).toHaveLength(1)
    })

    it('keepQuestions never restores the browser notification', async () => {
      const notify = await setup({ muteBrowser: true, keepQuestions: true })
      notify('Question', undefined, 'w1', 'ready.wav', 1, true, undefined, { question: true })
      expect(browserSpy).not.toHaveBeenCalled()
    })

    it('a globally disabled sound stays silent even for a kept question', async () => {
      const notify = await setup({ muteSound: true, keepQuestions: true }, false)
      notify('Question', undefined, 'w1', undefined, undefined, undefined, undefined, { question: true })
      expect(instances).toHaveLength(0)
    })
  })
})
