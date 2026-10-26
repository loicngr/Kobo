import { readFileSync } from 'node:fs'
import type { PromptResponse, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { foldEvents } from '../../client/src/services/agent-event-view.js'
import { createMistralEventMapper } from '../../server/services/agent/engines/mistral-vibe/event-mapper.js'
import type { AgentEvent } from '../../server/services/agent/engines/types.js'

const transcript = readFileSync(new URL('../fixtures/mistral-acp/transcript.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line)) as {
  direction: string
  message: { method?: string; params?: SessionNotification; result?: PromptResponse }
}[]
const resumeIndex = transcript.findIndex((record, index) => index > 0 && record.message.method === 'initialize')
const launches = [transcript.slice(0, resumeIndex), transcript.slice(resumeIndex)]

function setup(launchId = 'launch') {
  const events: AgentEvent[] = []
  const mapper = createMistralEventMapper(launchId, (event) => events.push(event))
  const update = (value: SessionUpdate) => mapper.onUpdate({ sessionId: 'native-session', update: value })
  return { events, mapper, update }
}

function usage(
  inputTokens: unknown,
  outputTokens: unknown,
  cost?: { amount: number; currency: string },
): SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used: 5000,
    size: 200000,
    _meta: { promptTokens: inputTokens, completionTokens: outputTokens },
    ...(cost ? { cost } : {}),
  }
}

function result(inputTokens: unknown, outputTokens: unknown): PromptResponse {
  return { stopReason: 'end_turn', usage: { inputTokens, outputTokens } } as PromptResponse
}

afterEach(() => vi.useRealTimers())

describe('Mistral Vibe event mapper', () => {
  it('preserves a complete streamed thought and separates answer, tool, message and launch boundaries', () => {
    const first = setup('first')
    const resumed = setup('resumed')
    for (const current of [first, resumed]) {
      const thought = (text: string, messageId?: string) =>
        current.update({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } })
      thought('Replayed history')
      current.mapper.beginLive()
      thought('I will inspect ')
      thought('what passed, ')
      thought('then verify the workspace.')
      expect(foldEvents(current.events)).toMatchObject([
        { type: 'thinking', text: 'I will inspect what passed, then verify the workspace.' },
      ])
      current.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer' } })
      thought('A second thought')
      current.update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'in_progress' })
      thought('After the tool', 'one')
      thought('A different message', 'two')
      current.mapper.finish({ stopReason: 'end_turn' })
      expect(
        foldEvents(current.events)
          .filter((item) => item.type === 'thinking')
          .map((item) => item.text),
      ).toEqual([
        'I will inspect what passed, then verify the workspace.',
        'A second thought',
        'After the tool',
        'A different message',
      ])
      expect(current.events.filter((event) => event.kind === 'message:thinking')).toEqual(
        expect.arrayContaining([expect.objectContaining({ streaming: true })]),
      )
    }
    expect(first.events[0]).not.toEqual(resumed.events[0])
  })

  it.each(launches.map((records, index) => ({ records, name: index === 0 ? 'new' : 'load' })))(
    'suppresses captured $name setup/replay and charges only the live turn',
    ({ records }) => {
      const { mapper, events } = setup()
      const prompt = records.findIndex((record) => record.message.method === 'session/prompt')
      for (const { message } of records.slice(0, prompt)) {
        if (message.method === 'session/update' && message.params) mapper.onUpdate(message.params)
      }
      mapper.flush()
      expect(events).toEqual([])
      expect(mapper.getTool('effect-id-2')).toBeUndefined()
      mapper.beginLive()
      for (const { message } of records.slice(prompt)) {
        if (message.method === 'session/update' && message.params) mapper.onUpdate(message.params)
      }
      const response = records.at(-1)?.message.result
      expect(response).toBeDefined()
      mapper.finish(response!)
      expect(events.filter((event) => event.kind === 'usage')).toEqual([
        { kind: 'usage', inputTokens: 50, outputTokens: 25 },
      ])
      const calls = events.filter((event) => event.kind === 'tool:call')
      const results = events.filter((event) => event.kind === 'tool:result')
      expect(calls).toHaveLength(5)
      expect(results.map((event) => event.toolCallId)).toEqual(calls.map((event) => event.toolCallId))
      expect(events.filter((event) => event.kind === 'message:text').map((event) => event.text)).toEqual([
        'Offline probe completed.',
      ])
      expect(events.some((event) => event.kind.startsWith('session:') || event.kind === 'turn:completed')).toBe(false)
      if (records === launches[1]) expect(JSON.stringify(events)).not.toContain('first-launch')
    },
  )

  it('coalesces chunks for 40ms, closes at EOF and scopes reused native IDs by launch', () => {
    vi.useFakeTimers()
    const first = setup('first')
    const resumed = setup('resumed')
    for (const current of [first, resumed]) {
      current.mapper.beginLive()
      current.update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Hello ' },
      })
      current.update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'world' },
      })
      vi.advanceTimersByTime(39)
      expect(current.events).toEqual([])
      vi.advanceTimersByTime(1)
      expect(current.events).toHaveLength(1)
      current.mapper.flush()
      expect(current.events).toEqual([
        { kind: 'message:text', messageId: expect.any(String), text: 'Hello world', streaming: true },
        { kind: 'message:end', messageId: expect.any(String) },
      ])
      expect(current.events[0]).toHaveProperty('messageId', (current.events[1] as { messageId: string }).messageId)
    }
    expect(first.events[0]).not.toEqual(resumed.events[0])
    expect(first.mapper.canonicalToolCallId('t')).not.toBe(resumed.mapper.canonicalToolCallId('t'))
  })

  it('flushes pending text at EOF and never turns an unfinished tool into a successful result', () => {
    vi.useFakeTimers()
    const { mapper, events, update } = setup()
    mapper.beginLive()
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pending text' } })
    mapper.flush()
    expect(events.map((event) => event.kind)).toEqual(['message:text', 'message:end'])
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' })
    expect(mapper.getTool('t')).toBeUndefined()
    mapper.flush()
    mapper.flush()
    vi.runAllTimers()
    expect(events.map((event) => event.kind)).toEqual(['message:text', 'message:end', 'tool:call'])
  })

  it('merges partial tools by native ID and keeps permission metadata and canonical IDs consistent', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress', rawInput: { command: 'pwd' } })
    expect(events).toEqual([])
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Run shell',
      kind: 'execute',
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
    })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', _meta: { approval: 'required' } })
    expect(mapper.getTool('t')).toMatchObject({
      toolCallId: 't',
      title: 'Run shell',
      kind: 'execute',
      rawInput: { command: 'pwd' },
      _meta: { tool_name: 'bash', effect_kind: 'shell', approval: 'required' },
    })
    expect(mapper.getTool(mapper.canonicalToolCallId('t'))).toBeUndefined()
    expect(events).toEqual([
      {
        kind: 'tool:call',
        messageId: '',
        toolCallId: mapper.canonicalToolCallId('t'),
        name: 'bash',
        input: { command: 'pwd' },
      },
    ])
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', rawOutput: { error: 'denied' } })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'completed',
      rawOutput: { error: 'duplicate' },
    })
    mapper.finish({ stopReason: 'end_turn' })
    expect(events.filter((event) => event.kind === 'tool:result')).toEqual([
      {
        kind: 'tool:result',
        toolCallId: mapper.canonicalToolCallId('t'),
        output: { error: 'denied' },
        isError: true,
      },
    ])
  })

  it('waits for missing metadata when a terminal partial arrives before the full tool', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: 'done' })
    expect(events).toEqual([])
    update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read file', rawInput: { path: 'file.txt' } })
    expect(events.map((event) => event.kind)).toEqual(['tool:call', 'tool:result'])
    expect(events[1]).toMatchObject({ output: 'done', isError: false })
    expect(mapper.getTool('t')).toHaveProperty('status', 'completed')
  })

  it.each(['tool_call', 'tool_call_update'] as const)(
    'buffers a title-only partial until usable invocation metadata arrives via %s',
    (sessionUpdate) => {
      const { mapper, events, update } = setup()
      mapper.beginLive()
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'Run shell', status: 'in_progress' })
      expect(mapper.getTool('t')).toMatchObject({ title: 'Run shell' })
      expect(events).toEqual([])
      update({
        sessionUpdate,
        toolCallId: 't',
        title: 'Run shell',
        kind: 'execute',
        rawInput: { command: 'pwd' },
        _meta: { tool_name: 'bash', effect_kind: 'shell' },
      })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: 'ok' })
      mapper.finish({ stopReason: 'end_turn' })
      expect(events).toEqual([
        {
          kind: 'tool:call',
          messageId: '',
          toolCallId: mapper.canonicalToolCallId('t'),
          name: 'bash',
          input: { command: 'pwd' },
        },
        { kind: 'tool:result', toolCallId: mapper.canonicalToolCallId('t'), output: 'ok', isError: false },
      ])
    },
  )

  it('keeps the EOF fallback for a title-only partial without duplicating its canonical pair', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', title: 'Run shell', status: 'completed' })
    expect(events).toEqual([])
    mapper.finish({ stopReason: 'end_turn' })
    mapper.flush()
    expect(events).toEqual([
      {
        kind: 'tool:call',
        messageId: '',
        toolCallId: mapper.canonicalToolCallId('t'),
        name: 'Run shell',
        input: undefined,
      },
      { kind: 'tool:result', toolCallId: mapper.canonicalToolCallId('t'), output: null, isError: false },
    ])
  })

  it('preserves file/diff content and replaces content arrays instead of appending duplicate snapshots', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    const content = [
      { type: 'diff' as const, path: '/tmp/file.txt', newText: 'new', oldText: 'old' },
      {
        type: 'content' as const,
        content: { type: 'resource_link' as const, uri: 'file:///tmp/file.txt', name: 'file' },
      },
    ]
    update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit file', content })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'completed',
      content,
      rawOutput: { written: true },
    })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', content })
    expect(mapper.getTool('t')?.content).toEqual(content)
    expect(events.filter((event) => event.kind === 'tool:result')).toEqual([
      {
        kind: 'tool:result',
        toolCallId: mapper.canonicalToolCallId('t'),
        output: { rawOutput: { written: true }, content },
        isError: false,
      },
    ])
  })

  it('pairs every plan update with its own TodoWrite result and no workspace task mutation', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    const entries = [{ content: 'Check files', priority: 'high' as const, status: 'completed' as const }]
    update({ sessionUpdate: 'plan', entries })
    update({ sessionUpdate: 'plan', entries })
    expect(events.map((event) => event.kind)).toEqual(['tool:call', 'tool:result', 'tool:call', 'tool:result'])
    expect(events[0]).toMatchObject({
      name: 'TodoWrite',
      input: { todos: [{ content: 'Check files', status: 'completed' }] },
    })
    expect(events[1]).toMatchObject({ toolCallId: (events[0] as { toolCallId: string }).toolCallId, isError: false })
    expect(events[2]).not.toHaveProperty('toolCallId', (events[0] as { toolCallId: string }).toolCallId)
  })

  it('ignores user/replay/unsupported blocks and unknown updates without completing a turn', () => {
    const { mapper, events, update } = setup()
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' } })
    mapper.beginLive()
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user echo' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AA==' } })
    update({ sessionUpdate: 'future_variant' } as unknown as SessionUpdate)
    mapper.flush()
    expect(events).toEqual([])
  })

  it('detects a live parent brainstorm marker split across chunks exactly once', () => {
    const { mapper, events, update } = setup()
    const chunk = (sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk', text: string) =>
      update({ sessionUpdate, content: { type: 'text', text } })
    chunk('agent_message_chunk', '[BRAINSTORM_COMPLETE]')
    mapper.beginLive()
    chunk('agent_thought_chunk', '[BRAINSTORM_COMPLETE]')
    expect(events.some((event) => event.kind === 'session:brainstorm-complete')).toBe(false)
    chunk('agent_message_chunk', 'Done [BRAINSTORM_')
    chunk('agent_message_chunk', 'COMPLETE] [BRAINSTORM_COMPLETE]')
    mapper.flush()
    expect(events.filter((event) => event.kind === 'session:brainstorm-complete')).toHaveLength(1)
  })

  it('freezes the pre-prompt baseline and emits a final delta once, including known USD cost', () => {
    const { mapper, events, update } = setup()
    update(usage(100, 40, { amount: 0.2, currency: 'USD' }))
    mapper.beginLive()
    mapper.beginLive({ inputTokens: 130, outputTokens: 50, costUsd: 0.25 })
    update(usage(140, 55, { amount: 0.3, currency: 'USD' }))
    mapper.finish(result(140, 55))
    mapper.finish(result(140, 55))
    expect(events).toEqual([{ kind: 'usage', inputTokens: 40, outputTokens: 15, costUsd: expect.closeTo(0.1) }])
  })

  it('uses a validated explicit baseline without inferring unavailable cost or cache counters', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40 })
    update(usage(140, 55, { amount: 3, currency: 'USD' }))
    mapper.finish(result(140, 55))
    expect(events).toEqual([{ kind: 'usage', inputTokens: 40, outputTokens: 15 }])
  })

  it('does not charge history when the first valid counters arrive after beginLive', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive()
    update(usage(140, 55))
    mapper.finish(result(140, 55))
    expect(events).toEqual([])
  })

  it('never treats context occupancy, an invalid baseline or missing counters as consumed input', () => {
    for (const baseline of [undefined, { inputTokens: -1, outputTokens: 0 }]) {
      const { mapper, events, update } = setup()
      update({ sessionUpdate: 'usage_update', used: 5000, size: 200000 })
      mapper.beginLive(baseline)
      mapper.finish(result(140, 55))
      expect(events).toEqual([])
    }
    const { mapper, events, update } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40 })
    update({ sessionUpdate: 'usage_update', used: 5000, size: 200000 })
    mapper.finish({ stopReason: 'end_turn' })
    expect(events).toEqual([])
  })

  it('omits a reset cost while retaining trustworthy token deltas', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40, costUsd: 1 })
    update(usage(140, 55, { amount: 0.5, currency: 'USD' }))
    mapper.finish(result(140, 55))
    expect(events).toEqual([{ kind: 'usage', inputTokens: 40, outputTokens: 15 }])
  })

  it.each([
    [-1, 55],
    [140, Number.NaN],
    [Number.POSITIVE_INFINITY, 55],
    ['140', 55],
    [99, 55],
    [140, 39],
  ])('omits invalid/reset final counters (%s/%s)', (input, output) => {
    const { mapper, events } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40 })
    mapper.finish(result(input, output))
    expect(events).toEqual([])
  })

  it('does not recover a reset counter or cost by inventing a replacement baseline', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40, costUsd: 1 })
    update(usage(10, 5, { amount: 0.1, currency: 'USD' }))
    update(usage(200, 80, { amount: 2, currency: 'USD' }))
    mapper.finish(result(200, 80))
    expect(events).toEqual([])
  })

  it('validates unchecked native usage objects and can finish from the last typed update', () => {
    const { mapper, events, update } = setup()
    mapper.beginLive({ inputTokens: 100, outputTokens: 40 })
    update(usage(140, 55, { amount: 12, currency: 'EUR' }))
    mapper.finish({ stopReason: 'end_turn', usage: null } as PromptResponse)
    expect(events).toEqual([{ kind: 'usage', inputTokens: 40, outputTokens: 15 }])
    for (const invalid of [[], 'bad', { inputTokens: 0 }, { outputTokens: 0 }]) {
      const next = setup()
      next.mapper.beginLive({ inputTokens: 0, outputTokens: 0 })
      next.mapper.finish({ stopReason: 'end_turn', usage: invalid } as PromptResponse)
      expect(next.events).toEqual([])
    }
  })

  it.each(['max_tokens', 'max_turn_requests', 'refusal'] as const)(
    'reports the native %s outcome without inventing quotas or lifecycle completion',
    (stopReason) => {
      const { mapper, events } = setup()
      mapper.beginLive()
      mapper.finish({ stopReason })
      expect(events).toEqual([expect.objectContaining({ kind: 'error', category: 'other', code: `acp_${stopReason}` })])
    },
  )

  it('leaves cancellation and lifecycle completion to the engine', () => {
    const { mapper, events } = setup()
    mapper.beginLive()
    mapper.finish({ stopReason: 'cancelled' })
    expect(events).toEqual([])
  })

  it('reports an invalid unchecked terminal response without fabricating completion', () => {
    const { mapper, events } = setup()
    mapper.beginLive()
    mapper.finish(null as unknown as PromptResponse)
    expect(events).toEqual([expect.objectContaining({ kind: 'error', category: 'parse_error' })])
  })

  it('maps only live explicit compaction signals and deduplicates their terminals', () => {
    const { mapper, events, update } = setup()
    update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' })
    mapper.beginLive()
    update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' })
    update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' })
    update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' })
    expect(events).toEqual([
      { kind: 'session:compacting', compactionId: expect.any(String), active: true },
      { kind: 'session:compacting', compactionId: expect.any(String), active: false },
      { kind: 'session:compacted', compactionId: expect.any(String) },
    ])
  })
})
