import { type ChildProcess, spawn } from 'node:child_process'
import { groupIsLive } from '../../../../utils/bounded-process.js'

export interface VibeAcpRuntime {
  child: ChildProcess
  /** Runtime ownership: clean native exit AND an empty process group, never merely an ACP ACK. */
  closed: Promise<void>
  /** Optional native cancel/close callback; repeated calls share the same shutdown. */
  stop(cooperate?: () => Promise<void>): Promise<void>
}

export function spawnVibeAcp(options: { cwd: string; env: NodeJS.ProcessEnv }): VibeAcpRuntime {
  const child = spawn('vibe-acp', [], { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let exited = false
  let confirmed = false
  let abnormal = false
  let groupGone = false
  let checking = false
  let warned = false
  let spawnFailure: Error | undefined
  let stopPromise: Promise<void> | undefined
  let rejectStop: ((error: Error) => void) | undefined
  let stderr = Buffer.alloc(0)
  let poll: ReturnType<typeof setTimeout> | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const diagnostic = (reason: string) => {
    if (warned) return
    warned = true
    // Native stderr may contain credentials. Only fixed classifications leave this module.
    const hint = /missing api key|authentication failed/i.test(stderr.toString('utf8'))
      ? '; check the native Vibe authentication configuration'
      : ''
    console.error(`[mistral-vibe] ${reason}${hint}; retaining runtime ownership`)
  }
  const schedule = (callback: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, ms)
    timers.add(timer)
    return timer
  }
  const finish = () => {
    confirmed = true
    clearTimeout(poll)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    stderr = Buffer.alloc(0)
    resolveClosed()
  }
  const confirm = async () => {
    if (confirmed || checking || (!exited && !abnormal)) return
    checking = true
    try {
      if (!child.pid || !(await groupIsLive(child.pid))) {
        groupGone = true
        if (!exited) return
        if (abnormal) {
          diagnostic('Native process did not close cleanly')
          rejectStop?.(new Error('Vibe ACP closed abnormally; retaining runtime ownership'))
        } else finish()
        return
      }
    } catch {
      diagnostic('Cannot inspect the native process group')
    } finally {
      checking = false
    }
    if (!confirmed)
      poll = setTimeout(() => {
        void confirm()
      }, 250).unref()
  }
  const signal = (requested: NodeJS.Signals) => {
    if (groupGone) return
    try {
      if (child.pid) {
        process.kill(-child.pid, requested)
        abnormal = true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        abnormal = true
        diagnostic('Cannot signal the native process group')
      }
    }
    void confirm()
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = Buffer.from(Buffer.concat([stderr, chunk.subarray(-8192)]).subarray(-8192))
  })
  // A failed write is also reported by the SDK; never let a pipe error crash the server.
  child.stdin?.on('error', () => {})
  child.once('error', (error: NodeJS.ErrnoException) => {
    spawnFailure = new Error(
      error.code === 'ENOENT'
        ? 'vibe-acp not found on PATH'
        : 'Cannot start vibe-acp; check its executable and working directory',
    )
    if (!child.pid) finish()
    else {
      abnormal = true
      diagnostic('Native process error')
    }
  })
  child.once('close', (code, exitSignal) => {
    exited = true
    abnormal ||= code !== 0 || exitSignal !== null
    void confirm()
  })

  const stop = (cooperate?: () => Promise<void>): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (spawnFailure) throw spawnFailure
      if (confirmed) return
      if (groupGone && abnormal) throw new Error('Vibe ACP closed abnormally; retaining runtime ownership')
      if (cooperate && !exited) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined
        try {
          // A stalled close ACK must not consume the subsequent EOF cleanup allowance.
          await Promise.race([
            cooperate(),
            closed,
            new Promise<void>((resolve) => {
              closeTimer = schedule(resolve, 5000)
            }),
          ])
        } catch {
          // EOF is the native shared-host cleanup path even if cancel/close failed.
        } finally {
          clearTimeout(closeTimer)
          if (closeTimer) timers.delete(closeTimer)
        }
      }
      if (spawnFailure) throw spawnFailure
      if (confirmed) return
      child.stdin?.end()
      child.stdout?.resume()
      schedule(() => {
        if (!confirmed) signal('SIGTERM')
      }, 15000)
      schedule(() => {
        if (!confirmed) signal('SIGKILL')
      }, 20000)
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          rejectStop = reject
          schedule(() => {
            diagnostic('Native shutdown could not be confirmed')
            reject(new Error('Vibe ACP shutdown unconfirmed; retaining runtime ownership'))
          }, 25000)
        }),
      ])
      if (spawnFailure) throw spawnFailure
    })()
    return stopPromise
  }
  return { child, closed, stop }
}
