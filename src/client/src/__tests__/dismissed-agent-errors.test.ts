import { beforeEach, describe, expect, it } from 'vitest'
import { selectLastAgentError } from '../services/agent-event-view'
import type { AgentEvent } from '../types/agent-event'
import { errorDismissalKey, readDismissedAgentErrors, saveDismissedAgentError } from '../utils/dismissed-agent-errors'

beforeEach(() => localStorage.clear())
describe('persisted error banner dismissal', () => {
  const error: AgentEvent = { kind: 'error', category: 'other', message: 'drain watchdog' }
  it('keeps the dismissed error hidden after replay without deleting its history', () => {
    const events = [error]
    saveDismissedAgentError('workspace-a', 'event-1', new Set())
    const afterReload = readDismissedAgentErrors('workspace-a')
    expect(selectLastAgentError(events, ['event-1'], afterReload)).toBeNull()
    expect(events).toEqual([error])
    expect(selectLastAgentError([error, error], ['event-1', 'event-2'], afterReload)?.eventId).toBe('event-2')
  })
  it('isolates workspaces and merges dismissals from another pane', () => {
    const stalePane = readDismissedAgentErrors('workspace-a')
    saveDismissedAgentError('workspace-a', 'event-1', new Set())
    saveDismissedAgentError('workspace-a', 'event-2', stalePane)
    expect([...readDismissedAgentErrors('workspace-a')]).toEqual(['event-1', 'event-2'])
    expect(readDismissedAgentErrors('workspace-b').size).toBe(0)
  })
  it('tolerates damaged data and unavailable storage', () => {
    localStorage.setItem(errorDismissalKey('a'), '{broken')
    expect(readDismissedAgentErrors('a').size).toBe(0)
    localStorage.setItem(errorDismissalKey('a'), '[false, "valid", 12, null]')
    expect([...readDismissedAgentErrors('a')]).toEqual(['valid'])
    const unavailable = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }
    expect([...saveDismissedAgentError('a', 'new', new Set(['previous']), unavailable)]).toEqual(['previous', 'new'])
  })
})
