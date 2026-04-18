import { describe, expect, it } from 'vitest'
import { foldEvents } from '../services/agent-event-view.js'
import type { AgentEvent } from '../types/agent-event'

describe('foldEvents', () => {
  it('concatenates streaming text chunks by messageId and closes on message:end', () => {
    const events: AgentEvent[] = [
      { kind: 'message:text', messageId: 'm1', text: 'Hello ', streaming: true },
      { kind: 'message:text', messageId: 'm1', text: 'world', streaming: true },
      { kind: 'message:end', messageId: 'm1' },
    ]
    const items = foldEvents(events)
    const text = items.find((i) => i.type === 'text') as { type: 'text'; text: string; streaming: boolean }
    expect(text.text).toBe('Hello world')
    expect(text.streaming).toBe(false) // closed by message:end
  })

  it('pairs tool:call with tool:result by toolCallId', () => {
    const events: AgentEvent[] = [
      { kind: 'tool:call', messageId: 'm1', toolCallId: 't1', name: 'Read', input: { path: '/x' } },
      { kind: 'tool:result', toolCallId: 't1', output: 'ok', isError: false },
    ]
    const items = foldEvents(events)
    expect(items).toHaveLength(1)
    const tool = items[0] as { type: 'tool'; result?: { output: unknown } }
    expect(tool.type).toBe('tool')
    expect(tool.result?.output).toBe('ok')
  })

  it('leaves tool:call without result as pending (no standalone tool:result item)', () => {
    const events: AgentEvent[] = [{ kind: 'tool:call', messageId: 'm1', toolCallId: 't1', name: 'Read', input: {} }]
    const items = foldEvents(events)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('tool')
    expect((items[0] as { result?: unknown }).result).toBeUndefined()
  })

  it('maps message:thinking to a thinking item', () => {
    const items = foldEvents([{ kind: 'message:thinking', messageId: 'm1', text: 'reasoning' }])
    expect(items[0]).toMatchObject({ type: 'thinking', text: 'reasoning' })
  })

  it('emits session items for started/ended/compacted', () => {
    const items = foldEvents([
      { kind: 'session:started', engineSessionId: 's1' },
      { kind: 'session:compacted' },
      { kind: 'session:ended', reason: 'completed', exitCode: 0 },
    ])
    const sessions = items.filter((i) => i.type === 'session')
    expect(sessions).toHaveLength(3)
  })

  it('ignores skills:discovered, usage, rate_limit, subagent:progress, error', () => {
    const items = foldEvents([
      { kind: 'skills:discovered', skills: ['x'] },
      { kind: 'usage', inputTokens: 1, outputTokens: 2 },
      { kind: 'rate_limit', info: { buckets: [] } },
      { kind: 'subagent:progress', toolCallId: 't', status: 'running' },
      { kind: 'error', category: 'other', message: 'x' },
    ])
    expect(items).toEqual([])
  })
})
