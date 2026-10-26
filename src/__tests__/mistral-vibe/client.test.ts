import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeVibeAcpSession,
  connectVibeAcp,
  requestVibeAcp,
} from '../../server/services/agent/engines/mistral-vibe/client.js'

const children: ChildProcessWithoutNullStreams[] = []
async function peer(scenario: string, handlers = {}) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../fixtures/mistral-acp/fake-agent.mjs', import.meta.url)),
    scenario,
  ])
  children.push(child)
  await once(child.stderr, 'data')
  return { child, connection: connectVibeAcp(child, handlers) }
}
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGKILL')
    await closed
  }
})

describe('Vibe fluent ACP transport', () => {
  it('routes replay and typed permission/question callbacks through the SDK', async () => {
    const updates: acp.SessionNotification[] = []
    const { child, connection } = await peer('callbacks', {
      sessionUpdate: ({ params }: acp.ClientNotificationContext<acp.SessionNotification>) => {
        updates.push(params)
      },
      requestPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
      createElicitation: () => ({ action: 'accept', content: { q0: 'answer' } }),
    })
    expect(
      await requestVibeAcp(connection, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
    ).toMatchObject({ protocolVersion: 1 })
    await requestVibeAcp(connection, 'session/load', { sessionId: 'fixture-session', cwd: '/tmp', mcpServers: [] })
    expect(updates).toHaveLength(1)
    expect(await requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] })).toEqual({
      stopReason: 'end_turn',
    })
    await closeVibeAcpSession(connection, { sessionId: 'fixture-session', active: false, canClose: true })
    expect(child.exitCode).toBe(null)
    child.stdin.end()
    await connection.closed
  })

  it.each([
    ['initialize-pending', 'initialize', 20000],
    ['setup-pending', 'session/new', 30000],
  ] as const)('bounds %s without applying the prompt deadline', async (scenario, method, deadline) => {
    const { connection } = await peer(scenario)
    vi.useFakeTimers()
    const pending =
      method === 'initialize'
        ? requestVibeAcp(connection, method, { protocolVersion: 1 })
        : requestVibeAcp(connection, method, { cwd: '/tmp', mcpServers: [] })
    const checked = expect(pending).rejects.toThrow(`timed out after ${deadline}ms`)
    await vi.advanceTimersByTimeAsync(deadline)
    await checked
    // Keep stdout alive for the runtime's subsequent native EOF cleanup.
    expect(connection.signal.aborted).toBe(false)
  })

  it('keeps a prompt pending at 121 seconds and cancels it with a notification', async () => {
    const { connection } = await peer('pending')
    vi.useFakeTimers()
    const pending = requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] })
    let completed = false
    void pending.then(() => {
      completed = true
    })
    await vi.advanceTimersByTimeAsync(121000)
    expect(completed).toBe(false)
    await closeVibeAcpSession(connection, { sessionId: 'fixture-session', active: true, canClose: true })
    expect(await pending).toEqual({ stopReason: 'cancelled' })
  })

  it('rejects pending requests on actual EOF', async () => {
    const { connection } = await peer('eof')
    await expect(
      requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] }),
    ).rejects.toThrow()
    await connection.closed
  })

  it('recovers from malformed JSON as the SDK specifies', async () => {
    const { connection } = await peer('malformed')
    await expect(
      requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('leaves malformed notification logging and dropping to the unmodified SDK', async () => {
    const update = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { connection } = await peer('invalid-update', { sessionUpdate: update })
    await expect(
      requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] }),
    ).resolves.toEqual({ stopReason: 'end_turn' })
    expect(update).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it.each(['invalid-initialize', 'invalid-session', 'invalid-prompt'])(
    'validates consumed response fields despite unchecked fluent responses: %s',
    async (scenario) => {
      const { connection } = await peer(scenario)
      const pending =
        scenario === 'invalid-initialize'
          ? requestVibeAcp(connection, 'initialize', { protocolVersion: 1 })
          : scenario === 'invalid-session'
            ? requestVibeAcp(connection, 'session/new', { cwd: '/tmp', mcpServers: [] })
            : requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] })
      await expect(pending).rejects.toThrow('Invalid Vibe ACP')
    },
  )
})
