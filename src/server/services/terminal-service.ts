import fs from 'node:fs'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'

interface TerminalInstance {
  pty: IPty
}

const terminals = new Map<string, TerminalInstance>()

export function createTerminal(workspaceId: string, cwd: string): IPty {
  if (terminals.has(workspaceId)) {
    return terminals.get(workspaceId)!.pty
  }

  if (!fs.existsSync(cwd)) {
    throw new Error(`Worktree directory does not exist: ${cwd}`)
  }

  const shell = process.env.SHELL || '/bin/sh'
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  })

  terminals.set(workspaceId, { pty: term })

  term.onExit(() => {
    terminals.delete(workspaceId)
  })

  return term
}

export function getTerminal(workspaceId: string): IPty | null {
  return terminals.get(workspaceId)?.pty ?? null
}

export function destroyTerminal(workspaceId: string): void {
  const instance = terminals.get(workspaceId)
  if (instance) {
    try {
      instance.pty.kill()
    } catch (err) {
      console.error(`[terminal] Failed to kill PTY for workspace ${workspaceId}:`, err)
    }
    terminals.delete(workspaceId)
  }
}

export function destroyAllTerminals(): void {
  for (const [id] of terminals) {
    destroyTerminal(id)
  }
}
