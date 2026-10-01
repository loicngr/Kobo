import os from 'node:os'
import type { IPty } from 'node-pty'
import { afterEach, describe, expect, it, vi } from 'vitest'

const processes = vi.hoisted(() => [] as Array<{ kill: ReturnType<typeof vi.fn>; exit: () => void }>)
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const process = { kill: vi.fn(), exit: () => {} }
    const terminal = {
      kill: process.kill,
      onExit: (callback: () => void) => {
        process.exit = callback
      },
    }
    processes.push(process)
    return terminal as unknown as IPty
  }),
}))
vi.mock('../server/utils/node-pty-spawn-helper.js', () => ({ ensureSpawnHelperExecutable: () => null }))

import { createTerminal, destroyTerminal, getTerminal } from '../server/services/terminal-service.js'

afterEach(() => {
  for (const process of processes) process.exit()
  processes.length = 0
  vi.useRealTimers()
})

describe('terminal ownership', () => {
  it('waits for exit before permitting replacement and protects it against a late old exit', async () => {
    createTerminal('replace', os.tmpdir())
    const old = processes[0]!
    const stopped = destroyTerminal('replace')
    expect(() => createTerminal('replace', os.tmpdir())).toThrow(/closing/i)
    old.exit()
    await stopped
    const replacement = createTerminal('replace', os.tmpdir())
    old.exit()
    expect(getTerminal('replace')).toBe(replacement)
  })

  it('does not report shutdown until the PTY confirms exit', async () => {
    createTerminal('waiting', os.tmpdir())
    let resolved = false
    const stopped = destroyTerminal('waiting').then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    processes[0]!.exit()
    await stopped
    expect(resolved).toBe(true)
    expect(getTerminal('waiting')).toBeNull()
  })

  it('retains ownership after a kill failure and allows an explicit retry', async () => {
    createTerminal('failed', os.tmpdir())
    const process = processes[0]!
    process.kill.mockImplementationOnce(() => {
      throw new Error('kill failed')
    })
    await expect(destroyTerminal('failed')).rejects.toThrow('kill failed')
    expect(() => createTerminal('failed', os.tmpdir())).toThrow(/closing/i)
    const retried = destroyTerminal('failed')
    process.exit()
    await retried
    expect(process.kill).toHaveBeenCalledTimes(2)
    expect(getTerminal('failed')).toBeNull()
  })

  it('bounds an unconfirmed stop without releasing ownership', async () => {
    vi.useFakeTimers()
    createTerminal('timeout', os.tmpdir())
    const stopped = destroyTerminal('timeout', 50)
    const rejection = expect(stopped).rejects.toThrow(/exit.*confirmed|confirm.*exit/i)
    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(() => createTerminal('timeout', os.tmpdir())).toThrow(/closing/i)
  })
})
