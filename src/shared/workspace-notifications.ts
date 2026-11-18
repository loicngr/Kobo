/** Per-workspace notification muting: five booleans stored as JSON in `workspaces.notification_prefs`. */
export interface WorkspaceNotificationPrefs {
  muteBrowser: boolean
  muteSound: boolean
  muteToast: boolean
  muteDrawer: boolean
  keepQuestions: boolean
}

export const DEFAULT_WORKSPACE_NOTIFICATION_PREFS: WorkspaceNotificationPrefs = {
  muteBrowser: false,
  muteSound: false,
  muteToast: false,
  muteDrawer: false,
  keepQuestions: false,
}

export const MUTE_KEYS = ['muteBrowser', 'muteSound', 'muteToast', 'muteDrawer'] as const

const PREF_KEYS = Object.keys(DEFAULT_WORKSPACE_NOTIFICATION_PREFS) as (keyof WorkspaceNotificationPrefs)[]

/** Keeps known keys whose value is exactly `true`; everything else falls back to the default. */
export function normalizeWorkspaceNotificationPrefs(value: unknown): WorkspaceNotificationPrefs {
  const result = { ...DEFAULT_WORKSPACE_NOTIFICATION_PREFS }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const key of PREF_KEYS) result[key] = record[key] === true
  return result
}

export function isDefaultWorkspaceNotificationPrefs(p: WorkspaceNotificationPrefs): boolean {
  return PREF_KEYS.every((key) => !p[key])
}

export function hasAnyMute(p: WorkspaceNotificationPrefs): boolean {
  return MUTE_KEYS.some((key) => p[key])
}

export function withAllMuted(p: WorkspaceNotificationPrefs, muted: boolean): WorkspaceNotificationPrefs {
  return { ...p, muteBrowser: muted, muteSound: muted, muteToast: muted, muteDrawer: muted }
}

export function allowsSound(p: WorkspaceNotificationPrefs | undefined, question: boolean): boolean {
  return !p?.muteSound || (p.keepQuestions && question)
}

export function allowsToast(p: WorkspaceNotificationPrefs | undefined, question: boolean): boolean {
  return !p?.muteToast || (p.keepQuestions && question)
}

/** `keepQuestions` never restores browser notifications. */
export function allowsBrowser(p: WorkspaceNotificationPrefs | undefined): boolean {
  return !p?.muteBrowser
}

export function showsDrawerSignals(p: WorkspaceNotificationPrefs | undefined): boolean {
  return !p?.muteDrawer
}
