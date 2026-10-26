import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), groupIsLive: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}))
vi.mock('../../server/utils/bounded-process.js', async (original) => ({
  ...(await original<typeof import('../../server/utils/bounded-process.js')>()),
  groupIsLive: mocks.groupIsLive,
}))

import {
  closeVibeAcpSession,
  connectVibeAcp,
  requestVibeAcp,
} from '../../server/services/agent/engines/mistral-vibe/client.js'
import { spawnVibeAcp } from '../../server/services/agent/engines/mistral-vibe/spawn.js'

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
}
beforeEach(() => {
  mocks.spawn.mockReset()
  mocks.groupIsLive.mockReset().mockResolvedValue(false)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Vibe runtime ownership', () => {
  it('spawns PATH-resolved vibe-acp directly with inherited cwd/env and separate streams', async () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    const env = { ...process.env, KOBO_FAKE_MARKER: 'inherited' }
    const runtime = spawnVibeAcp({ cwd: '/tmp', env })
    expect(mocks.spawn).toHaveBeenCalledWith('vibe-acp', [], {
      cwd: '/tmp',
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.emit('close', 0, null)
    await runtime.closed
  })

  it('stops before initialize, drains stdout and shares repeated stop calls', async () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    const stopped = runtime.stop()
    expect(runtime.stop()).toBe(stopped)
    await Promise.resolve()
    expect(child.stdin.writableEnded).toBe(true)
    child.emit('close', 0, null)
    await stopped
  })

  it('retains ownership while a descendant is live or inspection fails', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    mocks.groupIsLive
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('secret-token'))
      .mockResolvedValue(false)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    let closed = false
    void runtime.closed.then(() => {
      closed = true
    })
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(closed).toBe(false)
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-token')
    await vi.advanceTimersByTimeAsync(250)
    await runtime.closed
  })

  it('settles stop if native exit races a stalled close callback', async () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    const stopped = runtime.stop(() => new Promise(() => {}))
    child.emit('close', 0, null)
    await stopped
    await runtime.closed
  })

  it.each(['ESRCH', 'EPERM', 'delivered'])(
    'classifies a deadline signal racing clean exit and pending inspection: %s',
    async (outcome) => {
      vi.useFakeTimers()
      const child = fakeChild()
      mocks.spawn.mockReturnValue(child)
      let finishInspection!: (live: boolean) => void
      mocks.groupIsLive.mockReturnValue(
        new Promise<boolean>((resolve) => {
          finishInspection = resolve
        }),
      )
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (outcome !== 'delivered') throw Object.assign(new Error('signal failed'), { code: outcome })
        return true
      })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
      const stopped = runtime.stop()
      const checked = outcome === 'ESRCH' ? stopped : expect(stopped).rejects.toThrow('retaining runtime ownership')
      let closed = false
      void runtime.closed.then(() => {
        closed = true
      })
      await vi.advanceTimersByTimeAsync(14900)
      child.emit('close', 0, null)
      expect(mocks.groupIsLive).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
      finishInspection(false)
      await checked
      expect(closed).toBe(outcome === 'ESRCH')
      await vi.advanceTimersByTimeAsync(10000)
      expect(kill).toHaveBeenCalledTimes(1)
    },
  )

  it('bounds a stalled native close, then allows fifteen seconds of EOF cleanup before TERM/KILL', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    mocks.groupIsLive.mockResolvedValue(true)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    const stopped = runtime.stop(() => new Promise(() => {}))
    const checked = expect(stopped).rejects.toThrow('retaining runtime ownership')
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.stdin.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(14999)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(5000)
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    child.stderr.write('secret-token-123')
    mocks.groupIsLive.mockResolvedValue(false)
    child.emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(5000)
    await checked
    let closed = false
    void runtime.closed.then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret-token')
  })

  it('does not release ownership after abnormal native exit', async () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    child.emit('close', 1, null)
    await expect(runtime.stop()).rejects.toThrow('retaining runtime ownership')
  })

  it('keeps stderr diagnostics bounded and never forwards native secrets', async () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    spawnVibeAcp({ cwd: '/tmp', env: {} })
    child.stderr.write('secret-token'.repeat(100000))
    child.emit('close', 1, null)
    await Promise.resolve()
    expect(log).toHaveBeenCalledTimes(1)
    const message = log.mock.calls.flat().join(' ')
    expect(message.length).toBeLessThan(250)
    expect(message).not.toContain('secret-token')
  })

  it('cleans up a real pending peer through cancel, close ACK, EOF and actual exit', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const bounded = await vi.importActual<typeof import('../../server/utils/bounded-process.js')>(
      '../../server/utils/bounded-process.js',
    )
    mocks.groupIsLive.mockImplementation(bounded.groupIsLive)
    mocks.spawn.mockImplementation((_command, _args, options) =>
      actual.spawn(
        process.execPath,
        [fileURLToPath(new URL('../fixtures/mistral-acp/fake-agent.mjs', import.meta.url)), 'pending'],
        options,
      ),
    )
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: process.env })
    try {
      await once(runtime.child.stderr!, 'data')
      const connection = connectVibeAcp(runtime.child, {})
      const prompt = requestVibeAcp(connection, 'session/prompt', { sessionId: 'fixture-session', prompt: [] })
      let closed = false
      void runtime.closed.then(() => {
        closed = true
      })
      await runtime.stop(async () => {
        await closeVibeAcpSession(connection, { sessionId: 'fixture-session', active: true, canClose: true })
        expect(closed).toBe(false)
        expect(runtime.child.exitCode).toBe(null)
      })
      expect(await prompt).toEqual({ stopReason: 'cancelled' })
      expect(runtime.child.exitCode).toBe(0)
      expect(closed).toBe(true)
      await connection.closed
    } finally {
      try {
        process.kill(-runtime.child.pid!, 'SIGKILL')
      } catch {}
    }
  })

  it.each([false, true])('reports sanitized spawn failure with immediate stop=%s', async (immediate) => {
    const child = fakeChild()
    Object.assign(child, { pid: undefined })
    mocks.spawn.mockReturnValue(child)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: {} })
    const stopped = immediate ? runtime.stop() : undefined
    child.emit('error', Object.assign(new Error('secret-token'), { code: 'ENOENT' }))
    await runtime.closed
    await expect(stopped ?? runtime.stop()).rejects.toThrow('not found on PATH')
  })

  it('waits for a real Unix group descendant after parent close', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const bounded = await vi.importActual<typeof import('../../server/utils/bounded-process.js')>(
      '../../server/utils/bounded-process.js',
    )
    mocks.groupIsLive.mockImplementation(bounded.groupIsLive)
    mocks.spawn.mockImplementation((_command, _args, options) =>
      actual.spawn(
        process.execPath,
        [fileURLToPath(new URL('../fixtures/mistral-acp/fake-agent.mjs', import.meta.url)), 'descendant'],
        options,
      ),
    )
    const runtime = spawnVibeAcp({ cwd: '/tmp', env: process.env })
    try {
      await once(runtime.child.stderr!, 'data')
      const exited = once(runtime.child, 'close')
      runtime.child.stdin!.end()
      await exited
      let closed = false
      void runtime.closed.then(() => {
        closed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(closed).toBe(false)
      process.kill(-runtime.child.pid!, 'SIGKILL')
      await runtime.closed
    } finally {
      try {
        process.kill(-runtime.child.pid!, 'SIGKILL')
      } catch {}
    }
  })
})
