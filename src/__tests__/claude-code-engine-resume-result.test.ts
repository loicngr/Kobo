import { describe, expect, it, vi } from 'vitest'

let sdkInput: AsyncIterable<unknown>
let releaseStream: (() => void) | undefined
let continueAfterResult = true

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
    sdkInput = args.prompt
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-resume', model: 'm', slash_commands: [] }
        // Resuming a session killed mid-turn: the CLI first settles the
        // interrupted turn with an empty result, then runs the new prompt.
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } }
        if (continueAfterResult) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-resume', model: 'm', slash_commands: [] }
          yield {
            type: 'assistant',
            message: { id: 'msg-real', content: [{ type: 'text', text: 'working on the prompt' }], stop_reason: null },
          }
        }
        await new Promise<void>((resolve) => {
          releaseStream = resolve
        })
      },
      interrupt: vi.fn(),
    }
  }),
}))

import {
  createClaudeCodeEngine,
  RESULT_CONTINUATION_GRACE_MS,
} from '../server/services/agent/engines/claude-code/engine.js'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

let events: AgentEvent[] = []

async function startAndWatchInput(): Promise<() => boolean> {
  events = []
  await createClaudeCodeEngine().start(
    {
      workspaceId: 'w-resume',
      workingDir: '/tmp',
      prompt: 'go',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: {} as never,
    },
    (event) => events.push(event),
  )
  const input = sdkInput[Symbol.asyncIterator]()
  await input.next() // Initial prompt.
  let ended = false
  void input.next().then((next) => {
    ended = next.done === true
  })
  return () => ended
}

describe('claude-code engine - result followed by a continuation', () => {
  it('keeps the input open when the CLI keeps running after a result', async () => {
    // Regression: the empty result of a resumed interrupted turn closed stdin,
    // so every permission request of the real turn failed with "Stream closed".
    vi.useFakeTimers()
    try {
      continueAfterResult = true
      const inputEnded = await startAndWatchInput()
      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1_000)
      expect(inputEnded()).toBe(false)
      // The empty result must not report the turn as settled while the real
      // one runs: it hid the busy banner for the whole continuation.
      expect(events).not.toContainEqual({ kind: 'turn:completed' })
    } finally {
      releaseStream?.()
      vi.useRealTimers()
    }
  })

  it('still closes the input after the grace when nothing follows the result', async () => {
    vi.useFakeTimers()
    try {
      continueAfterResult = false
      const inputEnded = await startAndWatchInput()
      await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1_000)
      expect(inputEnded()).toBe(true)
      expect(events.filter((event) => event.kind === 'turn:completed')).toHaveLength(1)
    } finally {
      releaseStream?.()
      vi.useRealTimers()
    }
  })
})
