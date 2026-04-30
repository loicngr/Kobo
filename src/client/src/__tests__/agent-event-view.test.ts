import { describe, expect, it } from 'vitest'
import { type ConversationItem, foldEvents, mergeWithUserMessages } from '../services/agent-event-view.js'
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

describe('mergeWithUserMessages', () => {
  it('closes a streaming text that predates the latest user message', () => {
    const streamingText: ConversationItem = {
      type: 'text',
      messageId: 'm1',
      text: 'hi',
      streaming: true,
      ts: '2026-04-01T10:00:00Z',
    }
    const merged = mergeWithUserMessages(
      [streamingText],
      [{ content: 'follow-up', sender: 'user', ts: '2026-04-01T10:05:00Z' }],
    )
    const textItem = merged.find((i) => i.type === 'text') as Extract<ConversationItem, { type: 'text' }>
    expect(textItem.streaming).toBe(false)
  })

  it('keeps a streaming text that is newer than the last user message', () => {
    const userEarly: ConversationItem = {
      type: 'text',
      messageId: 'm1',
      text: 'later-agent',
      streaming: true,
      ts: '2026-04-01T10:10:00Z',
    }
    const merged = mergeWithUserMessages(
      [userEarly],
      [{ content: 'older-user', sender: 'user', ts: '2026-04-01T10:00:00Z' }],
    )
    const textItem = merged.find((i) => i.type === 'text') as Extract<ConversationItem, { type: 'text' }>
    expect(textItem.streaming).toBe(true)
  })

  it('ignores system-prompt user entries when deciding what to close', () => {
    const streamingText: ConversationItem = {
      type: 'text',
      messageId: 'm1',
      text: 'hi',
      streaming: true,
      ts: '2026-04-01T10:00:00Z',
    }
    const merged = mergeWithUserMessages(
      [streamingText],
      [{ content: 'system', sender: 'system-prompt', ts: '2026-04-01T10:05:00Z' }],
    )
    const textItem = merged.find((i) => i.type === 'text') as Extract<ConversationItem, { type: 'text' }>
    expect(textItem.streaming).toBe(true)
  })

  it('closes every streaming text before the most recent user message, keeps the newer one', () => {
    const oldStreaming: ConversationItem = {
      type: 'text',
      messageId: 'm1',
      text: 'old',
      streaming: true,
      ts: '2026-04-01T10:00:00Z',
    }
    const newStreaming: ConversationItem = {
      type: 'text',
      messageId: 'm2',
      text: 'new',
      streaming: true,
      ts: '2026-04-01T10:10:00Z',
    }
    const merged = mergeWithUserMessages(
      [oldStreaming, newStreaming],
      [{ content: 'in-between', sender: 'user', ts: '2026-04-01T10:05:00Z' }],
    )
    const texts = merged.filter((i) => i.type === 'text') as Array<Extract<ConversationItem, { type: 'text' }>>
    expect(texts.find((t) => t.messageId === 'm1')?.streaming).toBe(false)
    expect(texts.find((t) => t.messageId === 'm2')?.streaming).toBe(true)
  })
})
