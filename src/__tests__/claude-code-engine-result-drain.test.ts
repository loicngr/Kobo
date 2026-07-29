import { describe, expect, it, vi } from 'vitest'

let abortSignal: AbortSignal | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: { abortController?: AbortController } }) => {
    abortSignal = args.options.abortController?.signal
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-drain', model: 'm', slash_commands: [] }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        await new Promise<void>((resolve) => abortSignal?.addEventListener('abort', resolve, { once: true }))
      },
    }
  }),
}))

vi.mock('../server/services/wakeup-service.js', () => ({
  isWakeupScheduled: vi.fn(() => true),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

describe('claude-code engine — result drain watchdog', () => {
  it('aborts a stuck SDK stream even when a wakeup is scheduled', async () => {
    vi.useFakeTimers()
    try {
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
      vi.useRealTimers()
    }
  })
})
