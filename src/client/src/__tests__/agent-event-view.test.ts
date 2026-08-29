import { describe, expect, it } from 'vitest'
import {
  type ConversationItem,
  foldEvents,
  getLatestThinkingItem,
  isNormalSessionEnd,
  mergeWithUserMessages,
  selectLastAgentError,
  sessionEndedI18nKey,
} from '../services/agent-event-view.js'
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

  it('ignores skills:discovered, usage, rate_limit and subagent:progress', () => {
    const items = foldEvents([
      { kind: 'skills:discovered', skills: ['x'] },
      { kind: 'usage', inputTokens: 1, outputTokens: 2 },
      { kind: 'rate_limit', info: { buckets: [] } },
      { kind: 'subagent:progress', toolCallId: 't', status: 'running' },
    ])
    expect(items).toEqual([])
  })

  it('anchors an agent error in the feed so a failed start is visible in place', () => {
    const items = foldEvents([{ kind: 'error', category: 'spawn_failed', message: 'codex binary not found' }])
    expect(items).toEqual([
      {
        type: 'error',
        category: 'spawn_failed',
        message: 'codex binary not found',
        ts: undefined,
        eventIds: undefined,
      },
    ])
  })

  it('keeps quota errors and informational CLI warnings out of the feed', () => {
    const items = foldEvents([
      { kind: 'error', category: 'quota', message: 'usage limit reached' },
      { kind: 'error', category: 'other', message: 'Warning: something cosmetic' },
    ])
    expect(items).toEqual([])
  })
})

describe('selectLastAgentError', () => {
  const events: AgentEvent[] = [
    { kind: 'error', category: 'spawn_failed', message: 'first failure' },
    { kind: 'error', category: 'other', message: 'Warning: something cosmetic' },
    { kind: 'error', category: 'quota', message: 'usage limit reached' },
    { kind: 'error', category: 'spawn_failed', message: 'second failure' },
  ]
  const eventIds = ['e1', 'e2', 'e3', 'e4']

  it('returns the most recent error, skipping quota and benign warnings', () => {
    const result = selectLastAgentError(events, eventIds, new Set())
    expect(result?.eventId).toBe('e4')
    expect(result?.event.message).toBe('second failure')
  })

  it('skips a dismissed (acknowledged) error and falls back to an earlier real one', () => {
    const result = selectLastAgentError(events, eventIds, new Set(['e4']))
    expect(result?.eventId).toBe('e1')
    expect(result?.event.message).toBe('first failure')
  })

  it('returns null once every real error has been dismissed', () => {
    const result = selectLastAgentError(events, eventIds, new Set(['e1', 'e4']))
    expect(result).toBeNull()
  })

  it('returns null when there is no error event at all', () => {
    expect(selectLastAgentError([], [], new Set())).toBeNull()
  })
})

describe('sessionEndedI18nKey', () => {
  it('names the reason instead of collapsing every ending into one label', () => {
    expect(sessionEndedI18nKey({ reason: 'completed', exitCode: 0 })).toBe('session.endedCompleted')
    expect(sessionEndedI18nKey({ reason: 'killed', exitCode: null })).toBe('session.endedKilled')
    expect(sessionEndedI18nKey({ reason: 'error', exitCode: null })).toBe('session.endedError')
    expect(sessionEndedI18nKey({ reason: 'watchdog', exitCode: null })).toBe('session.endedWatchdog')
  })

  it('falls back to the generic label for an unknown or missing reason', () => {
    expect(sessionEndedI18nKey(undefined)).toBe('session.ended')
    expect(sessionEndedI18nKey({ reason: 'something-new' })).toBe('session.ended')
  })
})

describe('isNormalSessionEnd', () => {
  it('is true only for a completed reason', () => {
    expect(isNormalSessionEnd({ reason: 'completed', exitCode: 0 })).toBe(true)
    expect(isNormalSessionEnd({ reason: 'killed', exitCode: null })).toBe(false)
    expect(isNormalSessionEnd({ reason: 'error', exitCode: null })).toBe(false)
    expect(isNormalSessionEnd({ reason: 'watchdog', exitCode: null })).toBe(false)
  })

  it('is false for an absent or unknown reason', () => {
    expect(isNormalSessionEnd(undefined)).toBe(false)
    expect(isNormalSessionEnd(null)).toBe(false)
    expect(isNormalSessionEnd({ reason: 'something-new' })).toBe(false)
  })
})

describe('ActivityFeed verbose gate for session:ended items', () => {
  // Mirrors the exact condition ActivityFeed.vue applies to a 'session' item
  // whose kind is 'ended': `verbose || !isNormalSessionEnd(detail)`. Extracted
  // here because that condition is not itself exported, but its behavior for
  // every reason in the table is what the gate must get right.
  function isRetained(detail: unknown, verbose: boolean): boolean {
    return verbose || !isNormalSessionEnd(detail)
  }

  it('hides only a normal completion behind the verbose toggle', () => {
    expect(isRetained({ reason: 'completed', exitCode: 0 }, false)).toBe(false)
    expect(isRetained({ reason: 'completed', exitCode: 0 }, true)).toBe(true)
  })

  it('always keeps an abnormal ending regardless of the verbose toggle', () => {
    for (const reason of ['killed', 'error', 'watchdog'] as const) {
      expect(isRetained({ reason, exitCode: null }, false)).toBe(true)
      expect(isRetained({ reason, exitCode: null }, true)).toBe(true)
    }
  })

  it('always keeps an ending with an absent or unknown reason', () => {
    expect(isRetained(undefined, false)).toBe(true)
    expect(isRetained(undefined, true)).toBe(true)
    expect(isRetained({ reason: 'something-new' }, false)).toBe(true)
    expect(isRetained({ reason: 'something-new' }, true)).toBe(true)
  })
})

describe('getLatestThinkingItem', () => {
  it('returns the last non-empty thinking item', () => {
    const result = getLatestThinkingItem([
      { type: 'thinking', messageId: 'first', text: 'First' },
      { type: 'thinking', messageId: 'blank', text: '   ' },
      { type: 'thinking', messageId: 'last', text: 'Last' },
    ])

    expect(result?.messageId).toBe('last')
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
