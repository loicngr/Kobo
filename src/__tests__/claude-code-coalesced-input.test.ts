import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../server/services/agent/engines/types.js'

let input: AsyncIterator<SDKUserMessage>
let emitResult: (ids: string[]) => void
let finish: () => void
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<SDKUserMessage>; options: { abortController: AbortController } }) => {
    input = args.prompt[Symbol.asyncIterator]()
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'coalesced', model: 'm' }
        const ids = await new Promise<string[]>((resolve) => {
          emitResult = resolve
        })
        yield { type: 'result', subtype: 'success', user_message_uuids: ids, user_message_uuid: ids[0] }
        await new Promise<void>((resolve) => {
          finish = resolve
          args.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
  }),
}))

import {
  createClaudeCodeEngine,
  RESULT_CONTINUATION_GRACE_MS,
} from '../server/services/agent/engines/claude-code/engine.js'

afterEach(async () => {
  finish?.()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

async function start() {
  vi.useFakeTimers()
  const events: AgentEvent[] = []
  const process = await createClaudeCodeEngine().start(
    {
      workspaceId: 'coalesced',
      workingDir: '/tmp',
      prompt: 'initial',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: { dangerouslySkipPermissions: true } as any,
    },
    (event) => events.push(event),
  )
  const first = (await input.next()).value as SDKUserMessage
  process.sendMessage('additional instruction')
  const second = (await input.next()).value as SDKUserMessage
  await vi.advanceTimersByTimeAsync(0)
  return { process, events, first, second }
}

it('settles two consumed prompts covered by a single result', async () => {
  const { events, first, second } = await start()
  expect(first.uuid).toEqual(expect.any(String))
  expect(second.uuid).not.toBe(first.uuid)
  emitResult([first.uuid!, second.uuid!])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).toContainEqual({ kind: 'turn:completed' })
  finish()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(events.some((event) => event.kind === 'error')).toBe(false)
})

it('does not settle a late prompt absent from the result', async () => {
  const { events, first } = await start()
  emitResult([first.uuid!])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
  expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
})

it('does not let a result from an old turn acknowledge new prompts', async () => {
  const { events } = await start()
  emitResult(['old-prompt'])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
})

it('keeps an input still queued locally pending even when all yielded inputs are covered', async () => {
  const { events, process, first, second } = await start()
  process.sendMessage('not consumed yet')
  emitResult([first.uuid!, second.uuid!])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
  expect((await input.next()).value).toMatchObject({ message: { content: 'not consumed yet' } })
})
