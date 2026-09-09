import { describe, expect, it } from 'vitest'
import { getActionBlocker } from '../utils/action-blocker'

describe('action availability', () => {
  it('enables an action only when every prerequisite is met', () => {
    expect(getActionBlocker({})).toBeNull()
    expect(
      getActionBlocker({ archived: false, operation: false, agentBusy: false, missingConfiguration: false }),
    ).toBeNull()
  })
  it('explains restoring a purged archived workspace before unarchiving', () => {
    expect(getActionBlocker({ purged: true, archived: true, missingConfiguration: true })).toBe('purged')
    expect(getActionBlocker({ purged: false, archived: true })).toBe('archived')
    expect(getActionBlocker({ purged: false, archived: false })).toBeNull()
  })
  it('prioritizes an in-flight operation over the agent and configuration', () => {
    const state = { operation: true, agentBusy: true, missingConfiguration: true }
    expect(getActionBlocker(state)).toBe('operation')
    expect(getActionBlocker({ ...state, operation: false })).toBe('agentBusy')
    expect(getActionBlocker({ ...state, operation: false, agentBusy: false })).toBe('configuration')
  })
  it('requires a selected workspace before considering its other prerequisites', () => {
    expect(getActionBlocker({ missingWorkspace: true, archived: true, operation: true })).toBe('noWorkspace')
  })
})
