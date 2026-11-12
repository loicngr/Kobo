import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import * as wsService from '../services/websocket-service.js'
import { resolveInstance, sanitizeBranchName } from './dev-server-instance.js'
import { getIndexLockPath } from './git-ops.js'
import { ensureDirectoryInside } from './safe-path.js'

/** Default wall-clock budget for a user script before it is force-killed. */
export const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Every output line is a persisted `ws_events` row plus a broadcast: bound what one script can add. */
export const MAX_SCRIPT_OUTPUT_LINES = 5_000
export const MAX_SCRIPT_OUTPUT_CHARS = 1024 * 1024
export const MAX_SCRIPT_OUTPUT_LINE_CHARS = 16 * 1024

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
  /**
   * Event-specific variables. Only `KOBO_`-prefixed keys are honoured, and
   * they are merged UNDER the identity variables below: a payload can neither
   * replace PATH or HOME nor tell a script it runs for another workspace.
   */
  extraEnv?: Record<string, string>
  timeoutMs?: number
}

/**
 * Execute a user-provided bash script inside a worktree, streaming stdout/stderr
 * line-by-line over WebSocket. Resolves with the exit code — never rejects.
 * Shared mechanism behind the setup and cleanup script services.
 */
export function runScript(opts: RunScriptOptions): Promise<{ exitCode: number }> {
  const { workspaceId, worktreePath, script, eventPrefix, tmpFileName, env, extraEnv } = opts
  const timeoutMs = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS

  let scriptPath: string | undefined
  let scriptDirectory: string | undefined
  const cleanup = (): void => {
    if (scriptPath) {
      try {
        fs.unlinkSync(scriptPath)
      } catch {
        /* best effort */
      }
    }
    if (scriptDirectory) {
      try {
        fs.rmdirSync(scriptDirectory)
      } catch {
        /* best effort */
      }
    }
  }
  return new Promise<{ exitCode: number }>((resolve) => {
    const storage = ensureDirectoryInside(worktreePath, '.ai')
    scriptDirectory = fs.mkdtempSync(path.join(storage, '.script-'))
    scriptPath = path.join(scriptDirectory, path.basename(tmpFileName))
    fs.writeFileSync(scriptPath, script, { mode: 0o700, flag: 'wx' })

    // Resolve only from this workspace's persisted instance, never the host's env.
    const instance = env?.projectPath && env.branchName ? resolveInstance(env.projectPath, env.branchName) : null
    const proc = spawn('bash', [scriptPath], {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(extraEnv ?? {}).filter(([key]) => key.startsWith('KOBO_'))),
        WORKSPACE_ID: workspaceId,
        WORKSPACE_NAME: env?.workspaceName ?? '',
        BRANCH_NAME: env?.branchName ?? '',
        SOURCE_BRANCH: env?.sourceBranch ?? '',
        PROJECT_PATH: env?.projectPath ?? '',
        PROJECT_NAME: instance?.projectName ?? '',
        INSTANCE: instance?.instanceName ?? sanitizeBranchName(env?.branchName ?? ''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached so this is the leader of its own process group: a script
      // that backgrounds a child (`npm run dev &`) would otherwise leave
      // that child running after a timeout kill, since SIGKILL on `proc`
      // alone only reaches the `bash` process itself.
      detached: true,
    })

    const timeout = setTimeout(() => {
      // Kill the whole process group (-pid), not just `proc` — otherwise a
      // backgrounded child of the script survives the timeout as an orphan.
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
        else proc.kill('SIGKILL')
      } catch {
        proc.kill('SIGKILL')
      }
      // Destroy pipes so the 'close' event fires immediately even if
      // child processes (e.g. sleep) inherited the file descriptors.
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      wsService.emit(workspaceId, `${eventPrefix}:output`, {
        text: `[kobo] Script timed out after ${timeoutMs < 60000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${Math.round(timeoutMs / 60000)} minutes`}`,
      })
      // SIGKILL on the process group gives a running `git commit` no chance to
      // release its index lock. Name the file here, while the user is looking
      // at this feed — otherwise the next git write fails with a raw git error
      // whose cause is three screens above.
      const lockPath = getIndexLockPath(worktreePath)
      if (lockPath) {
        wsService.emit(workspaceId, `${eventPrefix}:output`, {
          text: `[kobo] A git index lock was left behind at ${lockPath}. Remove it before the next git command: rm -f '${lockPath}'`,
        })
      }
    }, timeoutMs)

    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g')
    const stripAnsi = (s: string) => s.replace(ansiPattern, '')

    // Track whether the script printed anything — lets the UI show a terse
    // "Done" instead of a near-empty card when a script runs silently.
    let outputEmitted = false

    let emittedLines = 0
    let emittedChars = 0
    let truncated = false

    const emitLine = (text: string) => {
      const trimmed = stripAnsi(text).trim()
      if (!trimmed || truncated) return
      if (emittedLines >= MAX_SCRIPT_OUTPUT_LINES || emittedChars + trimmed.length > MAX_SCRIPT_OUTPUT_CHARS) {
        truncated = true
        wsService.emit(workspaceId, `${eventPrefix}:output`, {
          text: `[kobo] Output truncated after ${emittedLines} lines; the script keeps running but later output is not recorded`,
        })
        return
      }
      outputEmitted = true
      emittedLines++
      emittedChars += trimmed.length
      wsService.emit(workspaceId, `${eventPrefix}:output`, { text: trimmed })
    }

    // Chunks cut lines and multi-byte characters anywhere: decode statefully and
    // keep the unfinished line of each stream until its newline (or the end) arrives.
    const flushers: Array<() => void> = []
    for (const stream of [proc.stdout, proc.stderr]) {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const consume = (text: string, end = false) => {
        if (truncated) {
          pending = ''
          return
        }
        const lines = (pending + text).split('\n')
        pending = end ? '' : (lines.pop() ?? '')
        for (const line of lines)
          for (let i = 0; i < line.length; i += MAX_SCRIPT_OUTPUT_LINE_CHARS)
            emitLine(line.slice(i, i + MAX_SCRIPT_OUTPUT_LINE_CHARS))
        // A line that never ends must not accumulate without bound.
        while (pending.length > MAX_SCRIPT_OUTPUT_LINE_CHARS) {
          emitLine(pending.slice(0, MAX_SCRIPT_OUTPUT_LINE_CHARS))
          pending = pending.slice(MAX_SCRIPT_OUTPUT_LINE_CHARS)
        }
      }
      stream.on('data', (data: Buffer) => consume(decoder.write(data)))
      flushers.push(() => consume(decoder.end(), true))
    }

    let settled = false

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      cleanup()

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
      for (const flush of flushers) flush()
      finish(code ?? 1)
    })
  }).catch((err) => {
    cleanup()
    const message = err instanceof Error ? err.message : String(err)
    wsService.emit(workspaceId, `${eventPrefix}:output`, { text: `[kobo] Script failed to start: ${message}` })
    wsService.emitEphemeral(workspaceId, `${eventPrefix}:error`, { exitCode: 1, message })
    return { exitCode: 1 }
  })
}
