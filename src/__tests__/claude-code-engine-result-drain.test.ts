import { describe, expect, it, type Mock, vi } from 'vitest'

let abortSignal: AbortSignal | undefined
let emitSubagentStarted = false
let skipSecondResult = false
let emitStalledExtraTurn = false
let emitActivityAfterSubagentCompletion = false
let completeSubagent: (() => void) | undefined
let extraTurnGate: (() => void) | undefined
let releaseStream: (() => void) | undefined
let sdkInput: AsyncIterable<unknown>
let stopTaskMock: Mock<(taskId: string) => Promise<void>>
// Optional overrides of the default subagent messages, used to replay real
// sequences where one task changes identity (tool_use_id vs task_id).
let startedMessages: Record<string, unknown>[] | undefined
let completionMessages: Record<string, unknown>[] | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown>; options: { abortController?: AbortController } }) => {
    sdkInput = args.prompt
    abortSignal = args.options.abortController?.signal
    stopTaskMock = vi.fn(async (_taskId: string) => {})
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-drain', model: 'm', slash_commands: [] }
        if (emitSubagentStarted) {
          if (startedMessages) {
            for (const message of startedMessages) yield message
          } else {
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: 'task-review-1',
              tool_use_id: 'review-1',
              description: 'Full PR review',
            }
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
          if (completionMessages) {
            for (const message of completionMessages) yield message
          } else {
            yield {
              type: 'system',
              subtype: 'task_notification',
              task_id: 'task-review-1',
              tool_use_id: 'review-1',
              status: 'completed',
            }
          }
          if (emitActivityAfterSubagentCompletion) {
            yield {
              type: 'assistant',
              message: {
                id: 'msg-after-subagent',
                content: [{ type: 'text', text: 'continuation after subagent completion' }],
                stop_reason: null,
              },
            }
          }
          if (!skipSecondResult) {
            yield { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 2 } }
          }
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      stopTask: (taskId: string) => stopTaskMock(taskId),
    }
  }),
}))

import {
  BACKGROUND_CONTINUATION_GRACE_MS,
  createClaudeCodeEngine,
  RESULT_CONTINUATION_GRACE_MS,
} from '../server/services/agent/engines/claude-code/engine.js'
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
  emitActivityAfterSubagentCompletion = false
  startedMessages = undefined
  completionMessages = undefined
}

const task = (
  subtype: string,
  ids: { task_id: string; tool_use_id?: string },
  extra: Record<string, unknown> = {},
) => ({
  type: 'system',
  subtype,
  ...ids,
  ...extra,
})

describe('claude-code engine — result drain watchdog', () => {
  it('delivers a wakeup to the existing stream while only a background task remains', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const process = await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
      const input = sdkInput[Symbol.asyncIterator]()
      await input.next() // The SDK consumes the initial prompt.
      await vi.advanceTimersByTimeAsync(0)

      expect(process.sendWakeupIfWaiting?.('check the reset log')).toBe(true)
      expect((await input.next()).value).toMatchObject({
        message: { role: 'user', content: 'check the reset log' },
      })
      expect(process.sendWakeupIfWaiting?.('duplicate')).toBe(false)
      expect(abortSignal?.aborted).toBe(false)
      expect(stopTaskMock).not.toHaveBeenCalled()
      expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('does not inject a wakeup while the parent is continuing after background completion', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      skipSecondResult = true
      emitActivityAfterSubagentCompletion = true
      const process = await createClaudeCodeEngine().start(BASE_OPTIONS, () => {})
      await vi.advanceTimersByTimeAsync(0)
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(process.sendWakeupIfWaiting?.('too early')).toBe(false)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('defers a wakeup when a user message is already queued on the background wait', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const process = await createClaudeCodeEngine().start(BASE_OPTIONS, () => {})
      await vi.advanceTimersByTimeAsync(0)
      process.sendMessage('new instructions from the user')

      expect(process.sendWakeupIfWaiting?.('check logs')).toBe(false)
      expect(abortSignal?.aborted).toBe(false)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('emits a turn-completed signal once a result without background work is not followed up', async () => {
    vi.useFakeTimers()
    try {
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      // The CLI may still continue right after a result (resumed turn).
      await vi.advanceTimersByTimeAsync(0)
      expect(events).not.toContainEqual({ kind: 'turn:completed' })

      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
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

      // The input closes after the post-result grace, then the drain runs.
      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 15_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          category: 'other',
          code: 'result_drain_timeout',
        }),
      )
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
      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)

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

  it('closes after the continuation grace once a subagent reports its terminal status with no further message', async () => {
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
      // bookkeeping (not the 'result' branch) must react once the subagent
      // set empties and the parent stays silent, instead of waiting out the
      // 10-minute stall.
      await vi.advanceTimersByTimeAsync(BACKGROUND_CONTINUATION_GRACE_MS + 20_000)

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

  it('does not drain a stream that continues after its final subagent reports done', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      skipSecondResult = true
      emitActivityAfterSubagentCompletion = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, (event) => events.push(event))

      await vi.advanceTimersByTimeAsync(1_000)
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(1_000)

      // The parent stream has emitted a real assistant message after the
      // subagent settled. It is still alive, so the 15-second result-drain
      // guard must not terminate it.
      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).not.toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(false)
    } finally {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }
  })

  it('keeps the SDK input open while the parent continues after its final background subagent', async () => {
    // Regression: closing stdin on the subagent's terminal notification broke
    // every permission request of the automatic parent continuation with
    // "Tool permission request failed: AbortError: Stream closed".
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      skipSecondResult = true
      emitActivityAfterSubagentCompletion = true
      const engine = createClaudeCodeEngine()
      await engine.start(BASE_OPTIONS, () => {})
      const input = sdkInput[Symbol.asyncIterator]()
      await input.next() // Initial prompt.
      let inputEnded = false
      void input.next().then((next) => {
        inputEnded = next.done === true
      })

      await vi.advanceTimersByTimeAsync(1_000)
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(BACKGROUND_CONTINUATION_GRACE_MS + 1_000)

      expect(inputEnded).toBe(false)
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

  it('force-ends the session through the watchdog when a subagent never reports a terminal notification', async () => {
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
      // as watchdog, not 'completed', so auto-loop/UI don't mistake a
      // possibly-still-running orphaned subagent for successful progress.
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
  describe('one sub-agent task reported under two identities', () => {
    async function expectTurnCompletesAfterCompletion(): Promise<void> {
      const events: AgentEvent[] = []
      await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
      const input = sdkInput[Symbol.asyncIterator]()
      await input.next() // The SDK consumes the initial prompt.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(events).not.toContainEqual({ kind: 'turn:completed' })

      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)

      expect(events).toContainEqual({ kind: 'turn:completed' })
      expect((await input.next()).done).toBe(true)
    }

    it('completes the turn when a relaunched task reports only task_id and settles under its tool_use_id (LFB)', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task('task_started', { task_id: 'a3120df306c4d4dff', tool_use_id: 'toolu_01Uq' }),
          task(
            'task_notification',
            { task_id: 'a3120df306c4d4dff', tool_use_id: 'toolu_01Uq' },
            { status: 'completed' },
          ),
          task('task_started', { task_id: 'a3120df306c4d4dff' }),
          task('task_progress', { task_id: 'a3120df306c4d4dff' }),
        ]
        completionMessages = [
          task(
            'task_notification',
            { task_id: 'a3120df306c4d4dff', tool_use_id: 'toolu_01Uq' },
            { status: 'completed' },
          ),
        ]
        await expectTurnCompletesAfterCompletion()
      } finally {
        completeSubagent?.()
        await vi.advanceTimersByTimeAsync(0)
        releaseStream?.()
        resetControls()
        vi.useRealTimers()
      }
    })

    it('completes the turn when the tool_use_id is only learned after the task started', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task('task_started', { task_id: 'a2e2521a7702cfcb2' }),
          task('task_progress', { task_id: 'a2e2521a7702cfcb2', tool_use_id: 'toolu_018GKFbCya6LHDwqWZShKgQ1' }),
        ]
        completionMessages = [
          task(
            'task_notification',
            { task_id: 'a2e2521a7702cfcb2', tool_use_id: 'toolu_018GKFbCya6LHDwqWZShKgQ1' },
            { status: 'stopped' },
          ),
        ]
        await expectTurnCompletesAfterCompletion()
      } finally {
        completeSubagent?.()
        await vi.advanceTimersByTimeAsync(0)
        releaseStream?.()
        resetControls()
        vi.useRealTimers()
      }
    })

    it('completes the turn when the terminal notification carries only task_id', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task('task_started', { task_id: 'a2e2521a7702cfcb2', tool_use_id: 'toolu_018GKFbCya6LHDwqWZShKgQ1' }),
        ]
        completionMessages = [task('task_notification', { task_id: 'a2e2521a7702cfcb2' }, { status: 'stopped' })]
        await expectTurnCompletesAfterCompletion()
      } finally {
        completeSubagent?.()
        await vi.advanceTimersByTimeAsync(0)
        releaseStream?.()
        resetControls()
        vi.useRealTimers()
      }
    })

    it('interrupt() stops a task seen under two identities once, with its SDK task id', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task('task_started', { task_id: 'a2e2521a7702cfcb2' }),
          task('task_progress', { task_id: 'a2e2521a7702cfcb2', tool_use_id: 'toolu_018GKFbCya6LHDwqWZShKgQ1' }),
        ]
        const process = await createClaudeCodeEngine().start(BASE_OPTIONS, () => {})
        await vi.advanceTimersByTimeAsync(1_000)
        process.interrupt()

        expect(stopTaskMock.mock.calls).toEqual([['a2e2521a7702cfcb2']])
      } finally {
        completeSubagent?.()
        await vi.advanceTimersByTimeAsync(0)
        releaseStream?.()
        resetControls()
        vi.useRealTimers()
      }
    })
  })

  describe('sub-agent lifecycle classification', () => {
    const cleanup = async (): Promise<void> => {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }

    it('does not let an ambient task (Monitor) block turn:completed nor arm the stall watchdog', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task(
            'task_started',
            { task_id: 'mon-1', tool_use_id: 'toolu_mon' },
            { description: 'Wait for the new CI/CD Pipeline run', ambient: true, skip_transcript: true },
          ),
          // task_progress carries no ambient field: the classification must stick.
          task('task_progress', { task_id: 'mon-1' }),
        ]
        const events: AgentEvent[] = []
        const process = await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
        const input = sdkInput[Symbol.asyncIterator]()
        await input.next()
        await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)

        expect(events).toContainEqual({ kind: 'turn:completed' })
        expect(events).toContainEqual(expect.objectContaining({ kind: 'subagent:progress', ambient: true }))
        // Not waiting on background work (the state that arms the stall
        // watchdog): a wakeup is not routed to this stream and the SDK input
        // is closed, as for a turn without any sub-agent.
        expect(process.sendWakeupIfWaiting?.('wake')).toBe(false)
        expect((await input.next()).done).toBe(true)
      } finally {
        await cleanup()
      }
    })

    it('interrupt() still stops an ambient task through the SDK', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [task('task_started', { task_id: 'mon-1', tool_use_id: 'toolu_mon' }, { ambient: true })]
        const process = await createClaudeCodeEngine().start(BASE_OPTIONS, () => {})
        await vi.advanceTimersByTimeAsync(1_000)
        process.interrupt()

        expect(stopTaskMock.mock.calls).toEqual([['mon-1']])
      } finally {
        await cleanup()
      }
    })

    it.each([
      ['task_notification failed', task('task_notification', { task_id: 'task-review-1' }, { status: 'failed' })],
      ['task_notification stopped', task('task_notification', { task_id: 'task-review-1' }, { status: 'stopped' })],
      ['task_updated killed', task('task_updated', { task_id: 'task-review-1' }, { patch: { status: 'killed' } })],
      ['task_updated failed', task('task_updated', { task_id: 'task-review-1' }, { patch: { status: 'failed' } })],
    ])('clears the active entry on %s and completes the turn', async (_label, terminal) => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        completionMessages = [terminal]
        const events: AgentEvent[] = []
        await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
        const input = sdkInput[Symbol.asyncIterator]()
        await input.next()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(events).not.toContainEqual({ kind: 'turn:completed' })

        completeSubagent?.()
        await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)

        expect(events).toContainEqual({ kind: 'turn:completed' })
        expect((await input.next()).done).toBe(true)
      } finally {
        await cleanup()
      }
    })

    it('ignores a late task_progress after the terminal notification instead of reviving the task', async () => {
      vi.useFakeTimers()
      try {
        emitSubagentStarted = true
        startedMessages = [
          task('task_started', { task_id: 'task-late', tool_use_id: 'toolu_late' }),
          task('task_notification', { task_id: 'task-late', tool_use_id: 'toolu_late' }, { status: 'completed' }),
          task('task_progress', { task_id: 'task-late', tool_use_id: 'toolu_late' }),
        ]
        const events: AgentEvent[] = []
        await createClaudeCodeEngine().start(BASE_OPTIONS, (event) => events.push(event))
        const input = sdkInput[Symbol.asyncIterator]()
        await input.next()
        await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)

        expect(events).toContainEqual({ kind: 'turn:completed' })
      } finally {
        await cleanup()
      }
    })
  })

  describe('stopSubagents()', () => {
    const cleanup = async (): Promise<void> => {
      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      resetControls()
      vi.useRealTimers()
    }

    async function startWith(messages: Record<string, unknown>[]) {
      emitSubagentStarted = true
      startedMessages = messages
      const process = await createClaudeCodeEngine().start(BASE_OPTIONS, () => {})
      await vi.advanceTimersByTimeAsync(1_000)
      return process
    }

    it('resolves a tool call id to the SDK task id and stops it once, without interrupting the turn', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([task('task_started', { task_id: 'task-a', tool_use_id: 'toolu_a' })])

        expect(process.stopSubagents?.(['toolu_a'])).toBe(1)
        expect(stopTaskMock.mock.calls).toEqual([['task-a']])
        expect(abortSignal?.aborted).toBe(false)
      } finally {
        await cleanup()
      }
    })

    it('accepts the SDK task id directly', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([task('task_started', { task_id: 'task-a', tool_use_id: 'toolu_a' })])

        expect(process.stopSubagents?.(['task-a'])).toBe(1)
        expect(stopTaskMock.mock.calls).toEqual([['task-a']])
      } finally {
        await cleanup()
      }
    })

    it('stops the same task once when both of its ids are given', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([task('task_started', { task_id: 'task-a', tool_use_id: 'toolu_a' })])

        expect(process.stopSubagents?.(['task-a', 'toolu_a'])).toBe(1)
        expect(stopTaskMock.mock.calls).toEqual([['task-a']])
      } finally {
        await cleanup()
      }
    })

    it('stops every tracked running task, ambient included, when no id is given', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([
          task('task_started', { task_id: 'task-a', tool_use_id: 'toolu_a' }),
          task('task_started', { task_id: 'task-b', tool_use_id: 'toolu_b' }),
          task('task_started', { task_id: 'mon-1', tool_use_id: 'toolu_mon' }, { ambient: true }),
          task('task_started', { task_id: 'task-done', tool_use_id: 'toolu_done' }),
          task('task_notification', { task_id: 'task-done' }, { status: 'completed' }),
        ])

        expect(process.stopSubagents?.()).toBe(3)
        expect(stopTaskMock.mock.calls.map(([id]) => id).sort()).toEqual(['mon-1', 'task-a', 'task-b'])
        expect(abortSignal?.aborted).toBe(false)
      } finally {
        await cleanup()
      }
    })

    it('returns 0 and calls nothing for an unknown or finished id', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([
          task('task_started', { task_id: 'task-done', tool_use_id: 'toolu_done' }),
          task('task_notification', { task_id: 'task-done' }, { status: 'completed' }),
        ])

        expect(process.stopSubagents?.(['nope'])).toBe(0)
        expect(process.stopSubagents?.(['toolu_done'])).toBe(0)
        expect(stopTaskMock).not.toHaveBeenCalled()
      } finally {
        await cleanup()
      }
    })

    it('swallows a stopTask failure', async () => {
      vi.useFakeTimers()
      try {
        const process = await startWith([task('task_started', { task_id: 'task-a', tool_use_id: 'toolu_a' })])
        stopTaskMock.mockRejectedValueOnce(new Error('boom'))

        expect(process.stopSubagents?.(['task-a'])).toBe(1)
        await vi.advanceTimersByTimeAsync(0)
      } finally {
        await cleanup()
      }
    })
  })
})
