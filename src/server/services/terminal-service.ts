import fs from 'node:fs'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { ensureSpawnHelperExecutable } from '../utils/node-pty-spawn-helper.js'

interface TerminalInstance {
  pty: IPty
  closing: boolean
  closed: Promise<void>
  resolveClosed: () => void
  stop?: Promise<void>
}

export class TerminalStopError extends Error {}

const terminals = new Map<string, TerminalInstance>()
let spawnHelperChecked = false

function prepareSpawnHelper(): void {
  if (spawnHelperChecked) return
  spawnHelperChecked = true
  try {
    const fixed = ensureSpawnHelperExecutable()
    if (fixed) console.log(`[terminal] Made node-pty spawn-helper executable: ${fixed}`)
  } catch (err) {
    console.warn('[terminal] node-pty spawn-helper is not executable and could not be fixed (run chmod +x on it):', err)
  }
}

export function createTerminal(workspaceId: string, cwd: string): IPty {
  const existing = terminals.get(workspaceId)
  if (existing) {
    if (existing.closing)
      throw new TerminalStopError('Terminal is closing; wait for confirmed exit before reopening it')
    return existing.pty
  }

  if (!fs.existsSync(cwd)) {
    throw new Error(`Worktree directory does not exist: ${cwd}`)
  }

  prepareSpawnHelper()
  const shell = process.env.SHELL || '/bin/sh'
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  })

  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const instance: TerminalInstance = { pty: term, closing: false, closed, resolveClosed }
  terminals.set(workspaceId, instance)

  term.onExit(() => {
    if (terminals.get(workspaceId) === instance) terminals.delete(workspaceId)
    instance.resolveClosed()
  })

  return term
}

export function getTerminal(workspaceId: string): IPty | null {
  const instance = terminals.get(workspaceId)
  return instance && !instance.closing ? instance.pty : null
}

export function destroyTerminal(workspaceId: string, timeoutMs = 2000): Promise<void> {
  const instance = terminals.get(workspaceId)
  if (!instance) return Promise.resolve()
  if (instance.stop) return instance.stop
  instance.closing = true
  const stopped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TerminalStopError(`Terminal exit could not be confirmed for workspace ${workspaceId}`))
    }, timeoutMs)
    instance.closed.then(() => {
      clearTimeout(timer)
      resolve()
    })
    try {
      instance.pty.kill()
    } catch (err) {
      clearTimeout(timer)
      reject(new TerminalStopError(`Failed to stop terminal: ${err instanceof Error ? err.message : String(err)}`))
    }
  })
  instance.stop = stopped.catch((error: unknown) => {
    instance.stop = undefined
    throw error
  })
  return instance.stop
}

export async function destroyAllTerminals(): Promise<void> {
  const results = await Promise.allSettled([...terminals.keys()].map((id) => destroyTerminal(id)))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Some terminals did not stop',
    )
}
