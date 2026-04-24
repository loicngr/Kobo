import { describe, expect, it, vi } from 'vitest'
import {
  createParserState,
  parseClaudeLine,
} from '../../../../server/services/agent/engines/claude-code/stream-parser.js'
import { loadFixture } from './fixtures-loader.js'

describe('parseClaudeLine', () => {
  it('emits nothing for empty lines', () => {
    const state = createParserState()
    const { events } = parseClaudeLine('', state)
    expect(events).toEqual([])
  })

  it('emits a message:raw event for non-JSON lines (fallback)', () => {
    const state = createParserState()
    const { events } = parseClaudeLine('not json at all', state)
    expect(events).toEqual([{ kind: 'message:raw', content: 'not json at all' }])
  })

  it('emits session:started + skills:discovered from system/init', () => {
    const state = createParserState()
    const lines = loadFixture('init')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }
    const started = all.find((e) => e.kind === 'session:started')
    expect(started).toMatchObject({
      kind: 'session:started',
      engineSessionId: 'abc-123-def',
      model: 'claude-sonnet-4-6',
    })
    const skills = all.find((e) => e.kind === 'skills:discovered')
    expect(skills).toMatchObject({
      kind: 'skills:discovered',
      skills: ['kobo-check-progress', 'brainstorm', 'commit'],
    })
  })

  it('does not re-emit session:started for a second init with the same session_id', () => {
    const state = createParserState()
    const line =
      '{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4-6","slash_commands":["foo"]}'
    parseClaudeLine(line, state)
    const { events } = parseClaudeLine(line, state)
    expect(events.find((e) => e.kind === 'session:started')).toBeUndefined()
    expect(events.find((e) => e.kind === 'skills:discovered')).toBeDefined()
  })

  it('init without slash_commands does not emit skills:discovered', () => {
    const state = createParserState()
    const line = '{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4-6"}'
    const { events } = parseClaudeLine(line, state)
    expect(events.find((e) => e.kind === 'skills:discovered')).toBeUndefined()
  })
})

describe('parseClaudeLine — streaming text', () => {
  it('produces one message:text per assistant delta, preserves messageId, and closes with message:end on message_stop', () => {
    const state = createParserState()
    const lines = loadFixture('text-streaming')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }

    const textEvents = all.filter((e) => e.kind === 'message:text')
    expect(textEvents).toHaveLength(3)
    expect(textEvents.map((e) => e.text)).toEqual(['Hello ', 'world', ' !'])
    expect(new Set(textEvents.map((e) => e.messageId)).size).toBe(1) // same messageId across chunks
    for (const e of textEvents.slice(0, 2)) expect(e.streaming).toBe(true)
    // Last chunk is the one followed by message_stop — still streaming:true; message:end closes.
    expect(textEvents[2].streaming).toBe(true)

    const endEvent = all.find((e) => e.kind === 'message:end')
    expect(endEvent).toBeDefined()
    expect((endEvent as { messageId: string }).messageId).toBe((textEvents[0] as { messageId: string }).messageId)
  })
})

describe('parseClaudeLine — tool use + tool result', () => {
  it('emits tool:call for an assistant tool_use block and tool:result for the matching user tool_result', () => {
    const state = createParserState()
    const lines = loadFixture('tool-use-result')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }

    const calls = all.filter((e) => e.kind === 'tool:call')
    const results = all.filter((e) => e.kind === 'tool:result')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      kind: 'tool:call',
      toolCallId: 'toolu_01',
      name: 'Read',
      input: { file_path: '/tmp/foo.ts' },
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      kind: 'tool:result',
      toolCallId: 'toolu_01',
      output: 'file contents here',
      isError: false,
    })
  })
})

describe('parseClaudeLine — thinking', () => {
  it('emits message:thinking for an assistant thinking block', () => {
    const state = createParserState()
    const lines = loadFixture('thinking')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }
    const thinking = all.find((e) => e.kind === 'message:thinking')
    expect(thinking).toMatchObject({ kind: 'message:thinking', text: 'Let me consider the approach...' })
  })
})

describe('parseClaudeLine — result + usage', () => {
  it('emits usage from a result message', () => {
    const state = createParserState()
    const lines = loadFixture('result')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }
    const usage = all.find((e) => e.kind === 'usage')
    expect(usage).toMatchObject({
      kind: 'usage',
      inputTokens: 1200,
      outputTokens: 450,
      cacheRead: 300,
      cacheWrite: 100,
      costUsd: 0.0234,
    })
  })
})

describe('parseClaudeLine — compact', () => {
  it('emits session:compacted for system/compact and system/compact_boundary', () => {
    const state = createParserState()
    const lines = loadFixture('compact')
    const all: Array<{ kind: string }> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...events)
    }
    const compacts = all.filter((e) => e.kind === 'session:compacted')
    expect(compacts).toHaveLength(2)
  })
})

describe('parseClaudeLine — subagent', () => {
  it('emits subagent:progress for task_started/task_progress (running) and task_notification (done on terminal status)', () => {
    const state = createParserState()
    const lines = loadFixture('subagent')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }
    const progress = all.filter((e) => e.kind === 'subagent:progress') as Array<
      {
        kind: 'subagent:progress'
        status: 'running' | 'done'
        toolCallId: string
      } & Record<string, unknown>
    >
    expect(progress).toHaveLength(3)
    expect(progress[0].status).toBe('running') // task_started
    expect(progress[1].status).toBe('running') // task_progress
    expect(progress[2].status).toBe('done') // task_notification with status=completed
    expect(new Set(progress.map((e) => e.toolCallId))).toEqual(new Set(['toolu_task_1']))
    expect(progress[1].lastToolName).toBe('Grep')
    expect(progress[2].totalTokens).toBe(5678)
    expect(progress[2].durationMs).toBe(12000)
  })
})

describe('parseClaudeLine — rate_limit', () => {
  it("normalises Claude's native rateLimitType shape into a single bucket with usedPct", () => {
    const state = createParserState()
    const lines = loadFixture('rate-limit')
    const { events: e1 } = parseClaudeLine(lines[0], state)
    const rl1 = e1.find((e) => e.kind === 'rate_limit') as
      | { kind: 'rate_limit'; info: { buckets: unknown[] } }
      | undefined
    expect(rl1).toBeDefined()
    expect(rl1!.info.buckets).toHaveLength(1)
    const bucket = rl1!.info.buckets[0] as { id: string; usedPct: number; resetsAt?: string }
    expect(bucket.id).toBe('five_hour')
    expect(bucket.usedPct).toBeCloseTo(42) // utilization: 0.42 → 42%
    expect(bucket.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO string
  })

  it("normalises Claude's legacy buckets[] shape with used/limit", () => {
    const state = createParserState()
    const lines = loadFixture('rate-limit')
    parseClaudeLine(lines[0], state)
    const { events } = parseClaudeLine(lines[1], state)
    const rl = events.find((e) => e.kind === 'rate_limit') as { kind: 'rate_limit'; info: { buckets: unknown[] } }
    expect(rl.info.buckets).toHaveLength(1)
    const bucket = rl.info.buckets[0] as { id: string; usedPct: number; details?: string }
    expect(bucket.id).toBe('weekly')
    expect(bucket.usedPct).toBeCloseTo(24) // 12000 / 50000
    expect(bucket.details).toBe('12000 / 50000')
  })
})

describe('parseClaudeLine — text-based quota detection', () => {
  // Helper that wraps a text block inside the assistant-message stream-json
  // frame shape Claude Code uses.
  function assistantTextLine(text: string, messageId = 'msg_test'): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        id: messageId,
        content: [{ type: 'text', text }],
      },
    })
  }

  it('emits rate_limit + error(quota) when the agent says "You\'ve hit your limit"', () => {
    const state = createParserState()
    const line = assistantTextLine("You've hit your limit · resets 1:20pm (Europe/Paris)")
    const { events } = parseClaudeLine(line, state)

    const error = events.find((e) => e.kind === 'error')
    expect(error).toMatchObject({ kind: 'error', category: 'quota' })

    const rl = events.find((e) => e.kind === 'rate_limit') as
      | {
          kind: 'rate_limit'
          info: { buckets: Array<{ id: string; usedPct: number; resetsAt?: string; label?: string }> }
        }
      | undefined
    expect(rl).toBeDefined()
    const bucket = rl!.info.buckets[0]
    expect(bucket.id).toBe('text-detected')
    expect(bucket.usedPct).toBe(100)
    expect(bucket.resetsAt).toBeDefined()
    expect(bucket.label).toBeUndefined()
  })

  it('still emits the original message:text event (detection is additive, not a replacement)', () => {
    const state = createParserState()
    const line = assistantTextLine("You've hit your limit · resets 3pm")
    const { events } = parseClaudeLine(line, state)
    const text = events.find((e) => e.kind === 'message:text')
    expect(text).toMatchObject({ kind: 'message:text', text: "You've hit your limit · resets 3pm" })
  })

  it('handles "resets 11am" without minute or timezone', () => {
    const state = createParserState()
    const line = assistantTextLine("You've hit your limit · resets 11am")
    const { events } = parseClaudeLine(line, state)
    const rl = events.find((e) => e.kind === 'rate_limit') as
      | { kind: 'rate_limit'; info: { buckets: Array<{ resetsAt?: string }> } }
      | undefined
    expect(rl).toBeDefined()
    expect(rl!.info.buckets[0].resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  it('rolls the date forward when the reset time is already in the past today', () => {
    // 23:30 local now, "reset 1am" → should parse as tomorrow 01:00 local.
    const state = createParserState()
    const line = assistantTextLine("You've hit your limit · resets 1am (UTC)")
    // We can't easily fake Date here without vi.useFakeTimers; instead just
    // assert the result is in the future (within 24h).
    const before = Date.now()
    const { events } = parseClaudeLine(line, state)
    const rl = events.find((e) => e.kind === 'rate_limit') as
      | { kind: 'rate_limit'; info: { buckets: Array<{ resetsAt?: string }> } }
      | undefined
    const ts = new Date(rl!.info.buckets[0].resetsAt as string).getTime()
    expect(ts).toBeGreaterThan(before - 60_000)
    expect(ts - before).toBeLessThan(24 * 60 * 60 * 1000 + 60_000)
  })

  it('parses the announced timezone into the correct UTC reset instant', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-23T13:29:37.000Z'))
      const state = createParserState()
      const line = assistantTextLine("You've hit your limit · resets 8am (Europe/Paris)")
      const { events } = parseClaudeLine(line, state)
      const rl = events.find((e) => e.kind === 'rate_limit') as
        | { kind: 'rate_limit'; info: { buckets: Array<{ resetsAt?: string }> } }
        | undefined
      expect(rl).toBeDefined()
      expect(rl!.info.buckets[0].resetsAt).toBe('2026-04-24T06:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours the announced timezone when it differs from the machine timezone', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-23T13:29:37.000Z'))
      const state = createParserState()
      const line = assistantTextLine("You've hit your limit · resets 8am (UTC)")
      const { events } = parseClaudeLine(line, state)
      const rl = events.find((e) => e.kind === 'rate_limit') as
        | { kind: 'rate_limit'; info: { buckets: Array<{ resetsAt?: string }> } }
        | undefined
      expect(rl).toBeDefined()
      expect(rl!.info.buckets[0].resetsAt).toBe('2026-04-24T08:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT synthesise quota events for unrelated text', () => {
    const state = createParserState()
    const line = assistantTextLine('Everything went fine, I committed the change.')
    const { events } = parseClaudeLine(line, state)
    expect(events.find((e) => e.kind === 'error')).toBeUndefined()
    expect(events.find((e) => e.kind === 'rate_limit')).toBeUndefined()
  })
})

describe('parseClaudeLine — brainstorm-complete marker', () => {
  it('emits session:brainstorm-complete for both the assistant text block and the raw marker line in the fixture', () => {
    const state = createParserState()
    const lines = loadFixture('brainstorm-complete')
    const all: Array<{ kind: string } & Record<string, unknown>> = []
    for (const line of lines) {
      const { events } = parseClaudeLine(line, state)
      all.push(...(events as unknown as Array<{ kind: string } & Record<string, unknown>>))
    }
    const completes = all.filter((e) => e.kind === 'session:brainstorm-complete')
    // One from the assistant text block + one from the raw trailing marker line
    expect(completes.length).toBeGreaterThanOrEqual(2)
    // Also expect a message:raw for the standalone `[BRAINSTORM_COMPLETE]` line
    expect(all).toContainEqual(expect.objectContaining({ kind: 'message:raw', content: '[BRAINSTORM_COMPLETE]' }))
  })
})
