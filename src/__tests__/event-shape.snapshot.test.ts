import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../server/services/agent/engines/types.js'
import { ALL_AGENT_EVENT_KINDS } from '../server/services/agent/engines/types.js'

/** One canonical example per AgentEvent kind — used as the source of truth for frontend drift. */
const EXAMPLES: Record<string, AgentEvent> = {
  'session:started': { kind: 'session:started', engineSessionId: 's1', model: 'claude-sonnet-4-6' },
  'session:ended': { kind: 'session:ended', reason: 'completed', exitCode: 0 },
  'session:user-input-requested': {
    kind: 'session:user-input-requested',
    requestKind: 'question',
    toolCallId: 'toolu_01abc',
    toolName: 'AskUserQuestion',
    payload: { questions: [] },
  },
  'session:compacted': { kind: 'session:compacted' },
  'session:brainstorm-complete': { kind: 'session:brainstorm-complete' },
  'message:text': { kind: 'message:text', messageId: 'm1', text: 'hi', streaming: false },
  'message:thinking': { kind: 'message:thinking', messageId: 'm1', text: 'thinking…' },
  'message:end': { kind: 'message:end', messageId: 'm1' },
  'message:raw': { kind: 'message:raw', content: 'raw line' },
  'tool:call': { kind: 'tool:call', messageId: 'm1', toolCallId: 't1', name: 'Read', input: { path: '/x' } },
  'tool:result': { kind: 'tool:result', toolCallId: 't1', output: 'ok', isError: false },
  'subagent:progress': {
    kind: 'subagent:progress',
    toolCallId: 't2',
    status: 'running',
    description: 'sub',
    taskType: 'explore',
    lastToolName: 'Grep',
    totalTokens: 100,
    toolUses: 2,
    durationMs: 1500,
  },
  'skills:discovered': { kind: 'skills:discovered', skills: ['a', 'b'] },
  usage: { kind: 'usage', inputTokens: 10, outputTokens: 20, cacheRead: 5, cacheWrite: 1, costUsd: 0.01 },
  rate_limit: {
    kind: 'rate_limit',
    info: { buckets: [{ id: 'five_hour', usedPct: 42, resetsAt: '2026-04-18T12:00:00Z' }] },
  },
  error: { kind: 'error', category: 'quota', message: 'rate limit' },
}

describe('AgentEvent shape snapshot', () => {
  it('has an example for every kind (exhaustive)', () => {
    for (const kind of ALL_AGENT_EVENT_KINDS) {
      expect(EXAMPLES).toHaveProperty(kind)
    }
  })

  it('matches the snapshot', () => {
    expect(JSON.stringify(EXAMPLES, null, 2)).toMatchSnapshot('agent-event-shape')
  })
})
