import { afterEach, expect, it, vi } from 'vitest'
import type { EngineProcess } from '../server/services/agent/engines/types.js'

let sdkInput: AsyncIterable<{ uuid: string }>
let nextMessage: ((message: Record<string, unknown> | null) => void) | undefined
let process: EngineProcess | undefined
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<{ uuid: string }> }) => {
    sdkInput = args.prompt
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'native', model: 'm', slash_commands: [] }
        while (true) {
          const message = await new Promise<Record<string, unknown> | null>((resolve) => {
            nextMessage = resolve
          })
          if (!message) return
          yield message
        }
      },
      interrupt: vi.fn(),
      close: () => nextMessage?.(null),
    }
  }),
}))

import { createClaudeCodeEngine } from '../server/services/agent/engines/claude-code/engine.js'

async function start() {
  process = await createClaudeCodeEngine().start(
    {
      workspaceId: 'receipt',
      workingDir: '/tmp',
      prompt: 'Original report',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: {} as never,
    },
    () => {},
  )
  await process.ready
  let accepted = false
  void process.initialPromptAccepted?.then(
    () => {
      accepted = true
    },
    () => {},
  )
  const input = sdkInput[Symbol.asyncIterator]()
  const initial = (await input.next()).value!
  return { initial, input, accepted: () => accepted }
}
async function send(message: Record<string, unknown>) {
  nextMessage!(message)
  await new Promise((resolve) => setImmediate(resolve))
}
afterEach(async () => {
  nextMessage?.(null)
  await process?.closed
})

it('does not treat initialization or yielding the initial input as proof of consumption', async () => {
  const f = await start()
  expect(process!.initialPromptAccepted).toBeInstanceOf(Promise)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.accepted()).toBe(false)
})

it.each(['assistant', 'stream_event', 'result'])(
  'acknowledges only the initial foreground UUID in %s',
  async (type) => {
    const f = await start()
    const content =
      type === 'assistant'
        ? { message: { id: 'msg', content: [{ type: 'text', text: 'Report received' }], stop_reason: null } }
        : type === 'stream_event'
          ? { event: { type: 'message_start', message: { id: 'stream' } } }
          : { subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
    await send({ type, ...content, parent_tool_use_id: null, user_message_uuid: 'unrelated' })
    expect(f.accepted()).toBe(false)
    await send({ type, ...content, parent_tool_use_id: 'subagent', user_message_uuid: f.initial.uuid })
    expect(f.accepted()).toBe(false)
    await send({ type, ...content, parent_tool_use_id: null, user_message_uuids: ['other', f.initial.uuid] })
    expect(f.accepted()).toBe(true)
  },
)
