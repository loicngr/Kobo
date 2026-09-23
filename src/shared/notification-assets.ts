/** Only original, reproducible sounds are included in the public distribution. */
export const PUBLIC_NOTIFICATION_SOUNDS = ['neutral.wav', 'ready.wav'] as const
export const DEFAULT_PUBLIC_NOTIFICATION_SOUND = PUBLIC_NOTIFICATION_SOUNDS[0]

/**
 * User-imported sounds live in `KOBO_HOME/sounds/` and are referenced as
 * `custom:<id>`. The id is generated server-side, so a reference never carries
 * a user-supplied filename and can never become a path segment on its own.
 */
export const CUSTOM_SOUND_PREFIX = 'custom:'
export const CUSTOM_SOUND_ID_LENGTH = 12
const CUSTOM_SOUND_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${CUSTOM_SOUND_ID_LENGTH}}$`)
export const CUSTOM_SOUND_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.webm'] as const
/** Formats every browser Kōbō targets can decode. */
export const CUSTOM_SOUND_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
}
export const CUSTOM_SOUND_ACCEPT = [...Object.values(CUSTOM_SOUND_CONTENT_TYPES), ...CUSTOM_SOUND_EXTENSIONS].join(',')
/** A notification is short: the largest removed bundled sound was 207 KB. */
export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024
export const MAX_CUSTOM_SOUNDS = 20
export type CustomSoundErrorCode = 'type' | 'size' | 'count'

export function customSoundReference(id: string): string {
  return `${CUSTOM_SOUND_PREFIX}${id}`
}

export function isCustomNotificationSound(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(CUSTOM_SOUND_PREFIX) &&
    CUSTOM_SOUND_ID_PATTERN.test(value.slice(CUSTOM_SOUND_PREFIX.length))
  )
}

/** Returns the bare id of a well-formed reference, or an empty string. */
export function customSoundId(value: unknown): string {
  return isCustomNotificationSound(value) ? value.slice(CUSTOM_SOUND_PREFIX.length) : ''
}

/** Browsers label audio MIME types inconsistently, so the extension decides. */
export function customSoundExtension(name: string): string | null {
  const extension = /\.[^.\\/]+$/.exec(name)?.[0]?.toLowerCase() ?? ''
  return (CUSTOM_SOUND_EXTENSIONS as readonly string[]).includes(extension) ? extension : null
}

/**
 * A custom reference is kept on its shape alone: settings migrations run before
 * the catalogue is readable, and both the client and the file route already fall
 * back to the bundled tone when the file is gone.
 */
export function normalizePublicNotificationSound(value: unknown, allowSentinel = true): string {
  if (allowSentinel && (value === 'inherit' || value === 'none')) return value
  if (isCustomNotificationSound(value)) return value
  return typeof value === 'string' && (PUBLIC_NOTIFICATION_SOUNDS as readonly string[]).includes(value)
    ? value
    : DEFAULT_PUBLIC_NOTIFICATION_SOUND
}

export const NOTIFICATION_SOUND_KEYS = [
  'audioNotificationSound',
  'audioQuestionSound',
  'audioWorkspaceCreatedSound',
  'audioAgentErrorSound',
  'audioPrCiFailedSound',
  'audioPrCiRecoveredSound',
  'audioPrChangesRequestedSound',
  'audioPrApprovedSound',
  'audioPrMergeConflictSound',
  'audioPrReadyToMergeSound',
  'audioPrMergedSound',
] as const

export function normalizePublicSounds(settings: Record<string, unknown>): void {
  for (const key of NOTIFICATION_SOUND_KEYS) {
    if (key in settings)
      settings[key] = normalizePublicNotificationSound(settings[key], key !== 'audioNotificationSound')
  }
}
