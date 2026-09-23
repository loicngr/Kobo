import { describe, expect, it } from 'vitest'
import { parseHookEventType } from '../utils/hook-events'

// The server streams a lifecycle hook under `hook:<event>:<kind>`. The client
// used to know only setup / cleanup / archive and dropped these on the floor,
// so a failing `npm test` hook showed nothing at all.
describe('parseHookEventType', () => {
  it('decodes the three kinds the script runner emits', () => {
    expect(parseHookEventType('hook:session-ended:output')).toEqual({ event: 'session-ended', kind: 'output' })
    expect(parseHookEventType('hook:pr-merged:complete')).toEqual({ event: 'pr-merged', kind: 'complete' })
    expect(parseHookEventType('hook:autoloop-disabled:error')).toEqual({ event: 'autoloop-disabled', kind: 'error' })
  })

  it('ignores anything that is not a hook stream', () => {
    expect(parseHookEventType('setup:output')).toBeNull()
    expect(parseHookEventType('hook:session-ended')).toBeNull()
    expect(parseHookEventType('hook:session-ended:started')).toBeNull()
    expect(parseHookEventType('hooked:x:output')).toBeNull()
  })
})
