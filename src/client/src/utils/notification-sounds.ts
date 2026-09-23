import { customSoundId, customSoundReference, isCustomNotificationSound } from '../../../shared/notification-assets'

export const SOUNDS_DIR = '/sounds'

export interface NotificationSound {
  id: string
  labelKey: string
}

export const NOTIFICATION_SOUNDS: readonly NotificationSound[] = [
  { id: 'neutral.wav', labelKey: 'settings.notificationSoundBasic' },
  { id: 'ready.wav', labelKey: 'settings.notificationSoundReady' },
]

export const DEFAULT_NOTIFICATION_SOUND = 'neutral.wav'
export const INHERIT_NOTIFICATION_SOUND = 'inherit'
export const NO_NOTIFICATION_SOUND = 'none'
export const DEFAULT_WORKSPACE_CREATED_SOUND = INHERIT_NOTIFICATION_SOUND

export const PR_NOTIFICATION_SOUND_SETTING_KEYS = [
  'audioPrCiFailedSound',
  'audioPrCiRecoveredSound',
  'audioPrChangesRequestedSound',
  'audioPrApprovedSound',
  'audioPrMergeConflictSound',
  'audioPrReadyToMergeSound',
  'audioPrMergedSound',
] as const

export type PrNotificationSoundSettingKey = (typeof PR_NOTIFICATION_SOUND_SETTING_KEYS)[number]
export type PrNotificationSoundSettings = Record<PrNotificationSoundSettingKey, string>

export const PR_NOTIFICATION_AUDIO_CONTROL_SETTING_KEYS = [
  'audioPrCiFailedEnabled',
  'audioPrCiFailedVolume',
  'audioPrCiRecoveredEnabled',
  'audioPrCiRecoveredVolume',
  'audioPrChangesRequestedEnabled',
  'audioPrChangesRequestedVolume',
  'audioPrApprovedEnabled',
  'audioPrApprovedVolume',
  'audioPrMergeConflictEnabled',
  'audioPrMergeConflictVolume',
  'audioPrReadyToMergeEnabled',
  'audioPrReadyToMergeVolume',
  'audioPrMergedEnabled',
  'audioPrMergedVolume',
] as const

export type PrNotificationAudioControlSettingKey = (typeof PR_NOTIFICATION_AUDIO_CONTROL_SETTING_KEYS)[number]

export type PrNotificationAudioSettings = PrNotificationSoundSettings & {
  audioPrCiFailedEnabled: boolean
  audioPrCiFailedVolume: number
  audioPrCiRecoveredEnabled: boolean
  audioPrCiRecoveredVolume: number
  audioPrChangesRequestedEnabled: boolean
  audioPrChangesRequestedVolume: number
  audioPrApprovedEnabled: boolean
  audioPrApprovedVolume: number
  audioPrMergeConflictEnabled: boolean
  audioPrMergeConflictVolume: number
  audioPrReadyToMergeEnabled: boolean
  audioPrReadyToMergeVolume: number
  audioPrMergedEnabled: boolean
  audioPrMergedVolume: number
}

export const DEFAULT_PR_NOTIFICATION_SOUND_SETTINGS: Readonly<PrNotificationSoundSettings> = {
  audioPrCiFailedSound: INHERIT_NOTIFICATION_SOUND,
  audioPrCiRecoveredSound: INHERIT_NOTIFICATION_SOUND,
  audioPrChangesRequestedSound: INHERIT_NOTIFICATION_SOUND,
  audioPrApprovedSound: INHERIT_NOTIFICATION_SOUND,
  audioPrMergeConflictSound: INHERIT_NOTIFICATION_SOUND,
  audioPrReadyToMergeSound: INHERIT_NOTIFICATION_SOUND,
  audioPrMergedSound: INHERIT_NOTIFICATION_SOUND,
}

export const DEFAULT_PR_NOTIFICATION_AUDIO_SETTINGS: Readonly<PrNotificationAudioSettings> = {
  ...DEFAULT_PR_NOTIFICATION_SOUND_SETTINGS,
  audioPrCiFailedEnabled: false,
  audioPrCiFailedVolume: 1,
  audioPrCiRecoveredEnabled: false,
  audioPrCiRecoveredVolume: 1,
  audioPrChangesRequestedEnabled: false,
  audioPrChangesRequestedVolume: 1,
  audioPrApprovedEnabled: false,
  audioPrApprovedVolume: 1,
  audioPrMergeConflictEnabled: false,
  audioPrMergeConflictVolume: 1,
  audioPrReadyToMergeEnabled: false,
  audioPrReadyToMergeVolume: 1,
  audioPrMergedEnabled: false,
  audioPrMergedVolume: 1,
}

/**
 * Sounds the user imported. They live under the Kōbō home, not in the bundle,
 * so the catalogue is only known once the custom-sounds store has loaded it.
 * Kept as a plain set: `resolveSoundId` runs outside any component, and a
 * selection pointing at a deleted sound must fall back rather than fail.
 */
const customSoundUrls = new Map<string, string>()

export function setKnownCustomSoundIds(values: readonly string[]): void {
  const next = new Map<string, string>()
  for (const value of values) {
    const reference = isCustomNotificationSound(value) ? value : customSoundReference(value)
    // Keep an already resolved blob URL so a refresh does not re-download.
    if (isCustomNotificationSound(reference))
      next.set(reference, customSoundUrls.get(reference) ?? customSoundApiUrl(reference))
  }
  customSoundUrls.clear()
  for (const [reference, url] of next) customSoundUrls.set(reference, url)
}

/**
 * Point a known sound at a local blob URL. A media element is not routed
 * through the wrapped `window.fetch`, so it carries no `X-Kobo-Token` and the
 * API URL answers 401 over LAN access or behind a reverse proxy — the very
 * setups this server-side storage exists for. Same approach as
 * `services/authenticated-images.ts`.
 */
export function setCustomSoundUrl(reference: string, url: string): void {
  if (customSoundUrls.has(reference)) customSoundUrls.set(reference, url)
}

export function customSoundApiUrl(reference: string): string {
  return `/api/sounds/${customSoundId(reference)}/file`
}

export function isKnownSoundId(id: string): boolean {
  if (isCustomNotificationSound(id)) return customSoundUrls.has(id)
  return NOTIFICATION_SOUNDS.some((s) => s.id === id)
}

/**
 * Shape check only, for the settings form. `isKnownSoundId` answers "can this
 * be played right now", which is false for an imported sound until the
 * catalogue loads — and the form writes its value straight back on save, so
 * using it there would silently erase the user's selection.
 */
export function isSelectableSoundId(id: unknown): id is string {
  return typeof id === 'string' && (isCustomNotificationSound(id) || NOTIFICATION_SOUNDS.some((s) => s.id === id))
}

export function resolveSoundIdForForm(value: unknown): string {
  return isSelectableSoundId(value) ? value : DEFAULT_NOTIFICATION_SOUND
}

export function normalizeSoundSelectionForForm(value: unknown): string {
  if (value === NO_NOTIFICATION_SOUND || value === INHERIT_NOTIFICATION_SOUND) return value
  return isSelectableSoundId(value) ? value : INHERIT_NOTIFICATION_SOUND
}

export function resolveSoundId(id: string | undefined | null): string {
  return id && isKnownSoundId(id) ? id : DEFAULT_NOTIFICATION_SOUND
}

export function resolveNotificationSoundOverride(value: unknown): string | null | undefined {
  if (value === NO_NOTIFICATION_SOUND) return null
  if (value === INHERIT_NOTIFICATION_SOUND) return undefined
  return typeof value === 'string' && isKnownSoundId(value) ? value : undefined
}

export function normalizeNotificationSoundSelection(value: unknown): string {
  const resolved = resolveNotificationSoundOverride(value)
  if (resolved === null) return NO_NOTIFICATION_SOUND
  return resolved ?? INHERIT_NOTIFICATION_SOUND
}

export function soundUrl(id: string): string {
  const resolved = resolveSoundId(id)
  return isCustomNotificationSound(resolved)
    ? (customSoundUrls.get(resolved) ?? customSoundApiUrl(resolved))
    : `${SOUNDS_DIR}/${resolved}`
}
