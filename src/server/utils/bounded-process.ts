import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A zombie cannot mutate a checkout, even before its parent reaps it. */
async function groupIsLive(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw err
  }
  const { stdout } = await execFileAsync('ps', ['-eo', 'pgid=,stat='], { timeout: 1000, encoding: 'utf8' })
  return stdout.split('\n').some((line) => {
    const [group, state] = line.trim().split(/\s+/)
    return Number(group) === pid && !!state && !/^[ZX]/.test(state)
  })
}

export interface BoundedProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  /** Captured output is bounded; omitted stdout is still drained. */
  stdoutLimit?: number
  stderrLimit?: number
  graceMs?: number
}

/**
 * Stop the entire group on timeout, and retain the caller's mutation ownership
 * until exit is confirmed. Inspection failures never authorize another mutation.
 */
export function runBoundedProcess(command: string, args: string[], options: BoundedProcessOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = Buffer.alloc(0)
    let failure: Error | undefined
    let closed = false
    let settled = false
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let checking = false
    let warned = false
    let escalatedAt: number | undefined

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      clearTimeout(pollTimer)
      if (failure) reject(failure)
      else if (code === 0) resolve(Buffer.concat(stdout, stdoutBytes).toString('utf8'))
      else
        reject(
          new Error(
            `${command} failed: ${stderr.toString('utf8').trim() || `exit code ${code ?? signal ?? 'unknown'}`}`,
          ),
        )
    }
    const confirm = async () => {
      if (settled || checking) return
      checking = true
      try {
        if (closed && (!child.pid || !(await groupIsLive(child.pid)))) {
          finish()
          return
        }
        if (escalatedAt !== undefined && Date.now() - escalatedAt >= 5000 && !warned) {
          warned = true
          console.error(
            `[process] ${command} has not exited after SIGKILL; retaining mutation ownership until exit is confirmed`,
          )
        }
      } catch (err) {
        if (!warned) {
          warned = true
          console.error(`[process] Cannot confirm ${command} process-group exit; retaining mutation ownership:`, err)
        }
      } finally {
        checking = false
      }
      if (!settled) pollTimer = setTimeout(() => void confirm(), 250)
    }
    const kill = (requestedSignal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, requestedSignal)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH')
          console.error(`[process] ${requestedSignal} failed for ${command}:`, err)
      }
    }
    const stop = (error: Error) => {
      if (failure || settled) return
      failure = error
      kill('SIGTERM')
      killTimer = setTimeout(() => {
        kill('SIGKILL')
        escalatedAt = Date.now()
        void confirm()
      }, options.graceMs ?? 5000)
      void confirm()
    }
    const deadline = setTimeout(
      () => stop(new Error(`${command} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      if (options.stdoutLimit === undefined) return
      if (stdoutBytes + chunk.length > options.stdoutLimit) {
        stop(new Error(`${command} output exceeded ${options.stdoutLimit} bytes`))
        return
      }
      stdout.push(chunk)
      stdoutBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const limit = options.stderrLimit ?? 8192
      stderr = Buffer.concat([stderr, chunk]).subarray(-limit)
    })
    child.once('error', (err) => {
      if (!child.pid) {
        failure = new Error(`${command} failed to spawn: ${err.message}`)
        finish()
      } else stop(err)
    })
    child.once('close', (exitCode, exitSignal) => {
      closed = true
      code = exitCode
      signal = exitSignal
      void confirm()
    })
  })
}
