export const SOUNDS_DIR = '/sounds'

export interface NotificationSound {
  id: string
  labelKey: string
}

export const NOTIFICATION_SOUNDS: readonly NotificationSound[] = [
  { id: 'hey.mp3', labelKey: 'settings.notificationSoundHey' },
  { id: 'travail_termine.mp3', labelKey: 'settings.notificationSoundTravailTermine' },
  { id: 'faaah.mp3', labelKey: 'settings.notificationSoundFaaah' },
  { id: 'ca_va_peter.mp3', labelKey: 'settings.notificationSoundCaVaPeter' },
  { id: 'dry-fart.mp3', labelKey: 'settings.notificationSoundDryFart' },
  { id: 'for-shure.mp3', labelKey: 'settings.notificationSoundForShure' },
] as const

export const DEFAULT_NOTIFICATION_SOUND = 'hey.mp3'

export function isKnownSoundId(id: string): boolean {
  return NOTIFICATION_SOUNDS.some((s) => s.id === id)
}

export function resolveSoundId(id: string | undefined | null): string {
  return id && isKnownSoundId(id) ? id : DEFAULT_NOTIFICATION_SOUND
}

export function soundUrl(id: string): string {
  return `${SOUNDS_DIR}/${resolveSoundId(id)}`
}
