import { runScript, SCRIPT_TIMEOUT_MS } from '../utils/script-runner.js'

const SETUP_TIMEOUT_MS = SCRIPT_TIMEOUT_MS // 5 minutes

/** Environment variables passed to the setup script. */
export interface SetupScriptEnv {
  workspaceName: string
  branchName: string
  sourceBranch: string
  projectPath: string
}

/** Execute a setup script in a worktree, streaming output via WebSocket. Resolves with the exit code. */
export function runSetupScript(
  workspaceId: string,
  worktreePath: string,
  script: string,
  env?: SetupScriptEnv,
  timeoutMs = SETUP_TIMEOUT_MS,
): Promise<{ exitCode: number }> {
  return runScript({
    workspaceId,
    worktreePath,
    script,
    eventPrefix: 'setup',
    tmpFileName: '.setup-script.tmp',
    env,
    timeoutMs,
  })
}
