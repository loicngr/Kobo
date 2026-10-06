import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent, EngineProcess } from '../server/services/agent/engines/types.js'

// Exercise the real SDK's bidirectional waitForRunEnd, not a replacement Query.
// Only the subprocess is synthetic: no Claude binary, credentials or model call.
let child: FakeRuntime
let ignoreEof = false
class FakeRuntime extends EventEmitter implements SpawnedProcess {
  pid = 12345
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  stdinEnded = false
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line)
        if (message.type === 'control_request') {
          this.send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: message.request_id,
              response: { commands: [], models: [], account: {} },
            },
          })
        } else if (message.type === 'user') {
          this.send({ type: 'system', subtype: 'init', session_id: 'sdk-cleanup', model: 'm' })
          this.send({ type: 'system', subtype: 'session_state_changed', state: 'running' })
          this.send({
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 1,
            result: 'done',
            user_message_uuid: message.uuid,
            user_message_uuids: [message.uuid],
          })
          // Deliberately omit idle, reproducing the SDK's wait after result.
        }
      }
      done()
    },
    final: (done) => {
      this.stdinEnded = true
      done()
      if (!ignoreEof) this.exit()
    },
  })
  send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  kill() {
    if (this.killed) return true
    this.killed = true
    if (!ignoreEof) this.exit()
    return true
  }
  exit() {
    if (this.exitCode !== null) return
    this.exitCode = 0
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', 0, null)
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => {
      child = new FakeRuntime()
      return child
    },
  }
})

import {
  createClaudeCodeEngine,
  RESULT_CONTINUATION_GRACE_MS,
} from '../server/services/agent/engines/claude-code/engine.js'

let process: EngineProcess | undefined
afterEach(async () => {
  child?.exit()
  await process?.stop()
  vi.useRealTimers()
  ignoreEof = false
})

it('closes the real SDK after success even if the runtime never announces idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const events: AgentEvent[] = []
  process = await createClaudeCodeEngine().start(
    {
      workspaceId: 'sdk-cleanup',
      workingDir: '/tmp',
      prompt: 'test',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: {} as never,
    },
    (event) => events.push(event),
  )
  await process.ready
  await vi.advanceTimersByTimeAsync(0)
  expect(child.stdinEnded).toBe(false)
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 1000)
  expect(events).toContainEqual({ kind: 'turn:completed' })
  expect(child.stdinEnded).toBe(true)
  expect(child.exitCode).toBe(0)
  await process.closed
  expect(events).toContainEqual({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(events.some((event) => event.kind === 'error')).toBe(false)
})

it('retains ownership when SDK cleanup returns before its runtime exits', async () => {
  ignoreEof = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  process = await createClaudeCodeEngine().start(
    {
      workspaceId: 'sdk-cleanup',
      workingDir: '/tmp',
      prompt: 'test',
      backendUrl: 'http://localhost:3000',
      koboHome: '/tmp/kobo',
      settings: {} as never,
    },
    () => {},
  )
  await process.ready
  let closed = false
  void process.closed!.then(() => {
    closed = true
  })
  await vi.advanceTimersByTimeAsync(RESULT_CONTINUATION_GRACE_MS + 10_000)
  expect(child.stdinEnded).toBe(true)
  expect(closed).toBe(false)
  expect(process.isAlive!()).toBe(true)
  child.exit()
  await process.closed
  expect(process.isAlive!()).toBe(false)
})
