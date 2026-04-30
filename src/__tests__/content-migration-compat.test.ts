import { describe, expect, it } from 'vitest'
import { convertRow } from '../server/services/content-migration-service.js'

/**
 * For every known legacy payload shape, assert the produced AgentEvent matches
 * the current union. This test fails if a future change to AgentEvent leaves
 * already-migrated rows in an incompatible state.
 */
describe('content-migration compat — legacy payload → AgentEvent', () => {
  it('assistant/text → message:text', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    )
    expect(events[0]).toMatchObject({ kind: 'message:text', text: 'hi' })
  })

  it('assistant/tool_use → tool:call', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'assistant',
        session_id: 's',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      }),
    )
    expect(events.find((e) => e.kind === 'tool:call')).toBeDefined()
  })

  it('user/tool_result → tool:result', () => {
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
    expect(events.find((e) => e.kind === 'tool:result')).toBeDefined()
  })

  it('system/rate_limit_event → rate_limit', () => {
    const events = convertRow(
      'agent:output',
      JSON.stringify({
        type: 'system',
        subtype: 'rate_limit_event',
        session_id: 's',
        rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5 },
      }),
    )
    expect(events.find((e) => e.kind === 'rate_limit')).toBeDefined()
  })

  it('raw wrapper {type:"raw", content:"…"} → message:raw', () => {
    const events = convertRow('agent:output', JSON.stringify({ type: 'raw', content: 'legacy raw' }))
    expect(events).toEqual([{ kind: 'message:raw', content: 'legacy raw' }])
  })

  it('non-JSON payload string → message:raw', () => {
    const events = convertRow('agent:output', 'this is not json')
    expect(events[0].kind).toBe('message:raw')
  })
})
