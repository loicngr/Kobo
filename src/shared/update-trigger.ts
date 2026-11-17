export const UPDATE_TRIGGER_PHASES = [
  'accepted',
  'building',
  'stopping-agents',
  'restarting',
  'complete',
  'up-to-date',
  'refused',
  'aborted',
  'recovery-required',
] as const
export type UpdateTriggerPhase = (typeof UPDATE_TRIGGER_PHASES)[number]
export const UPDATE_TRIGGER_TERMINAL: readonly UpdateTriggerPhase[] = [
  'complete',
  'up-to-date',
  'refused',
  'aborted',
  'recovery-required',
]
export const UPDATE_TRIGGER_REASONS = [
  'busy',
  'already-running',
  'interrupted-update',
  'legacy-runtime',
  'unknown',
] as const
export type UpdateTriggerReason = (typeof UPDATE_TRIGGER_REASONS)[number]
/** Codes of a refused `POST /api/maintenance/update-trigger` (HTTP 409). */
export type UpdateTriggerErrorCode = 'unavailable' | 'pending' | 'in-progress' | 'not-allowed' | 'busy'

export interface UpdateTriggerRequest {
  id: string
  skipBackup: boolean
  stopAgents: boolean
  requestedAt: string
}

export interface UpdateTriggerStatus {
  id: string
  phase: UpdateTriggerPhase
  reason?: UpdateTriggerReason
  updatedAt: string
}

export interface UpdateTriggerState {
  available: boolean
  pending: boolean
  inProgress: boolean
  status: UpdateTriggerStatus | null
  runningAgents: number
  /** Not idle for an update by the reservation's own rule (live agents, running sessions or busy workspaces). */
  busy: boolean
  /** Host-side opt-ins advertised by the last poll (`--allow-skip-backup`, `--allow-stop-agents`); false while unavailable. */
  allowSkipBackup: boolean
  allowStopAgents: boolean
}
