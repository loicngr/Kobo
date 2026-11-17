import { beforeEach, describe, expect, it, vi } from 'vitest'

const runningAgentCount = vi.fn(() => 0)
const idleForUpdate = vi.fn(() => true)
vi.mock('../server/services/agent/orchestrator.js', () => ({
  agentCountForUpdate: () => runningAgentCount(),
  isIdleForUpdate: () => idleForUpdate(),
}))

import {
  getUpdateTriggerState,
  isStopAgentsRequest,
  pollUpdateTrigger,
  reportUpdateTrigger,
  requestUpdate,
  resetUpdateTriggerForTests,
  UpdateTriggerError,
} from '../server/services/update-trigger-service.js'

const T0 = 1_000_000
const input = { skipBackup: false, stopAgents: false }

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof UpdateTriggerError ? err.code : 'other'
  }
  return undefined
}

describe('update trigger service', () => {
  beforeEach(() => {
    resetUpdateTriggerForTests()
    runningAgentCount.mockReturnValue(0)
    idleForUpdate.mockReturnValue(true)
  })

  it('is available only within 180 s of the last poll', () => {
    expect(getUpdateTriggerState(T0).available).toBe(false)
    pollUpdateTrigger(T0)
    expect(getUpdateTriggerState(T0).available).toBe(true)
    expect(getUpdateTriggerState(T0 + 180_000).available).toBe(true)
    expect(getUpdateTriggerState(T0 + 180_001).available).toBe(false)
  })

  it('refuses when no updater polled recently', () => {
    expect(codeOf(() => requestUpdate(input, T0))).toBe('unavailable')
  })

  it('refuses when Kōbō is not idle for an update unless stopAgents is set', () => {
    pollUpdateTrigger(T0)
    idleForUpdate.mockReturnValue(false)
    expect(getUpdateTriggerState(T0).busy).toBe(true)
    expect(codeOf(() => requestUpdate(input, T0))).toBe('busy')
    expect(requestUpdate({ skipBackup: false, stopAgents: true }, T0).stopAgents).toBe(true)
  })

  it('reports busy from the reservation predicate, not from the live agent count', () => {
    pollUpdateTrigger(T0)
    // A workspace still marked executing, with no agent: the updater would refuse.
    idleForUpdate.mockReturnValue(false)
    runningAgentCount.mockReturnValue(0)
    expect(getUpdateTriggerState(T0)).toMatchObject({ busy: true, runningAgents: 0 })
    expect(codeOf(() => requestUpdate(input, T0))).toBe('busy')
    idleForUpdate.mockReturnValue(true)
    expect(getUpdateTriggerState(T0).busy).toBe(false)
    expect(codeOf(() => requestUpdate(input, T0))).toBeUndefined()
  })

  it('reports pending then in-progress for a second request', () => {
    pollUpdateTrigger(T0)
    requestUpdate(input, T0)
    expect(codeOf(() => requestUpdate(input, T0))).toBe('pending')
    pollUpdateTrigger(T0)
    expect(codeOf(() => requestUpdate(input, T0))).toBe('in-progress')
  })

  it('says pending or in-progress, not unavailable, once the updater stopped polling during a long update', () => {
    pollUpdateTrigger(T0)
    requestUpdate(input, T0)
    const later = T0 + 179_000
    expect(codeOf(() => requestUpdate(input, later))).toBe('pending')
    pollUpdateTrigger(later)
    const building = later + 10 * 60_000
    expect(getUpdateTriggerState(building)).toMatchObject({ available: true, inProgress: true })
    expect(codeOf(() => requestUpdate(input, building))).toBe('in-progress')
  })

  it('checks unavailable before busy', () => {
    idleForUpdate.mockReturnValue(false)
    expect(codeOf(() => requestUpdate(input, T0))).toBe('unavailable')
  })

  it('hands a request out exactly once and records accepted', () => {
    pollUpdateTrigger(T0)
    const req = requestUpdate({ skipBackup: true, stopAgents: false }, T0)
    expect(getUpdateTriggerState(T0).pending).toBe(true)
    expect(pollUpdateTrigger(T0)).toEqual(req)
    const state = getUpdateTriggerState(T0)
    expect(state.status?.phase).toBe('accepted')
    expect(state.pending).toBe(false)
    expect(state.inProgress).toBe(true)
  })

  it('settles a stale unfinished status on the next poll, then hands out a new request', () => {
    pollUpdateTrigger(T0)
    const lost = requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    reportUpdateTrigger(lost.id, 'building', undefined, T0 + 1000)
    // The updater (a oneshot unit) polls only when idle: its update ended without a final report.
    expect(pollUpdateTrigger(T0 + 60_000)).toBeNull()
    expect(getUpdateTriggerState(T0 + 60_000)).toMatchObject({ status: null, inProgress: false })
    const next = requestUpdate(input, T0 + 61_000)
    expect(pollUpdateTrigger(T0 + 120_000)).toEqual(next)
    expect(getUpdateTriggerState(T0 + 120_000).status).toMatchObject({ id: next.id, phase: 'accepted' })
  })

  it('keeps a terminal status across polls', () => {
    pollUpdateTrigger(T0)
    const req = requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    reportUpdateTrigger(req.id, 'complete', undefined, T0)
    pollUpdateTrigger(T0 + 60_000)
    expect(getUpdateTriggerState(T0 + 60_000).status).toMatchObject({ id: req.id, phase: 'complete' })
  })

  it('drops a request not polled within 180 s', () => {
    pollUpdateTrigger(T0)
    requestUpdate(input, T0)
    const later = T0 + 180_001
    const state = getUpdateTriggerState(later)
    expect(state.pending).toBe(false)
    expect(state.status).toBeNull()
    pollUpdateTrigger(later)
    expect(() => requestUpdate(input, later)).not.toThrow()
  })

  it('records a terminal report and ignores an unknown id', () => {
    pollUpdateTrigger(T0)
    const req = requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    expect(reportUpdateTrigger('nope', 'building', undefined, T0)).toBe(false)
    expect(getUpdateTriggerState(T0).status?.phase).toBe('accepted')
    expect(reportUpdateTrigger(req.id, 'refused', 'busy', T0)).toBe(true)
    const state = getUpdateTriggerState(T0)
    expect(state.status).toMatchObject({ id: req.id, phase: 'refused', reason: 'busy' })
    expect(state.inProgress).toBe(false)
  })

  it('refuses a report arriving after a terminal status', () => {
    pollUpdateTrigger(T0)
    const req = requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    expect(reportUpdateTrigger(req.id, 'complete', undefined, T0)).toBe(true)
    expect(reportUpdateTrigger(req.id, 'building', undefined, T0 + 1)).toBe(false)
    expect(reportUpdateTrigger(req.id, 'refused', 'busy', T0 + 1)).toBe(false)
    const state = getUpdateTriggerState(T0 + 1)
    expect(state.status).toMatchObject({ id: req.id, phase: 'complete' })
    expect(state.inProgress).toBe(false)
  })

  it('accepts a forced stop only for the handed-out, unfinished stopAgents request', () => {
    pollUpdateTrigger(T0)
    expect(isStopAgentsRequest('nope')).toBe(false)
    const plain = requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    expect(isStopAgentsRequest(plain.id)).toBe(false)
    reportUpdateTrigger(plain.id, 'complete', undefined, T0)

    const forced = requestUpdate({ skipBackup: false, stopAgents: true }, T0)
    expect(isStopAgentsRequest(forced.id)).toBe(false) // not handed out yet
    pollUpdateTrigger(T0)
    expect(isStopAgentsRequest(forced.id)).toBe(true)
    reportUpdateTrigger(forced.id, 'refused', 'busy', T0)
    expect(isStopAgentsRequest(forced.id)).toBe(false)
  })

  it('stops blocking once a non-terminal status is older than 90 min', () => {
    pollUpdateTrigger(T0)
    requestUpdate(input, T0)
    pollUpdateTrigger(T0)
    const later = T0 + 90 * 60_000 + 1
    expect(getUpdateTriggerState(later).inProgress).toBe(false)
    pollUpdateTrigger(later)
    expect(() => requestUpdate(input, later)).not.toThrow()
  })

  describe('adopting a report after a backend restart', () => {
    it('adopts a terminal report when nothing is tracked', () => {
      expect(reportUpdateTrigger('r9', 'aborted', undefined, T0)).toBe(true)
      const state = getUpdateTriggerState(T0)
      expect(state.status).toEqual({ id: 'r9', phase: 'aborted', updatedAt: new Date(T0).toISOString() })
      expect(state.inProgress).toBe(false)
      expect(state.pending).toBe(false)
    })

    it('keeps the reason of an adopted refusal', () => {
      expect(reportUpdateTrigger('r9', 'refused', 'busy', T0)).toBe(true)
      expect(getUpdateTriggerState(T0).status?.reason).toBe('busy')
    })

    it('refuses a non-terminal report with an unknown id', () => {
      expect(reportUpdateTrigger('r9', 'building', undefined, T0)).toBe(false)
      expect(getUpdateTriggerState(T0).status).toBeNull()
    })

    it('refuses an unknown id while a request is tracked', () => {
      pollUpdateTrigger(T0)
      requestUpdate(input, T0)
      expect(reportUpdateTrigger('r9', 'complete', undefined, T0)).toBe(false) // pending
      pollUpdateTrigger(T0)
      expect(reportUpdateTrigger('r9', 'complete', undefined, T0)).toBe(false) // handed out
    })

    it('refuses an empty or over-long id', () => {
      expect(reportUpdateTrigger('', 'complete', undefined, T0)).toBe(false)
      expect(reportUpdateTrigger('x'.repeat(65), 'complete', undefined, T0)).toBe(false)
      expect(reportUpdateTrigger('x'.repeat(64), 'complete', undefined, T0)).toBe(true)
    })

    it('accepts a new request after an adoption', () => {
      reportUpdateTrigger('r9', 'complete', undefined, T0)
      pollUpdateTrigger(T0)
      expect(() => requestUpdate(input, T0)).not.toThrow()
    })
  })
})
