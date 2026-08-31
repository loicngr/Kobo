import { describe, expect, it, vi } from 'vitest'
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

describe('foldEventsCached', () => {
  it('produces the same items as a full fold when events are appended one by one', async () => {
    const { createFoldCache, foldEvents, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [
      { kind: 'message:text', messageId: 'm1', text: 'Hel', streaming: true },
      { kind: 'message:text', messageId: 'm1', text: 'lo', streaming: true },
      { kind: 'tool:call', messageId: 'm1', toolCallId: 'tc1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool:result', toolCallId: 'tc1', output: 'a.ts', isError: false },
      { kind: 'message:end', messageId: 'm1' },
    ]

    const cache = createFoldCache()
    for (let i = 1; i <= events.length; i++) {
      foldEventsCached(cache, events.slice(0, i), undefined, true)
    }

    expect(foldEventsCached(cache, events, undefined, true)).toEqual(foldEvents(events, undefined, true))
  })

  it('only folds the newly appended tail', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [
      { kind: 'message:text', messageId: 'm1', text: 'one', streaming: false },
      { kind: 'message:text', messageId: 'm2', text: 'two', streaming: false },
    ]
    const cache = createFoldCache()
    const first = foldEventsCached(cache, events, undefined, true)
    const firstItem = first[0]

    events.push({ kind: 'message:text', messageId: 'm3', text: 'three', streaming: false })
    const second = foldEventsCached(cache, events, undefined, true)

    // The item objects of already-folded events are REUSED, not rebuilt — this
    // is what lets the markdown memo hold on to a frozen message.
    expect(second[0]).toBe(firstItem)
    expect(second).toHaveLength(3)
  })

  it('rebuilds from scratch when older history is prepended', async () => {
    const { createFoldCache, foldEvents, foldEventsCached } = await import('../services/agent-event-view')
    const recent: AgentEvent[] = [{ kind: 'message:text', messageId: 'm2', text: 'now', streaming: false }]
    const cache = createFoldCache()
    foldEventsCached(cache, recent, undefined, true)

    const withOlder: AgentEvent[] = [
      { kind: 'message:text', messageId: 'm1', text: 'before', streaming: false },
      ...recent,
    ]
    expect(foldEventsCached(cache, withOlder, undefined, true)).toEqual(foldEvents(withOlder, undefined, true))
  })

  it('rebuilds from scratch when the stream is replaced by a shorter one', async () => {
    const { createFoldCache, foldEvents, foldEventsCached } = await import('../services/agent-event-view')
    const cache = createFoldCache()
    foldEventsCached(
      cache,
      [
        { kind: 'message:text', messageId: 'a', text: '1', streaming: false },
        { kind: 'message:text', messageId: 'b', text: '2', streaming: false },
      ],
      undefined,
      true,
    )
    const replacement: AgentEvent[] = [{ kind: 'message:text', messageId: 'z', text: 'z', streaming: false }]
    expect(foldEventsCached(cache, replacement, undefined, true)).toEqual(foldEvents(replacement, undefined, true))
  })

  it('closes the trailing streaming message when the session goes idle', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'typing', streaming: true }]
    const cache = createFoldCache()

    const live = foldEventsCached(cache, events, undefined, true)
    expect((live[0] as { streaming: boolean }).streaming).toBe(true)

    const idle = foldEventsCached(cache, events, undefined, false)
    expect((idle[0] as { streaming: boolean }).streaming).toBe(false)
  })

  // Vue re-renders a child component only when the props it receives change by
  // REFERENCE. The feed passes each ConversationItem as a prop under a stable
  // key, so an item mutated in place would keep its reference and freeze the
  // card forever: text deltas invisible, spinner stuck, tool result missing.
  // Every update must therefore publish a NEW object.
  it('publishes a new object reference when a text delta extends an existing item', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'Hel', streaming: true }]
    const cache = createFoldCache()
    const first = foldEventsCached(cache, events, undefined, true)
    const firstItem = first[0]

    events.push({ kind: 'message:text', messageId: 'm1', text: 'lo', streaming: true })
    const second = foldEventsCached(cache, events, undefined, true)

    expect(second[0]).not.toBe(firstItem)
    expect((second[0] as { text: string }).text).toBe('Hello')
    expect((firstItem as { text: string }).text).toBe('Hel')
  })

  it('publishes a new object reference when message:end closes a streaming item', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'hi', streaming: true }]
    const cache = createFoldCache()
    const firstItem = foldEventsCached(cache, events, undefined, true)[0]

    events.push({ kind: 'message:end', messageId: 'm1' })
    const second = foldEventsCached(cache, events, undefined, true)

    expect(second[0]).not.toBe(firstItem)
    expect((second[0] as { streaming: boolean }).streaming).toBe(false)
  })

  it('publishes a new object reference when the session goes idle (closeStaleStreamingText)', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'typing', streaming: true }]
    const cache = createFoldCache()
    const liveItem = foldEventsCached(cache, events, undefined, true)[0]

    const idle = foldEventsCached(cache, events, undefined, false)

    expect(idle[0]).not.toBe(liveItem)
    expect((idle[0] as { streaming: boolean }).streaming).toBe(false)

    // Idempotent: a second idle fold changes nothing, so the reference is kept.
    expect(foldEventsCached(cache, events, undefined, false)[0]).toBe(idle[0])
  })

  it('publishes a new object reference when a tool result lands on an existing call', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [
      { kind: 'tool:call', messageId: 'm1', toolCallId: 'tc1', name: 'Bash', input: { command: 'ls' } },
    ]
    const cache = createFoldCache()
    const callItem = foldEventsCached(cache, events, undefined, true)[0]

    events.push({ kind: 'tool:result', toolCallId: 'tc1', output: 'a.ts', isError: false })
    const second = foldEventsCached(cache, events, undefined, true)

    expect(second[0]).not.toBe(callItem)
    expect((second[0] as { result?: { output: unknown } }).result).toEqual({ output: 'a.ts', isError: false })
  })

  it('keeps folding text deltas correctly after the item has been replaced', async () => {
    const { createFoldCache, foldEvents, foldEventsCached } = await import('../services/agent-event-view')
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'a', streaming: true }]
    const cache = createFoldCache()
    // Force a copy-on-write pass (idle close), then keep streaming into it.
    foldEventsCached(cache, events, undefined, false)
    events.push({ kind: 'message:text', messageId: 'm1', text: 'b', streaming: true })
    events.push({ kind: 'message:end', messageId: 'm1' })
    expect(foldEventsCached(cache, events, undefined, true)).toEqual(foldEvents(events, undefined, true))
  })

  it('carries timestamps and event ids onto the appended items', async () => {
    const { createFoldCache, foldEventsCached } = await import('../services/agent-event-view')
    const cache = createFoldCache()
    const events: AgentEvent[] = [{ kind: 'message:text', messageId: 'm1', text: 'a', streaming: false }]
    foldEventsCached(cache, events, ['2026-01-01T00:00:00Z'], true, ['evt-1'])

    events.push({ kind: 'message:text', messageId: 'm2', text: 'b', streaming: false })
    const items = foldEventsCached(cache, events, ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z'], true, [
      'evt-1',
      'evt-2',
    ])

    expect(items[1].ts).toBe('2026-01-01T00:00:01Z')
    expect(items[1].eventIds).toEqual(['evt-2'])
  })
})

describe('mergeWithUserMessages fast path', () => {
  it('merges two already-sorted lists without calling sort', async () => {
    const { mergeWithUserMessages } = await import('../services/agent-event-view')
    const agentItems = [
      { type: 'text' as const, messageId: 'm1', text: 'a', streaming: false, ts: '2026-01-01T00:00:01Z' },
      { type: 'text' as const, messageId: 'm2', text: 'b', streaming: false, ts: '2026-01-01T00:00:03Z' },
    ]
    const userMessages = [
      { content: 'u1', sender: 'user', ts: '2026-01-01T00:00:00Z' },
      { content: 'u2', sender: 'user', ts: '2026-01-01T00:00:02Z' },
    ]

    const sortSpy = vi.spyOn(Array.prototype, 'sort')
    const merged = mergeWithUserMessages(agentItems, userMessages)
    const sorted = sortSpy.mock.calls.length
    sortSpy.mockRestore()

    expect(merged.map((i) => i.ts)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:02Z',
      '2026-01-01T00:00:03Z',
    ])
    expect(sorted).toBe(0)
  })

  it('publishes a new object reference for a streaming item closed by a newer user message', async () => {
    const { mergeWithUserMessages } = await import('../services/agent-event-view')
    const streaming = {
      type: 'text' as const,
      messageId: 'm1',
      text: 'half',
      streaming: true,
      ts: '2026-01-01T00:00:01Z',
    }
    const agentItems: ConversationItem[] = [streaming]
    const merged = mergeWithUserMessages(agentItems, [{ content: 'u1', sender: 'user', ts: '2026-01-01T00:00:02Z' }])

    const closed = merged.find((i) => i.type === 'text')
    expect(closed).not.toBe(streaming)
    expect((closed as { streaming: boolean }).streaming).toBe(false)
    // The source list is realigned too, so the next merge is a no-op and the
    // reference stays stable afterwards.
    expect(agentItems[0]).toBe(closed)
  })

  it('still falls back to a sort when a list is out of order', async () => {
    const { mergeWithUserMessages } = await import('../services/agent-event-view')
    const agentItems = [
      { type: 'text' as const, messageId: 'm2', text: 'b', streaming: false, ts: '2026-01-01T00:00:03Z' },
      { type: 'text' as const, messageId: 'm1', text: 'a', streaming: false, ts: '2026-01-01T00:00:01Z' },
    ]
    const merged = mergeWithUserMessages(agentItems, [{ content: 'u1', sender: 'user', ts: '2026-01-01T00:00:02Z' }])
    expect(merged.map((i) => i.ts)).toEqual(['2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', '2026-01-01T00:00:03Z'])
  })
})
