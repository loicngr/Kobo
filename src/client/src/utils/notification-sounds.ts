export const SOUNDS_DIR = '/sounds'

export interface NotificationSound {
  id: string
  labelKey: string
}

export const NOTIFICATION_SOUNDS: readonly NotificationSound[] = [
  { id: 'basic-notification.mp3', labelKey: 'settings.notificationSoundBasic' },
  { id: 'hey.mp3', labelKey: 'settings.notificationSoundHey' },
  { id: 'warcraft-3-humain-travail.mp3', labelKey: 'settings.notificationSoundWorkspaceCreated' },
  { id: 'travail_termine.mp3', labelKey: 'settings.notificationSoundTravailTermine' },
  { id: 'faaah.mp3', labelKey: 'settings.notificationSoundFaaah' },
  { id: 'ca_va_peter.mp3', labelKey: 'settings.notificationSoundCaVaPeter' },
  { id: 'dry-fart.mp3', labelKey: 'settings.notificationSoundDryFart' },
  { id: 'for-shure.mp3', labelKey: 'settings.notificationSoundForShure' },
  {
    id: '7eme-compagnie-03.mp3',
    labelKey: 'settings.notificationSoundSeptiemeCompagnie03',
  },
  { id: 'aller-ftg.mp3', labelKey: 'settings.notificationSoundAllerFtg' },
  { id: 'arrete-de-mentir.mp3', labelKey: 'settings.notificationSoundArreteDeMentir' },
  {
    id: 'arretez-les-messages.mp3',
    labelKey: 'settings.notificationSoundArretezLesMessages',
  },
  { id: 'bah-alors-on-est-nul.mp3', labelKey: 'settings.notificationSoundBahAlorsOnEstNul' },
  { id: 'gta-v-death.mp3', labelKey: 'settings.notificationSoundGtaVDeath' },
  { id: 'nan-tu-degages.mp3', labelKey: 'settings.notificationSoundNanTuDegages' },
  { id: 'nan-wallah-pardon.mp3', labelKey: 'settings.notificationSoundNanWallahPardon' },
  { id: 'ouais-cest-greg.mp3', labelKey: 'settings.notificationSoundOuaisCestGreg' },
  { id: 'pas-ca-zinedine.mp3', labelKey: 'settings.notificationSoundPasCaZinedine' },
  { id: 'ta-gueule.mp3', labelKey: 'settings.notificationSoundTaGueule' },
  { id: 'tu-vas-la-fermer.mp3', labelKey: 'settings.notificationSoundTuVasLaFermer' },
] as const

export const DEFAULT_NOTIFICATION_SOUND = 'hey.mp3'
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

export function isKnownSoundId(id: string): boolean {
  return NOTIFICATION_SOUNDS.some((s) => s.id === id)
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
  return `${SOUNDS_DIR}/${resolveSoundId(id)}`
}
