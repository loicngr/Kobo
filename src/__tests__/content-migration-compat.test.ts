import { describe, expect, it } from 'vitest'
import { convertRow } from '../server/services/content-migration-service.js'

/**
 * The stream-parser was removed during the Claude Agent SDK cutover. All
 * production databases were already migrated, so `convertRow` is now a no-op
 * that returns no events for any legacy type. These tests lock that contract.
 */
describe('content-migration compat — legacy payload → AgentEvent (post-parser-removal)', () => {
  it('returns no events for legacy assistant/text', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    )
    expect(events).toEqual([])
  })

  it('returns no events for legacy assistant/tool_use', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      }),
    )
    expect(events).toEqual([])
  })

  it('returns no events for legacy user/tool_result', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
        },
      }),
    )
    expect(events).toEqual([])
  })

  it('returns no events for legacy system/rate_limit_event', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'system',
        subtype: 'rate_limit_event',
        session_id: 's',
        rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5 },
      }),
    )
    expect(events).toEqual([])
  })

  it('returns no events for legacy raw wrapper', () => {
    const events = convertRow('agent:output', JSON.stringify({ type: 'raw', content: 'legacy raw' }))
    expect(events).toEqual([])
  })

  it('returns no events for non-JSON payloads', () => {
    const events = convertRow('agent:output', 'this is not json')
    expect(events).toEqual([])
  })
})
