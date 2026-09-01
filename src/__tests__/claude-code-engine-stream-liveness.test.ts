import { describe, expect, it, vi } from 'vitest'

let abortSignal: AbortSignal | undefined
let releaseStream: (() => void) | undefined
let emitCompactingStatus = false

// The SDK yields an init message and one assistant message that carries a
// TOOL CALL — the majority shape — then parks forever. No `result` ever
// arrives: this is a mid-tool-call freeze (half-closed connection, stuck MCP).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { abortController?: AbortController } }) => {
    abortSignal = args.options.abortController?.signal
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-live', model: 'm', slash_commands: [] }
        if (emitCompactingStatus) {
          yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-live' }
        }
        yield {
          type: 'assistant',
          message: {
            id: 'msg-tool-1',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 999' } }],
            stop_reason: 'tool_use',
          },
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
          abortSignal?.addEventListener('abort', resolve, { once: true })
        })
      },
      stopTask: async () => {},
    }
  }),
}))

import {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  createClaudeCodeEngine,
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

      await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)

      expect(events).toContainEqual({ kind: 'session:ended', reason: 'watchdog', exitCode: null })
      expect(abortSignal?.aborted).toBe(true)
    } finally {
      releaseStream?.()
      releaseStream = undefined
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
})
