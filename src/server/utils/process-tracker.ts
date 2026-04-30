import type { ChildProcess } from 'node:child_process'

/** In-memory map of workspace-id to spawned child process. */
const trackedProcesses = new Map<string, ChildProcess>()

/** Register a child process under the given workspace id. */
export function registerProcess(id: string, proc: ChildProcess): void {
  trackedProcesses.set(id, proc)
}

/** Remove a child process from tracking without killing it. */
export function unregisterProcess(id: string): void {
  trackedProcesses.delete(id)
}

/** Retrieve the tracked child process for a workspace, if any. */
export function getProcess(id: string): ChildProcess | undefined {
  return trackedProcesses.get(id)
}

/** Return the number of currently tracked processes. */
export function getTrackedCount(): number {
  return trackedProcesses.size
}

/** Send SIGTERM to all tracked processes, escalating to SIGKILL after 5 seconds. */
export function killAll(): void {
  const procs = [...trackedProcesses.values()]
  trackedProcesses.clear()

  const killTimers = procs.map((proc) => {
    try {
      proc.kill('SIGTERM')
    } catch {
      // Process may already be dead
    }

    return setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL')
        }
      } catch {
        // Ignore
      }
    }, 5000)
  })

  // Unref timers so they don't keep the process alive
  killTimers.forEach((t) => {
    t.unref?.()
  })
}

/** Register a process-exit handler that kills all tracked child processes. */
export function initProcessCleanup(): void {
  process.on('exit', killAll)
}
