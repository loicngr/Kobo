import { describe, expect, it, vi } from 'vitest'

let abortSignal: AbortSignal | undefined
let releaseStream: (() => void) | undefined
let emitCompactingStatus = false
let emitOutputAfterCompaction = false
let emitSubagentOutputAfterCompaction = false
let emitToolResult = false
let emitSubagentStart = false
let emitPermissionRequest = false
let emitDelayedSubagentProgress = false
let emitDelayedForegroundProgress = false
let releaseProgress: (() => void) | undefined

type MockCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; toolUseID: string },
) => Promise<unknown>

// The SDK yields an init message and one assistant message that carries a
// TOOL CALL — the majority shape — then parks forever. No `result` ever
// arrives: this is a mid-tool-call freeze (half-closed connection, stuck MCP).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { abortController?: AbortController; canUseTool?: MockCanUseTool } }) => {
    abortSignal = args.options.abortController?.signal
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-live', model: 'm', slash_commands: [] }
        if (emitSubagentStart) {
          // Maps to a `subagent:progress` event with status 'running' (see
          // event-mapper.ts, subtype task_started) — the engine then tracks
          // the subagent in activeSubagentTaskIds until a task_notification
          // arrives... which never does in this frozen stream.
          yield { type: 'system', subtype: 'task_started', task_id: 'task-sub-1', tool_use_id: 'toolu_sub_1' }
        }
        if (emitDelayedSubagentProgress) {
          await new Promise<void>((resolve) => {
            releaseProgress = resolve
          })
          if (emitDelayedForegroundProgress) {
            yield {
              type: 'assistant',
              message: { id: 'parent-progress', content: [{ type: 'text', text: 'Still working' }] },
            }
          } else {
            yield { type: 'system', subtype: 'task_progress', task_id: 'task-sub-1', tool_use_id: 'toolu_sub_1' }
          }
        }
        if (emitPermissionRequest && args.options.canUseTool) {
          // Fire-and-forget: canUseTool synchronously registers the pending
          // resolver and pauses turnLiveness before returning its Promise —
          // the test resolves it later from outside via
          // engineProcess.resolvePendingUserInput, exactly like a human
          // answering a permission/question card.
          void args.options.canUseTool(
            'AskUserQuestion',
            { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
            { signal: abortSignal ?? new AbortController().signal, toolUseID: 'toolu_perm_1' },
          )
        }
        yield {
          type: 'assistant',
          message: {
            id: 'msg-tool-1',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 999' } }],
            stop_reason: 'tool_use',
          },
        }
        if (emitToolResult) {
          yield {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
          }
        }
        if (emitCompactingStatus) {
          yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-live' }
          if (emitSubagentOutputAfterCompaction) {
            yield {
              type: 'assistant',
              parent_tool_use_id: 'task-1',
              message: {
                id: 'child',
                content: [{ type: 'tool_use', id: 'child-tool', name: 'Bash', input: { command: 'echo child' } }],
              },
            }
          }
          if (emitOutputAfterCompaction) {
            yield { type: 'assistant', message: { id: 'resumed', content: [{ type: 'text', text: 'Resumed' }] } }
          }
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      stopTask: async () => {},
    }
  }),
}))

import {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  CLAUDE_TOOL_IDLE_TIMEOUT_MS,
  COMPACTION_STALL_TIMEOUT_MS,
  createClaudeCodeEngine,
  RESULT_DRAIN_TIMEOUT_MS,
  SUBAGENT_STALL_TIMEOUT_MS,
} from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'

const BASE_OPTIONS: StartOptions = {
  workspaceId: 'w-liveness',
  workingDir: '/tmp',
  prompt: 'go',
  backendUrl: 'http://localhost:3000',
  koboHome: '/tmp/kobo',
  settings: { dangerouslySkipPermissions: true } as never,
}

describe('claude-code engine — shared turn liveness', () => {
  it('force-ends a stream frozen after a tool call, not only after a text-only reply', async () => {
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Let the two messages drain, then stay silent past the deadline.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(events.some((e) => e.kind === 'session:ended')).toBe(false)

      // A tool call is in flight: the short idle deadline must NOT fire.
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
      expect(events.some((e) => e.kind === 'session:ended')).toBe(false)

      // The tool-aware ceiling still reaps a genuinely dead stream.
      await vi.advanceTimersByTimeAsync(CLAUDE_TOOL_IDLE_TIMEOUT_MS)
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
      expect(events.some((e) => e.kind === 'error' && e.category === 'other' && /watchdog/i.test(e.message))).toBe(true)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      vi.useRealTimers()
    }
  })

  it('returns to the short deadline once the tool_result arrives', async () => {
    vi.useFakeTimers()
    try {
      emitToolResult = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(1_000)
      expect(events.some((e) => e.kind === 'session:ended')).toBe(false)

      // No tool in flight anymore: silence past the SHORT deadline reaps it.
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      if (emitCompactingStatus) expect(events).toContainEqual({ kind: 'session:compacting', active: false })
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitToolResult = false
      vi.useRealTimers()
    }
  })

  it('does not force-end while Claude reports that it is compacting context', async () => {
    vi.useFakeTimers()
    try {
      emitCompactingStatus = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS * 2)

      expect(events).toContainEqual({ kind: 'session:compacting', active: true })
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
      expect(abortSignal?.aborted).toBe(false)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      vi.useRealTimers()
    }
  })

  it('keeps parent compaction active while a subagent emits tool calls', async () => {
    vi.useFakeTimers()
    emitCompactingStatus = true
    emitSubagentOutputAfterCompaction = true
    try {
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS * 2)
      expect(events).toContainEqual({ kind: 'session:compacting', active: true })
      expect(events.some((event) => event.kind === 'tool:call' && event.toolCallId === 'child-tool')).toBe(true)
      expect(events).not.toContainEqual({ kind: 'session:compacting', active: false })
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      emitSubagentOutputAfterCompaction = false
      vi.useRealTimers()
    }
  })

  it('ends the compaction pause when real output resumes without a status update', async () => {
    vi.useFakeTimers()
    emitCompactingStatus = true
    emitOutputAfterCompaction = true
    try {
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toContainEqual({ kind: 'session:compacting', active: false })
      await vi.advanceTimersByTimeAsync(CLAUDE_TOOL_IDLE_TIMEOUT_MS)
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      emitOutputAfterCompaction = false
      vi.useRealTimers()
    }
  })

  it('reaps a compaction that never completes after the stall ceiling', async () => {
    vi.useFakeTimers()
    try {
      emitCompactingStatus = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Existing behavior guard: still alive well past the idle deadline.
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS * 2)
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)

      // Stall ceiling elapses, liveness resumes, tool-aware deadline reaps it
      // (the mock stream has a tool call in flight — see the mock generator).
      await vi.advanceTimersByTimeAsync(COMPACTION_STALL_TIMEOUT_MS + CLAUDE_TOOL_IDLE_TIMEOUT_MS)
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      if (emitCompactingStatus) expect(events).toContainEqual({ kind: 'session:compacting', active: false })
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      vi.useRealTimers()
    }
  })

  it('still drains a stalled compaction with a subagent tracked (independent subagent watchdog)', async () => {
    // Compaction and the foreground idle pause cannot mask a dead subagent.
    vi.useFakeTimers()
    try {
      emitCompactingStatus = true
      emitSubagentStart = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Sanity: the subagent is tracked and nothing has ended.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'subagent:progress', toolCallId: 'toolu_sub_1', status: 'running' }),
      )
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)

      // The independently armed subagent deadline expires during compaction.
      await vi.advanceTimersByTimeAsync(COMPACTION_STALL_TIMEOUT_MS + 1_000)
      expect(events.some((event) => event.kind === 'session:ended')).toBe(true)

      // Later timers must not duplicate the terminal event.
      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + RESULT_DRAIN_TIMEOUT_MS + 1_000)
      expect(events.filter((event) => event.kind === 'session:ended')).toHaveLength(1)
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      emitSubagentStart = false
      vi.useRealTimers()
    }
  })

  it('reaps a compaction that never completes onto the short deadline when no tool is in flight', async () => {
    vi.useFakeTimers()
    try {
      emitCompactingStatus = true
      emitToolResult = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Existing behavior guard: still alive well past the idle deadline.
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS * 2)
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)

      // Stall ceiling elapses, liveness resumes; the tool_result already
      // arrived so no tool is in flight — the SHORT deadline reaps it,
      // not the longer tool-aware ceiling.
      await vi.advanceTimersByTimeAsync(COMPACTION_STALL_TIMEOUT_MS + CLAUDE_STREAM_IDLE_TIMEOUT_MS)
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      if (emitCompactingStatus) expect(events).toContainEqual({ kind: 'session:compacting', active: false })
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitCompactingStatus = false
      emitToolResult = false
      vi.useRealTimers()
    }
  })

  it('keeps the deadline paused when a permission card resolves while a subagent is still active', async () => {
    // Regression for the three-copies-of-the-same-check bug:
    // resolvePendingUserInput used to resume the deadline the moment the
    // LAST pending card was answered, without checking whether a background
    // subagent (or a compaction) was still a legitimate reason to stay
    // paused. Reproduce the exact interleaving: a subagent is tracked
    // active, a permission card is answered from outside, and the deadline
    // must remain paused — not force-end the session once the plain idle
    // timeout would otherwise have elapsed.
    vi.useFakeTimers()
    try {
      emitSubagentStart = true
      emitToolResult = true
      emitPermissionRequest = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      const proc = await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Let the mock stream drain: subagent start, permission request, the
      // tool call, and its result.
      await vi.advanceTimersByTimeAsync(1_000)

      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'subagent:progress', toolCallId: 'toolu_sub_1', status: 'running' }),
      )
      const requested = events.find((e) => e.kind === 'session:user-input-requested')
      expect(requested).toBeDefined()
      if (requested && requested.kind === 'session:user-input-requested') {
        expect(requested.toolCallId).toBe('toolu_perm_1')
      }

      // Answer the permission card while the subagent is still tracked
      // active — the buggy code path this test guards against.
      const resolved = proc.resolvePendingUserInput('toolu_perm_1', { kind: 'question', answers: { 'Q?': 'A' } })
      expect(resolved).toBe(true)

      // Before the fix, answering the last pending card unconditionally
      // resumed the deadline (checking only pendingResolvers.size), ignoring
      // the still-active subagent. That would force-end the session here
      // even though the subagent's own watchdog should still own this
      // window. With the fix, the shared re-evaluation keeps it paused.
      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS * 2)
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      emitSubagentStart = false
      emitToolResult = false
      emitPermissionRequest = false
      vi.useRealTimers()
    }
  })
})

it('bounds a silent subagent before the first result without timing out a human', async () => {
  vi.useFakeTimers()
  emitSubagentStart = true
  emitPermissionRequest = true
  const events: AgentEvent[] = []
  try {
    const proc = await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS * 2)
    expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    proc.resolvePendingUserInput('toolu_perm_1', { kind: 'question', answers: { 'Q?': 'A' } })
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + RESULT_DRAIN_TIMEOUT_MS + 1)
    expect(events.filter((event) => event.kind === 'session:ended')).toEqual([
      expect.objectContaining({ reason: 'watchdog' }),
    ])
    expect(abortSignal?.aborted).toBe(true)
  } finally {
    releaseStream?.()
    emitSubagentStart = false
    emitPermissionRequest = false
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
  }
})

it.each(['subagent', 'foreground'])('renews the pre-result watchdog on meaningful %s progress', async (source) => {
  vi.useFakeTimers()
  emitSubagentStart = true
  emitDelayedSubagentProgress = true
  emitDelayedForegroundProgress = source === 'foreground'
  const events: AgentEvent[] = []
  try {
    await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS - 1_000)
    expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    releaseProgress?.()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS)
    expect(events.filter((event) => event.kind === 'session:ended')).toEqual([
      expect.objectContaining({ reason: 'watchdog' }),
    ])
  } finally {
    releaseProgress?.()
    releaseStream?.()
    emitSubagentStart = false
    emitDelayedSubagentProgress = false
    emitDelayedForegroundProgress = false
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
  }
})
