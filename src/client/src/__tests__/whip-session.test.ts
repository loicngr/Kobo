import { describe, expect, it } from 'vitest'
import { getWhipRunningSessionId } from '../utils/whip-session'

describe('getWhipRunningSessionId', () => {
  it('returns the sole running session instead of a historical selection', () => {
    expect(
      getWhipRunningSessionId([
        { id: 'historical', status: 'done' },
        { id: 'active', status: 'running' },
      ]),
    ).toBe('active')
  })

  it.each([
    [[]],
    [
      [
        { id: 'a', status: 'running' },
        { id: 'b', status: 'running' },
      ],
    ],
  ])('refuses an absent or ambiguous running session: %j', (sessions) =>
    expect(getWhipRunningSessionId(sessions)).toBeNull())
})
