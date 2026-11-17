import { nanoid } from 'nanoid'
import {
  UPDATE_TRIGGER_TERMINAL,
  type UpdateTriggerPhase,
  type UpdateTriggerReason,
  type UpdateTriggerRequest,
  type UpdateTriggerState,
  type UpdateTriggerStatus,
} from '../../shared/update-trigger.js'
import { agentCountForUpdate, isIdleForUpdate } from './agent/orchestrator.js'

const AVAILABILITY_MS = 180_000
const PENDING_LIFETIME_MS = 180_000
const STALE_STATUS_MS = 90 * 60_000

export type UpdateTriggerErrorCode = 'unavailable' | 'pending' | 'in-progress' | 'busy'

const MESSAGES: Record<UpdateTriggerErrorCode, string> = {
  unavailable: 'No host updater is listening',
  pending: 'An update request is already waiting for the host updater',
  'in-progress': 'An update is already in progress',
  busy: 'Agents are running',
}

export class UpdateTriggerError extends Error {
  constructor(readonly code: UpdateTriggerErrorCode) {
    super(MESSAGES[code])
    this.name = 'UpdateTriggerError'
  }
}

// In-memory only: a backend restart (including the update's own) forgets the request and its
// status. Only a terminal report with an unknown id is adopted again (see reportUpdateTrigger).
let lastPollAt: number | null = null
let pending: { request: UpdateTriggerRequest; at: number } | null = null
let current: { id: string; status: UpdateTriggerStatus; at: number; stopAgents: boolean } | null = null

function expire(now: number): void {
  if (pending && now - pending.at > PENDING_LIFETIME_MS) pending = null
}

function isInProgress(now: number): boolean {
  return !!current && !UPDATE_TRIGGER_TERMINAL.includes(current.status.phase) && now - current.at <= STALE_STATUS_MS
}

export function getUpdateTriggerState(now = Date.now()): UpdateTriggerState {
  expire(now)
  const inProgress = isInProgress(now)
  return {
    // The updater does not poll while it runs an update: that update proves it is alive.
    available: inProgress || (lastPollAt !== null && now - lastPollAt <= AVAILABILITY_MS),
    pending: pending !== null,
    inProgress,
    status: current?.status ?? null,
    runningAgents: agentCountForUpdate(),
    // The same predicate as the reservation the updater takes before stopping Kōbō.
    busy: !isIdleForUpdate(),
  }
}

export function requestUpdate(
  input: { skipBackup: boolean; stopAgents: boolean },
  now = Date.now(),
): UpdateTriggerRequest {
  const state = getUpdateTriggerState(now)
  if (state.pending) throw new UpdateTriggerError('pending')
  if (state.inProgress) throw new UpdateTriggerError('in-progress')
  if (!state.available) throw new UpdateTriggerError('unavailable')
  if (!input.stopAgents && state.busy) throw new UpdateTriggerError('busy')
  const request: UpdateTriggerRequest = {
    id: nanoid(),
    skipBackup: input.skipBackup,
    stopAgents: input.stopAgents,
    requestedAt: new Date(now).toISOString(),
  }
  pending = { request, at: now }
  return request
}

/** Records the updater heartbeat and hands a pending request out once. */
export function pollUpdateTrigger(now = Date.now()): UpdateTriggerRequest | null {
  lastPollAt = now
  expire(now)
  // The updater polls only while it runs no update (oneshot unit, update lock taken before the
  // poll): an unfinished status lost its report, so it is forgotten rather than kept for 90 min.
  if (current && !UPDATE_TRIGGER_TERMINAL.includes(current.status.phase)) current = null
  if (!pending) return null
  const { request } = pending
  pending = null
  current = {
    id: request.id,
    at: now,
    status: { id: request.id, phase: 'accepted', updatedAt: new Date(now).toISOString() },
    stopAgents: request.stopAgents,
  }
  return request
}

/** True only for the handed-out, unfinished request that asked for agents to be stopped. */
export function isStopAgentsRequest(id: string): boolean {
  return !!current && current.id === id && current.stopAgents && !UPDATE_TRIGGER_TERMINAL.includes(current.status.phase)
}

export function reportUpdateTrigger(
  id: string,
  phase: UpdateTriggerPhase,
  reason?: UpdateTriggerReason,
  now = Date.now(),
): boolean {
  expire(now)
  // The update restarts Kōbō and loses the request: adopt its final report so the page can show it.
  if (!current && !pending && UPDATE_TRIGGER_TERMINAL.includes(phase) && id.length > 0 && id.length <= 64) {
    current = {
      id,
      at: now,
      stopAgents: false,
      status: { id, phase, ...(reason ? { reason } : {}), updatedAt: new Date(now).toISOString() },
    }
    return true
  }
  // A late or repeated report must not make a finished update look in progress again.
  if (!current || current.id !== id || UPDATE_TRIGGER_TERMINAL.includes(current.status.phase)) return false
  current = {
    ...current,
    at: now,
    status: { id, phase, ...(reason ? { reason } : {}), updatedAt: new Date(now).toISOString() },
  }
  return true
}

export function resetUpdateTriggerForTests(): void {
  lastPollAt = null
  pending = null
  current = null
}
