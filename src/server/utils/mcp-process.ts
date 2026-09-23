import type { ChildProcess } from 'node:child_process'

/** MCP commands run in their own process group, including wrapper descendants. */
export function stopMcpProcess(child: ChildProcess): void {
  child.stdin?.end()
  const pid = child.pid
  const signal = (value: NodeJS.Signals) => {
    try {
      if (pid && process.platform !== 'win32') process.kill(-pid, value)
      else child.kill(value)
    } catch {
      try {
        child.kill(value)
      } catch {
        /* Already gone. */
      }
    }
  }
  signal('SIGTERM')
  // Keep the group cleanup even when a wrapper exits before its descendants.
  const force = setTimeout(() => signal('SIGKILL'), 1000)
  force.unref()
}
