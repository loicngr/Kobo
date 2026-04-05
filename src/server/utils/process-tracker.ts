import type { ChildProcess } from 'node:child_process'

const trackedProcesses = new Map<string, ChildProcess>()

export function registerProcess(id: string, proc: ChildProcess): void {
  trackedProcesses.set(id, proc)
}

export function unregisterProcess(id: string): void {
  trackedProcesses.delete(id)
}

export function getProcess(id: string): ChildProcess | undefined {
  return trackedProcesses.get(id)
}

export function getTrackedCount(): number {
  return trackedProcesses.size
}

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

export function initProcessCleanup(): void {
  process.on('exit', killAll)
  process.on('SIGINT', () => {
    killAll()
    process.exit(0)
  })
}
