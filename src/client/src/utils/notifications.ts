import { useSettingsStore } from 'src/stores/settings'
import { DEFAULT_NOTIFICATION_SOUND, resolveSoundId, soundUrl } from 'src/utils/notification-sounds'

const audioCache = new Map<string, HTMLAudioElement>()

function getAudio(soundId: string): HTMLAudioElement {
  let audio = audioCache.get(soundId)
  if (!audio) {
    audio = new Audio(soundUrl(soundId))
    audioCache.set(soundId, audio)
  }
  return audio
}

/** Request browser notification permission if not already granted. */
export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function clampVolume(v: number | undefined | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.max(0, Math.min(1, v))
}

/**
 * Play a sound by id at a given volume (used both by `notify()` and by the
 * Settings preview button). Volume is clamped to [0, 1]; non-finite or missing
 * values fall back to 1.
 */
export function playNotificationSound(soundId: string, volume?: number | null): void {
  const audio = getAudio(resolveSoundId(soundId))
  audio.volume = clampVolume(volume)
  audio.currentTime = 0
  audio.play().catch(() => {
    /* browser may block autoplay */
  })
}

/** Send a browser notification and/or play a sound based on global settings. */
export function notify(title: string, body?: string, workspaceId?: string): void {
  const settings = useSettingsStore()

  // Browser notification only when the tab is not focused
  if (
    !document.hasFocus() &&
    settings.global.browserNotifications &&
    'Notification' in window &&
    Notification.permission === 'granted'
  ) {
    const n = new Notification(title, {
      body,
      icon: '/favicon.ico',
    })
    if (workspaceId) {
      n.onclick = () => {
        window.focus()
        window.location.hash = `#/workspace/${workspaceId}`
        n.close()
      }
    }
  }

  // Sound plays regardless of focus
  if (settings.global.audioNotifications) {
    playNotificationSound(
      settings.global.audioNotificationSound ?? DEFAULT_NOTIFICATION_SOUND,
      settings.global.audioNotificationVolume,
    )
  }
}
