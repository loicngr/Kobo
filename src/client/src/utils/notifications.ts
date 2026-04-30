import { useSettingsStore } from 'src/stores/settings'

let audioElement: HTMLAudioElement | null = null

function getAudio(): HTMLAudioElement {
  if (!audioElement) {
    audioElement = new Audio('/notification.mp3')
  }
  return audioElement
}

/** Request browser notification permission if not already granted. */
export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
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
    const audio = getAudio()
    audio.currentTime = 0
    audio.play().catch(() => {
      /* browser may block autoplay */
    })
  }
}
