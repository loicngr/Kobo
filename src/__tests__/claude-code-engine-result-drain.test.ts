import { describe, expect, it, vi } from 'vitest'

let abortSignal: AbortSignal | undefined
let emitSubagentStarted = false
let completeSubagent: (() => void) | undefined
let releaseStream: (() => void) | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { abortController?: AbortController } }) => {
    abortSignal = args.options.abortController?.signal
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-drain', model: 'm', slash_commands: [] }
        if (emitSubagentStarted) {
          yield {
            type: 'system',
            subtype: 'task_started',
            tool_use_id: 'review-1',
            description: 'Full PR review',
          }
        }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        if (emitSubagentStarted) {
          await new Promise<void>((resolve) => {
            completeSubagent = resolve
          })
          yield {
            type: 'system',
            subtype: 'task_notification',
            tool_use_id: 'review-1',
            status: 'completed',
          }
          yield { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 2 } }
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          abortSignal?.addEventListener('abort', resolve, { once: true })
        })
      },
    }
  }),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

describe('claude-code engine — result drain watchdog', () => {
  it('aborts a stuck SDK stream with no background subagent', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = false
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(
        {
          workspaceId: 'w-drain',
          workingDir: '/tmp',
          prompt: 'go',
          backendUrl: 'http://localhost:3000',
          koboHome: '/tmp/kobo',
          settings: { dangerouslySkipPermissions: true } as any,
        },
        (event) => events.push(event),
      )

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      releaseStream?.()
      releaseStream = undefined
      vi.useRealTimers()
    }
  })

  it('keeps the SDK stream attached through the background continuation, then drains it', async () => {
    vi.useFakeTimers()
    try {
      emitSubagentStarted = true
      const events: AgentEvent[] = []
      const engine = createClaudeCodeEngine()
      await engine.start(
        {
          workspaceId: 'w-background',
          workingDir: '/tmp',
          prompt: 'go',
          backendUrl: 'http://localhost:3000',
          koboHome: '/tmp/kobo',
          settings: { dangerouslySkipPermissions: true } as any,
        },
        (event) => events.push(event),
      )

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).not.toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(false)

      completeSubagent?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(events).not.toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(15_000)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      completeSubagent?.()
      completeSubagent = undefined
      await vi.advanceTimersByTimeAsync(0)
      releaseStream?.()
      releaseStream = undefined
      emitSubagentStarted = false
      vi.useRealTimers()
    }
  })
})
