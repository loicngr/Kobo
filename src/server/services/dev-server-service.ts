import { type ChildProcess, execSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getProjectSettings } from './settings-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace, updateDevServerStatus } from './workspace-service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWorktreePath(projectPath: string, workingBranch: string): string {
  return path.join(projectPath, '.worktrees', workingBranch)
}

/** Build a clean env for child processes, stripping Kobo-specific variables. */
function cleanEnv(): Record<string, string | undefined> {
  const { PORT, SERVER_PORT, ...rest } = process.env
  return rest
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DevServerStatus {
  status: 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  instanceName: string
  projectName: string
  httpPort: string
  url: string
  containers: string[]
  error?: string
}

export interface InstanceConfig {
  instanceName: string
  projectName: string
  httpPort: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** workspaceId -> spawned dev-server process */
const trackedProcesses = new Map<string, ChildProcess>()

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Sanitize a branch name for use as a Docker instance name.
 * Replace `/` and `_` with `-`, lowercase.
 */
export function sanitizeBranchName(branch: string): string {
  return branch.toLowerCase().replace(/[/_]/g, '-')
}

/**
 * Parse a `.env` file content into key=value pairs.
 * Skips empty lines and comments (#). Handles quotes.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

/**
 * Resolve the dev-server instance config for a given project + branch.
 * Looks in `<projectPath>/.container/instances/` for `.env` files.
 */
export function resolveInstance(projectPath: string, workingBranch: string): InstanceConfig | null {
  const instancesDir = path.join(projectPath, '.container', 'instances')

  if (!existsSync(instancesDir)) return null

  const sanitized = sanitizeBranchName(workingBranch)
  const files = readdirSync(instancesDir).filter((f) => f.endsWith('.env'))

  for (const file of files) {
    const content = readFileSync(path.join(instancesDir, file), 'utf-8')
    const parsed = parseEnvFile(content)

    if (parsed.INSTANCE_NAME && parsed.INSTANCE_NAME.toLowerCase() === sanitized) {
      return {
        instanceName: parsed.INSTANCE_NAME,
        projectName: parsed.PROJECT_NAME ?? '',
        httpPort: parsed.HTTP_PORT ?? '',
      }
    }
  }

  return null
}

// ── Docker helpers ─────────────────────────────────────────────────────────────

/**
 * List all running Docker container names.
 * Note: uses execSync with shell because docker ps --format requires
 * Go template syntax with `{{}}`. Input is a static string, no injection risk.
 */
export function listRunningContainers(): string[] {
  try {
    const output = execSync('docker ps --format "{{.Names}}"', {
      encoding: 'utf-8',
      timeout: 10000,
    })
    return output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// ── Status ─────────────────────────────────────────────────────────────────────

/**
 * Get the dev-server status for a given project + branch.
 */
export function getStatus(projectPath: string, workingBranch: string): DevServerStatus {
  const config = resolveInstance(projectPath, workingBranch)

  if (!config) {
    return {
      status: 'unknown',
      instanceName: '',
      projectName: '',
      httpPort: '',
      url: '',
      containers: [],
    }
  }

  const running = listRunningContainers()
  const matching = running.filter((name) => name.toLowerCase().includes(config.projectName.toLowerCase()))

  if (matching.length > 0) {
    return {
      status: 'running',
      instanceName: config.instanceName,
      projectName: config.projectName,
      httpPort: config.httpPort,
      url: `http://localhost:${config.httpPort}`,
      containers: matching,
    }
  }

  return {
    status: 'stopped',
    instanceName: config.instanceName,
    projectName: config.projectName,
    httpPort: config.httpPort,
    url: '',
    containers: [],
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────

/**
 * Start the dev-server for a workspace.
 */
export function startDevServer(workspaceId: string): DevServerStatus {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }

  const settings = getProjectSettings(workspace.projectPath)
  if (!settings?.devServer.startCommand) {
    throw new Error('No dev-server start command configured')
  }

  const instanceName = sanitizeBranchName(workspace.workingBranch)

  // Execute as bash script (supports multi-line scripts)
  const worktreePath = getWorktreePath(workspace.projectPath, workspace.workingBranch)
  const cwd = existsSync(worktreePath) ? worktreePath : workspace.projectPath
  const proc = spawn('bash', ['-c', settings.devServer.startCommand], {
    cwd,
    env: {
      ...cleanEnv(),
      INSTANCE: instanceName,
      DEV_DOCKER_NO_FOLLOW: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  trackedProcesses.set(workspaceId, proc)

  // Log stdout/stderr for debugging
  proc.stdout?.on('data', (data: Buffer) => {
    console.log(`[dev-server:${instanceName}] ${data.toString().trim()}`)
  })
  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[dev-server:${instanceName}] ${data.toString().trim()}`)
  })

  proc.on('exit', (code) => {
    trackedProcesses.delete(workspaceId)
    const currentStatus = getStatus(workspace.projectPath, workspace.workingBranch)
    updateDevServerStatus(workspaceId, currentStatus.status)
    emitEphemeral(workspaceId, 'devserver:status', currentStatus)
    if (code !== 0) {
      console.error(`[dev-server] Process exited with code ${code} for workspace ${workspaceId}`)
    }
  })

  proc.on('error', (err) => {
    trackedProcesses.delete(workspaceId)
    updateDevServerStatus(workspaceId, 'error')
    console.error(`[dev-server] Process error for workspace ${workspaceId}:`, err)
    emitEphemeral(workspaceId, 'devserver:status', {
      status: 'error',
      instanceName,
      projectName: '',
      httpPort: '',
      url: '',
      containers: [],
      error: err.message,
    })
  })

  const status: DevServerStatus = {
    status: 'starting',
    instanceName,
    projectName: '',
    httpPort: '',
    url: '',
    containers: [],
  }

  updateDevServerStatus(workspaceId, 'starting')
  emitEphemeral(workspaceId, 'devserver:status', status)
  return status
}

// ── Stop ───────────────────────────────────────────────────────────────────────

/**
 * Stop the dev-server for a workspace.
 */
export function stopDevServer(workspaceId: string): DevServerStatus {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }

  const config = resolveInstance(workspace.projectPath, workspace.workingBranch)
  const instanceName = config?.instanceName ?? sanitizeBranchName(workspace.workingBranch)
  const worktreePath = getWorktreePath(workspace.projectPath, workspace.workingBranch)
  const cwd = existsSync(worktreePath) ? worktreePath : workspace.projectPath

  // Kill tracked process first (covers Node servers and any spawned process)
  const tracked = trackedProcesses.get(workspaceId)
  if (tracked) {
    try {
      if (tracked.pid) {
        process.kill(-tracked.pid, 'SIGTERM')
      } else {
        tracked.kill('SIGTERM')
      }
    } catch (err) {
      console.error('[dev-server] Failed to kill tracked process:', err instanceof Error ? err.message : err)
    }
    trackedProcesses.delete(workspaceId)
  }

  const settings = getProjectSettings(workspace.projectPath)

  if (settings?.devServer.stopCommand) {
    // Custom stop script — run synchronously with instance context in env
    try {
      execSync(settings.devServer.stopCommand, {
        cwd,
        env: {
          ...cleanEnv(),
          INSTANCE: instanceName,
          PROJECT_NAME: config?.projectName ?? '',
        },
        encoding: 'utf-8',
        timeout: 30000,
        shell: 'bash',
      })
    } catch (err) {
      console.error(`[dev-server] Stop command failed:`, err instanceof Error ? err.message : err)
    }
  }

  // Always try docker compose down with project name if we have one
  // (handles cases where custom stop command doesn't use -p flag)
  if (config?.projectName) {
    try {
      execSync(`docker compose -p "${config.projectName}" down`, {
        cwd: cwd,
        encoding: 'utf-8',
        timeout: 30000,
      })
    } catch {
      // May already be stopped by the custom command — ignore
    }
  }

  const status: DevServerStatus = {
    status: 'stopped',
    instanceName,
    projectName: config?.projectName ?? '',
    httpPort: config?.httpPort ?? '',
    url: '',
    containers: [],
  }

  updateDevServerStatus(workspaceId, 'stopped')
  emitEphemeral(workspaceId, 'devserver:status', status)
  return status
}

// ── Logs ───────────────────────────────────────────────────────────────────────

/**
 * Get logs from running dev-server containers for a workspace.
 * Note: uses execSync for `docker logs` — container names come from
 * `docker ps` output (not user input), so no injection risk.
 */
export function getDevServerLogs(workspaceId: string, tail = 200): string {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    return 'Workspace not found'
  }

  const config = resolveInstance(workspace.projectPath, workspace.workingBranch)
  if (!config) {
    return 'No dev-server instance found'
  }

  const running = listRunningContainers()
  const matching = running.filter((name) => name.toLowerCase().includes(config.projectName.toLowerCase()))

  if (matching.length === 0) {
    return 'No running containers found'
  }

  const outputs: string[] = []

  for (const container of matching) {
    try {
      const logs = execSync(`docker logs --tail ${tail} ${container}`, {
        encoding: 'utf-8',
        timeout: 10000,
      })
      outputs.push(`=== ${container} ===\n${logs}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outputs.push(`=== ${container} ===\n[Error fetching logs: ${message}]`)
    }
  }

  return outputs.join('\n\n')
}
