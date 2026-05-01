import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createMapperState, mapSdkMessage } from '../server/services/agent/engines/claude-code/event-mapper.js'

// The SDK type union is broad; tests build minimal-shape objects and cast through
// `unknown as SDKMessage` so we don't have to spell out every required field.
function asMsg(obj: Record<string, unknown>): SDKMessage {
  return obj as unknown as SDKMessage
}

describe('event-mapper', () => {
  describe('system:init', () => {
    it('emits session:started + skills:discovered', () => {
      const state = createMapperState()
      const events = mapSdkMessage(
        asMsg({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'claude-sonnet-4-5',
          slash_commands: ['help', 'plan'],
        }),
        state,
      )
      expect(events).toEqual([
        { kind: 'session:started', engineSessionId: 'sess-1', model: 'claude-sonnet-4-5' },
        { kind: 'skills:discovered', skills: ['help', 'plan'] },
      ])
      expect(state.sessionStartedEmitted).toBe(true)
      expect(state.sessionId).toBe('sess-1')
    })

    it('does not emit a duplicate session:started for the same session_id', () => {
      const state = createMapperState()
      mapSdkMessage(asMsg({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude' }), state)
      const events = mapSdkMessage(
        asMsg({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude' }),
        state,
      )
      expect(events.find((e) => e.kind === 'session:started')).toBeUndefined()
    })
  })

  describe('system:compact / compact_boundary', () => {
    it('emits session:compacted for compact_boundary', () => {
      const events = mapSdkMessage(
        asMsg({ type: 'system', subtype: 'compact_boundary', session_id: 's' }),
        createMapperState(),
      )
      expect(events).toEqual([{ kind: 'session:compacted' }])
    })

    it('emits session:compacted for legacy compact subtype', () => {
      const events = mapSdkMessage(asMsg({ type: 'system', subtype: 'compact', session_id: 's' }), createMapperState())
      expect(events).toEqual([{ kind: 'session:compacted' }])
    })
  })

  describe('rate_limit_event', () => {
    it('emits rate_limit with normalised buckets', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'rate_limit_event',
          session_id: 's',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.8,
            resetsAt: 1714521600,
          },
        }),
        createMapperState(),
      )
      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('rate_limit')
      const ev = events[0] as { kind: 'rate_limit'; info: { buckets: Array<{ id: string; usedPct: number }> } }
      expect(ev.info.buckets.length).toBeGreaterThan(0)
      expect(ev.info.buckets[0].id).toBe('five_hour')
      expect(ev.info.buckets[0].usedPct).toBe(80)
    })
  })

  describe('subagent task events', () => {
    it('emits subagent:progress with running for task_started', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'system',
          subtype: 'task_started',
          session_id: 's',
          tool_use_id: 'tool-1',
          description: 'doing the thing',
          task_type: 'general',
        }),
        createMapperState(),
      )
      expect(events).toEqual([
        {
          kind: 'subagent:progress',
          toolCallId: 'tool-1',
          status: 'running',
          description: 'doing the thing',
          taskType: 'general',
          lastToolName: undefined,
          totalTokens: undefined,
          toolUses: undefined,
          durationMs: undefined,
        },
      ])
    })

    it('emits subagent:progress with running for task_progress', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'system',
          subtype: 'task_progress',
          session_id: 's',
          tool_use_id: 'tool-1',
          description: 'progressing',
          last_tool_name: 'Read',
          usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
        }),
        createMapperState(),
      )
      expect(events).toEqual([
        {
          kind: 'subagent:progress',
          toolCallId: 'tool-1',
          status: 'running',
          description: 'progressing',
          taskType: undefined,
          lastToolName: 'Read',
          totalTokens: 100,
          toolUses: 2,
          durationMs: 500,
        },
      ])
    })

    it('emits subagent:progress with done when task_notification has completed status', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'system',
          subtype: 'task_notification',
          session_id: 's',
          tool_use_id: 'tool-1',
          status: 'completed',
        }),
        createMapperState(),
      )
      expect(events[0]).toMatchObject({ kind: 'subagent:progress', status: 'done' })
    })

    it('drops task events without a tool_use_id', () => {
      const events = mapSdkMessage(
        asMsg({ type: 'system', subtype: 'task_started', session_id: 's', description: 'no tool id' }),
        createMapperState(),
      )
      expect(events).toEqual([])
    })
  })

  describe('assistant messages', () => {
    it('emits message:text streaming=true for text blocks', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: { id: 'm1', content: [{ type: 'text', text: 'hello world' }] },
        }),
        createMapperState(),
      )
      expect(events[0]).toEqual({ kind: 'message:text', messageId: 'm1', text: 'hello world', streaming: true })
    })

    it('emits message:thinking for thinking blocks', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: { id: 'm1', content: [{ type: 'thinking', thinking: 'pondering' }] },
        }),
        createMapperState(),
      )
      expect(events[0]).toEqual({ kind: 'message:thinking', messageId: 'm1', text: 'pondering' })
    })

    it('emits tool:call for tool_use blocks', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: {
            id: 'm1',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/x' } }],
          },
        }),
        createMapperState(),
      )
      expect(events[0]).toEqual({
        kind: 'tool:call',
        messageId: 'm1',
        toolCallId: 'tu-1',
        name: 'Read',
        input: { path: '/x' },
      })
    })

    it('emits message:end and clears openMessages on stop_reason end_turn', () => {
      const state = createMapperState()
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: {
            id: 'm1',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
          },
        }),
        state,
      )
      expect(events.find((e) => e.kind === 'message:end')).toEqual({ kind: 'message:end', messageId: 'm1' })
      expect(state.openMessages.has('m1')).toBe(false)
    })

    it('closes a previous open message when a new messageId arrives', () => {
      const state = createMapperState()
      mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: { id: 'm1', content: [{ type: 'text', text: 'first' }] },
        }),
        state,
      )
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: { id: 'm2', content: [{ type: 'text', text: 'second' }] },
        }),
        state,
      )
      expect(events[0]).toEqual({ kind: 'message:end', messageId: 'm1' })
      expect(state.openMessages.has('m1')).toBe(false)
      expect(state.openMessages.has('m2')).toBe(true)
    })

    it('emits session:brainstorm-complete when text contains the marker', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: {
            id: 'm1',
            content: [{ type: 'text', text: 'all good [BRAINSTORM_COMPLETE]' }],
          },
        }),
        createMapperState(),
      )
      expect(events.some((e) => e.kind === 'session:brainstorm-complete')).toBe(true)
    })
  })

  describe('user tool_result messages', () => {
    it('emits tool:result for tool_result blocks', () => {
      const events = mapSdkMessage(
        asMsg({
          type: 'user',
          session_id: 's',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'output text', is_error: false }],
          },
        }),
        createMapperState(),
      )
      expect(events[0]).toEqual({
        kind: 'tool:result',
        toolCallId: 'tu-1',
        output: 'output text',
        isError: false,
      })
    })
  })

  describe('result message', () => {
    it('emits usage with token counts and closes open messages', () => {
      const state = createMapperState()
      // Open a message first
      mapSdkMessage(
        asMsg({
          type: 'assistant',
          session_id: 's',
          message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
        }),
        state,
      )
      const events = mapSdkMessage(
        asMsg({
          type: 'result',
          subtype: 'success',
          session_id: 's',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
          total_cost_usd: 0.01,
        }),
        state,
      )
      expect(events.find((e) => e.kind === 'message:end')).toEqual({ kind: 'message:end', messageId: 'm1' })
      const usage = events.find((e) => e.kind === 'usage')
      expect(usage).toEqual({
        kind: 'usage',
        inputTokens: 10,
        outputTokens: 20,
        cacheRead: 5,
        cacheWrite: 3,
        costUsd: 0.01,
      })
      expect(state.openMessages.size).toBe(0)
    })

    it('does not emit a deferred event for stop_reason=tool_deferred (handled by canUseTool)', () => {
      const state = createMapperState()
      const events = mapSdkMessage(
        asMsg({
          type: 'result',
          subtype: 'success',
          stop_reason: 'tool_deferred',
          deferred_tool_use: { id: 'toolu_01abc', name: 'AskUserQuestion', input: {} },
        }),
        state,
      )
      // No deferred event kind exists anymore — the canUseTool callback in
      // engine.ts is the source of truth for AskUserQuestion / permission
      // pauses. The result message just closes any open messages.
      expect(events.find((e) => e.kind.startsWith('session:user-input-requested'))).toBeUndefined()
    })

    it('surfaces an error event and sets sawErrorResult for error_max_turns', () => {
      const state = createMapperState()
      const events = mapSdkMessage(
        asMsg({
          type: 'result',
          subtype: 'error_max_turns',
          session_id: 's',
          usage: { input_tokens: 1, output_tokens: 2 },
          error: 'reached max turns',
        }),
        state,
      )
      const error = events.find((e) => e.kind === 'error')
      expect(error).toBeDefined()
      expect(error).toMatchObject({ kind: 'error', category: 'other' })
      expect((error as { message: string }).message).toContain('error_max_turns')
      expect((error as { message: string }).message).toContain('reached max turns')
      // usage event must still be emitted afterwards
      expect(events.find((e) => e.kind === 'usage')).toBeDefined()
      expect(state.sawErrorResult).toBe(true)
    })

    it('treats unknown error_* subtypes as errors (forward-compat)', () => {
      const state = createMapperState()
      const events = mapSdkMessage(
        asMsg({
          type: 'result',
          subtype: 'error_brand_new_failure_mode',
          session_id: 's',
        }),
        state,
      )
      expect(events.find((e) => e.kind === 'error')).toBeDefined()
      expect(state.sawErrorResult).toBe(true)
    })

    it('does not flag sawErrorResult on success subtype', () => {
      const state = createMapperState()
      mapSdkMessage(
        asMsg({
          type: 'result',
          subtype: 'success',
          session_id: 's',
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        state,
      )
      expect(state.sawErrorResult).toBe(false)
    })
  })
})
