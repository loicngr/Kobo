import { describe, expect, it, vi } from 'vitest'

let abortSignal: AbortSignal | undefined
let emitSubagentStarted = false
let skipSecondResult = false
let emitStalledExtraTurn = false
let completeSubagent: (() => void) | undefined
let extraTurnGate: (() => void) | undefined
let releaseStream: (() => void) | undefined
let stopTaskMock: ReturnType<typeof vi.fn>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { abortController?: AbortController } }) => {
    abortSignal = args.options.abortController?.signal
    stopTaskMock = vi.fn(async () => {})
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-drain', model: 'm', slash_commands: [] }
        if (emitSubagentStarted) {
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task-review-1',
            tool_use_id: 'review-1',
            description: 'Full PR review',
          }
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        if (emitSubagentStarted) {
          if (emitStalledExtraTurn) {
            // A second, healthy turn — the subagent is still active but real
            // forward progress happened. The stall countdown must restart
            // from here, not from the first result above.
            await new Promise<void>((resolve) => {
              extraTurnGate = resolve
            })
            yield { type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 3 } }
          }
          await new Promise<void>((resolve) => {
            completeSubagent = resolve
          })
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-review-1',
            tool_use_id: 'review-1',
            status: 'completed',
          }
          if (!skipSecondResult) {
            yield { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 2 } }
          }
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          abortSignal?.addEventListener('abort', resolve, { once: true })
        })
      },
      stopTask: (taskId: string) => stopTaskMock(taskId),
    }
  }),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent, StartOptions } from '../server/services/agent/engines/types.js'

const BASE_OPTIONS: StartOptions = {
  workspaceId: 'w-drain',
  workingDir: '/tmp',
  prompt: 'go',
  backendUrl: 'http://localhost:3000',
  koboHome: '/tmp/kobo',
  settings: { dangerouslySkipPermissions: true } as any,
}

function resetControls(): void {
  completeSubagent = undefined
  extraTurnGate = undefined
  releaseStream = undefined
  emitSubagentStarted = false
  skipSecondResult = false
  emitStalledExtraTurn = false
}

describe('claude-code engine — result drain watchdog', () => {
  it('emits a turn-completed signal as soon as a result has no background work', async () => {
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(0)

      expect(events).toContainEqual({ kind: 'turn:completed' })
    } finally {
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('aborts a stuck SDK stream with no background subagent', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = false
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('keeps the SDK stream attached through the background continuation, then drains it', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).not.toContainEqual({ kind: 'turn:completed' })
      expect(events).not.toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(false)

      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(events).toContainEqual({ kind: 'turn:completed' })
      expect(events).not.toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('closes promptly once a subagent reports its terminal status with no further result message', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      skipSecondResult = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(1_000)
      completeSubagent?.()
      // No second 'result' ever arrives on this stream — the per-event
      // bookkeeping (not the 'result' branch) must react as soon as the
      // subagent set empties instead of waiting out the 10-minute stall.
      await vi.advanceTimersByTimeAsync(20_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('resets the stall countdown on each subsequent result while a subagent stays active', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      emitStalledExtraTurn = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // First result arms the 10-minute stall countdown (deadline ~t=601s).
      await vi.advanceTimersByTimeAsync(1_000)

      // A second, healthy result arrives 8 minutes later, subagent still
      // active — this must push the deadline out to ~t=1082s rather than
      // leaving the original ~t=601s deadline in place.
      await vi.advanceTimersByTimeAsync(8 * 60_000)
      extraTurnGate?.()
      await vi.advanceTimersByTimeAsync(1_000)

      // t≈632s: past the ORIGINAL deadline, well before the reset one.
      await vi.advanceTimersByTimeAsync(150_000)
      expect(events.some((e) => e.kind === 'session:ended')).toBe(false)

      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(20_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
    } finally {
      completeSubagent?.()
      extraTurnGate?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('force-ends the session as an error when a subagent never reports a terminal notification', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Never resolve `completeSubagent` — the subagent silently vanishes
      // (dropped notification), leaving activeSubagentToolCallIds populated
      // forever. Only the stall watchdog can recover the session.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 20_000)

      // Forced by the stall watchdog rather than a clean finish — reported
      // as an error, not 'completed', so auto-loop/UI don't mistake a
      // possibly-still-running orphaned subagent for successful progress.
      expect(events).toContainEqual({ kind: 'session:ended', reason: 'error', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('does not discard subagent tracking or force-close when a message is queued right as the stall watchdog fires', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      const process = await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // Subagent never reports back, but the user sends a follow-up message
      // shortly before the 10-minute deadline — the watchdog must not force
      // through under a message that's about to start a new turn.
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      process.sendMessage('are you still there?')
      await vi.advanceTimersByTimeAsync(60_000 + 20_000)

      expect(events.some((e) => e.kind === 'session:ended')).toBe(false)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('interrupt() stops in-flight subagent tasks via the SDK instead of only soft-interrupting', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      const process = await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(1_000)
      process.interrupt()

      expect(stopTaskMock).toHaveBeenCalledWith('task-review-1')
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })
})
