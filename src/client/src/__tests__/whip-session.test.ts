import { describe, expect, it } from 'vitest'
import { getWhipRunningSessionId } from '../utils/whip-session'

describe('getWhipRunningSessionId', () => {
  it('returns the sole running session for the requested workspace instead of a historical selection', () => {
    expect(
      getWhipRunningSessionId('ws-1', [
        { id: 'historical', workspaceId: 'ws-1', status: 'done' },
        { id: 'active', workspaceId: 'ws-1', status: 'running' },
        { id: 'other-active', workspaceId: 'ws-2', status: 'running' },
      ]),
    ).toBe('active')
  })

  it('ignores a running session from another workspace', () => {
    expect(getWhipRunningSessionId('ws-1', [{ id: 'other-active', workspaceId: 'ws-2', status: 'running' }])).toBeNull()
  })

  it.each([
    [[]],
    [
      [
        { id: 'a', workspaceId: 'ws-1', status: 'running' },
        { id: 'b', workspaceId: 'ws-1', status: 'running' },
      ],
    ],
  ])('refuses an absent or ambiguous running session: %j', (sessions) =>
    expect(getWhipRunningSessionId('ws-1', sessions)).toBeNull())
})
