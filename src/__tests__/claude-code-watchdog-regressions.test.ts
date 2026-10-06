import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent, EngineProcess } from '../server/services/agent/engines/types.js'

let input: AsyncIterator<SDKUserMessage>
let deliver: (message: Record<string, unknown>) => void
let end: () => void
let requestPermission: (signal: AbortSignal) => Promise<unknown>
let process: EngineProcess
let events: AgentEvent[]
let ignoreAbort = false
const close = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args) => {
    input = args.prompt[Symbol.asyncIterator]()
    requestPermission = (signal) => args.options.canUseTool('AskUserQuestion', {}, { signal, toolUseID: 'question' })
    const messages: Array<Record<string, unknown>> = []
    let wake: (() => void) | undefined
    let ended = false
    end = () => {
      ended = true
      wake?.()
    }
    deliver = (message) => {
      messages.push(message)
      wake?.()
    }
    close.mockImplementation(end)
    args.options.abortController.signal.addEventListener('abort', () => {
      if (!ignoreAbort) end()
    })
    return {
      close,
      stopTask: vi.fn(async () => {}),
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'watchdog-test', model: 'm' }
        while (!ended) {
          const message = messages.shift()
          if (message) yield message
          else
            await new Promise<void>((resolve) => {
              wake = resolve
            })
        }
      },
    }
  }),
}))

import {
  CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  CLAUDE_TOOL_IDLE_TIMEOUT_MS,
  COMPACTION_STALL_TIMEOUT_MS,
  createClaudeCodeEngine,
  RESULT_CONTINUATION_GRACE_MS,
  RESULT_DRAIN_TIMEOUT_MS,
  SUBAGENT_STALL_TIMEOUT_MS,
} from '../server/services/agent/engines/claude-code/engine.js'

afterEach(async () => {
  end?.()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  ignoreAbort = false
  close.mockClear()
})

async function start() {
  vi.useFakeTimers()
  events = []
  process = await createClaudeCodeEngine().start(
    {
      workspaceId: 'watchdog-regression',
      workingDir: '/tmp',
      prompt: 'first',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: {} as never,
    },
    (event) => events.push(event),
  )
  const first = (await input.next()).value as SDKUserMessage
  await vi.advanceTimersByTimeAsync(0)
  return first.uuid!
}

async function emit(message: Record<string, unknown>) {
  deliver(message)
  await vi.advanceTimersByTimeAsync(0)
}

async function result(ids: string[]) {
  await emit({ type: 'result', subtype: 'success', user_message_uuids: ids, user_message_uuid: ids[0] })
}

it('keeps the drain deadline after trailing metadata', async () => {
  await result([await start()])
  close.mockImplementation(() => {}) // A genuinely stuck transport, not normal SDK idle waiting.
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  await emit({ type: 'system', subtype: 'stop_hook_summary' })
  await vi.advanceTimersByTimeAsync(RESULT_DRAIN_TIMEOUT_MS)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'result_drain_timeout' }))
})

it('closes a settled SDK query proactively and reports completion only after it closes', async () => {
  await result([await start()])
  close.mockImplementation(() => {})
  let closed = false
  void process.closed?.then(() => {
    closed = true
  })
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(close).toHaveBeenCalledOnce()
  expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
  expect(closed).toBe(false)
  end()
  await process.closed
  expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(events.some((event) => event.kind === 'error')).toBe(false)
})

it('does not classify successful SDK cleanup as a watchdog failure', async () => {
  await result([await start()])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + RESULT_DRAIN_TIMEOUT_MS)
  expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(events.some((event) => event.kind === 'error')).toBe(false)
})

it('does not let child output cancel the parent completion grace', async () => {
  await result([await start()])
  await emit({
    type: 'assistant',
    parent_tool_use_id: 'old-child',
    message: {
      id: 'child',
      content: [{ type: 'text', text: 'late child output' }],
    },
  })
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).toContainEqual({ kind: 'turn:completed' })
})

it('resumes the idle deadline when the SDK cancels its question', async () => {
  await start()
  const controller = new AbortController()
  const pending = requestPermission(controller.signal).catch(() => {})
  controller.abort()
  await pending
  await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'stream_idle_timeout' }))
})

it('never credits a future prompt with an uncorrelated extra result', async () => {
  await result([await start()])
  await emit({ type: 'result', subtype: 'success' })
  process.sendMessage('new prompt')
  await input.next()
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
})

it('bounds unacknowledged inputs to the SDK 64-id result window without dropping the next input', async () => {
  const ids = [await start()]
  for (let i = 1; i < 64; i++) {
    process.sendMessage(`prompt ${i}`)
    ids.push((await input.next()).value!.uuid!)
  }
  process.sendMessage('prompt 65')
  let nextDelivered = false
  const next = input.next().then((value) => {
    nextDelivered = true
    return value
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(nextDelivered).toBe(false)
  await result(ids)
  const last = (await next).value!
  expect(last.message.content).toBe('prompt 65')
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
  await result([last.uuid!])
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).toContainEqual({ kind: 'turn:completed' })
})

it('restores the short deadline when a result clears a missing tool result', async () => {
  const first = await start()
  await emit({
    type: 'assistant',
    message: { id: 'tool', content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'long task' } }] },
  })
  process.sendMessage('next prompt')
  await input.next()
  await result([first])
  await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'stream_idle_timeout' }))
})

it('does not extend a compaction deadline on repeated compacting statuses', async () => {
  await start()
  await emit({ type: 'system', subtype: 'status', status: 'compacting' })
  await vi.advanceTimersByTimeAsync(COMPACTION_STALL_TIMEOUT_MS - 1)
  await emit({ type: 'system', subtype: 'status', status: 'compacting' })
  await vi.advanceTimersByTimeAsync(1)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'compaction_stall_timeout' }))
})

it('does not close input during a compaction following a result', async () => {
  await result([await start()])
  await emit({ type: 'system', subtype: 'status', status: 'compacting' })
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).not.toContainEqual({ kind: 'turn:completed' })
  await emit({ type: 'system', subtype: 'status', status: null })
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS)
  expect(events).toContainEqual({ kind: 'turn:completed' })
})

it('actively closes the SDK transport when abort alone is ignored', async () => {
  ignoreAbort = true
  await start()
  await vi.advanceTimersByTimeAsync(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
  expect(close).toHaveBeenCalledOnce()
  await process.closed
  expect(process.isAlive?.()).toBe(false)
})

it.each(['local_bash', 'local_workflow', 'mcp_task'])(
  'gives background %s jobs the tool deadline, not the agent deadline',
  async (taskType) => {
    const id = await start()
    await emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'job',
      tool_use_id: 'job-tool',
      task_type: taskType,
    })
    await result([id])
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + 1)
    expect(events.some((event) => event.kind === 'session:ended')).toBe(false)
    await vi.advanceTimersByTimeAsync(CLAUDE_TOOL_IDLE_TIMEOUT_MS - SUBAGENT_STALL_TIMEOUT_MS)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'background_task_stall_timeout' }))
  },
)

it('does not extend a real agent deadline merely because a background shell is also running', async () => {
  await start()
  await emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'job',
    tool_use_id: 'job-tool',
    task_type: 'local_bash',
  })
  await emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent',
    tool_use_id: 'agent-tool',
    task_type: 'local_agent',
  })
  await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'subagent_stall_timeout' }))
})

it('does not let repeated neutral status notifications postpone completion', async () => {
  await result([await start()])
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(1000)
    await emit({ type: 'system', subtype: 'status', status: null })
  }
  expect(events).toContainEqual({ kind: 'turn:completed' })
})
