import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as wsService from '../services/websocket-service.js'

/** Default wall-clock budget for a user script before it is force-killed. */
export const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Environment variables exposed to a user script. */
export interface ScriptEnv {
  workspaceName: string
  branchName: string
  sourceBranch: string
  projectPath: string
}

export interface RunScriptOptions {
  workspaceId: string
  worktreePath: string
  script: string
  /** WS event namespace, e.g. `setup` → emits `setup:output` / `setup:complete` / `setup:error`. */
  eventPrefix: string
  /** Temp file name written under `<worktree>/.ai/`, e.g. `.setup-script.tmp`. */
  tmpFileName: string
  env?: ScriptEnv
  timeoutMs?: number
}

/**
 * Execute a user-provided bash script inside a worktree, streaming stdout/stderr
 * line-by-line over WebSocket. Resolves with the exit code — never rejects.
 * Shared mechanism behind the setup and cleanup script services.
 */
export function runScript(opts: RunScriptOptions): Promise<{ exitCode: number }> {
  const { workspaceId, worktreePath, script, eventPrefix, tmpFileName, env } = opts
  const timeoutMs = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS

  return new Promise((resolve) => {
    const scriptPath = path.join(worktreePath, '.ai', tmpFileName)
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
    fs.writeFileSync(scriptPath, script, { mode: 0o755 })

    const proc = spawn('bash', [scriptPath], {
      cwd: worktreePath,
      env: {
        ...process.env,
        WORKSPACE_ID: workspaceId,
        WORKSPACE_NAME: env?.workspaceName ?? '',
        BRANCH_NAME: env?.branchName ?? '',
        SOURCE_BRANCH: env?.sourceBranch ?? '',
        PROJECT_PATH: env?.projectPath ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      // Destroy pipes so the 'close' event fires immediately even if
      // child processes (e.g. sleep) inherited the file descriptors.
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      wsService.emit(workspaceId, `${eventPrefix}:output`, {
        text: `[kobo] Script timed out after ${Math.round(timeoutMs / 60000)} minutes`,
      })
    }, timeoutMs)

    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g')
    const stripAnsi = (s: string) => s.replace(ansiPattern, '')

    // Track whether the script printed anything — lets the UI show a terse
    // "Done" instead of a near-empty card when a script runs silently.
    let outputEmitted = false

    const emitLine = (text: string) => {
      const trimmed = stripAnsi(text).trim()
      if (trimmed) {
        outputEmitted = true
        wsService.emit(workspaceId, `${eventPrefix}:output`, { text: trimmed })
      }
    }

    proc.stdout.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        emitLine(line)
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        emitLine(line)
      }
    })

    let settled = false

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        fs.unlinkSync(scriptPath)
      } catch {
        /* best-effort */
      }

      if (exitCode === 0) {
        wsService.emitEphemeral(workspaceId, `${eventPrefix}:complete`, { hadOutput: outputEmitted })
      } else {
        wsService.emitEphemeral(workspaceId, `${eventPrefix}:error`, {
          exitCode,
          message: `Script exited with code ${exitCode}`,
        })
      }
      resolve({ exitCode })
    }

    proc.on('error', (err) => {
      wsService.emit(workspaceId, `${eventPrefix}:output`, {
        text: `[kobo] Script failed to start: ${err.message}`,
      })
      finish(1)
    })

    proc.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}
