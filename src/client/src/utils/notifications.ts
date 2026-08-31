import { Notify } from 'quasar'
import { useSettingsStore } from 'src/stores/settings'
import { DEFAULT_NOTIFICATION_SOUND, resolveSoundId, soundUrl } from 'src/utils/notification-sounds'

const audioCache = new Map<string, HTMLAudioElement>()

interface QueuedSound {
  soundId: string
  volume: number
}

const soundQueue: QueuedSound[] = []
let queuePlaying = false

function getAudio(soundId: string): HTMLAudioElement {
  let audio = audioCache.get(soundId)
  if (!audio) {
    audio = new Audio(soundUrl(soundId))
    audioCache.set(soundId, audio)
  }
  return audio
}

/**
 * Background tabs can defer `ended` events for HTML media. Notification sounds
 * must not sit behind a queued sound whose completion the browser postponed,
 * so background notifications get their own short-lived player.
 */
function playBackgroundNotificationSound(soundId: string, volume: number): void {
  const audio = new Audio(soundUrl(resolveSoundId(soundId)))
  audio.preload = 'auto'
  audio.volume = volume
  audio.play().catch(() => {
    // A browser may still require a prior user interaction before allowing
    // background media. There is no safe way to override that browser policy.
  })
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

function playNextQueuedSound(): void {
  const next = soundQueue.shift()
  if (!next) {
    queuePlaying = false
    return
  }

  queuePlaying = true
  const audio = getAudio(resolveSoundId(next.soundId))
  audio.volume = next.volume
  audio.currentTime = 0
  let advanced = false

  const advance = () => {
    if (advanced) return
    advanced = true
    audio.removeEventListener('ended', advance)
    audio.removeEventListener('error', advance)
    playNextQueuedSound()
  }

  audio.addEventListener('ended', advance, { once: true })
  audio.addEventListener('error', advance, { once: true })
  audio.play().catch(advance)
}

export function queueNotificationSound(soundId: string, volume?: number | null): void {
  const queued = { soundId: resolveSoundId(soundId), volume: clampVolume(volume) }
  if (document.visibilityState === 'hidden') {
    playBackgroundNotificationSound(queued.soundId, queued.volume)
    return
  }
  soundQueue.push(queued)
  if (!queuePlaying) playNextQueuedSound()
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
export function notify(
  title: string,
  body?: string,
  workspaceId?: string,
  soundOverride?: string | null,
  volumeOverride?: number,
  audioEnabled?: boolean,
): void {
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

  // Sound plays regardless of focus. `undefined` or an empty override inherits
  // the general sound, while `null` explicitly keeps the notification silent.
  if ((audioEnabled ?? settings.global.audioNotifications) && soundOverride !== null) {
    const sound =
      soundOverride && soundOverride.length > 0
        ? soundOverride
        : (settings.global.audioNotificationSound ?? DEFAULT_NOTIFICATION_SOUND)
    queueNotificationSound(sound, volumeOverride ?? settings.global.audioNotificationVolume)
  }
}

export interface RetryableErrorOptions {
  /** Already translated by the caller — this module has no i18n context. */
  retryLabel: string
  onRetry: () => void
  detailsLabel?: string
  onDetails?: () => void
  /** Required for the same reason `retryLabel` is: an internal English default
   *  would be a user-visible string no locale file can reach. */
  dismissLabel: string
  /** Milliseconds. Defaults to 0 (stays until dismissed). */
  timeout?: number
}

/**
 * A failure notification the user can actually act on.
 *
 * Every error toast in the client used to be a dead end: read it, watch it
 * vanish after six seconds, redo the gesture by hand. The default timeout is
 * 0 on purpose — a toast carrying a button the user must click cannot also
 * dismiss itself while they read it. Retry is never invented by this helper:
 * the caller decides whether an action is safe to offer, exactly like the
 * network helper leaves retry to the caller.
 */
export function notifyRetryableError(message: string, options: RetryableErrorOptions): void {
  const actions: Array<{ label: string; color: string; handler?: () => void }> = [
    { label: options.retryLabel, color: 'white', handler: options.onRetry },
  ]
  if (options.detailsLabel && options.onDetails) {
    actions.push({ label: options.detailsLabel, color: 'white', handler: options.onDetails })
  }
  actions.push({ label: options.dismissLabel, color: 'grey-5' })

  Notify.create({
    type: 'negative',
    position: 'top',
    multiLine: true,
    message,
    timeout: options.timeout ?? 0,
    actions,
  })
}
