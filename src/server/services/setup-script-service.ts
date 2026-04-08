import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as wsService from './websocket-service.js'

const SETUP_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface SetupScriptEnv {
  workspaceName: string
  branchName: string
  sourceBranch: string
  projectPath: string
}

export function runSetupScript(
  workspaceId: string,
  worktreePath: string,
  script: string,
  env?: SetupScriptEnv,
  timeoutMs = SETUP_TIMEOUT_MS,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(worktreePath, '.ai', '.setup-script.tmp')
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
      wsService.emit(workspaceId, 'setup:output', {
        text: '[kobo] Setup script timed out after 5 minutes',
      })
    }, timeoutMs)

    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g')
    const stripAnsi = (s: string) => s.replace(ansiPattern, '')

    const emitLine = (text: string) => {
      const trimmed = stripAnsi(text).trim()
      if (trimmed) {
        wsService.emit(workspaceId, 'setup:output', { text: trimmed })
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
        wsService.emitEphemeral(workspaceId, 'setup:complete', {})
      } else {
        wsService.emitEphemeral(workspaceId, 'setup:error', {
          exitCode,
          message: `Setup script exited with code ${exitCode}`,
        })
      }
      resolve({ exitCode })
    }

    proc.on('error', (err) => {
      wsService.emit(workspaceId, 'setup:output', {
        text: `[kobo] Setup script failed to start: ${err.message}`,
      })
      finish(1)
    })

    proc.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}
