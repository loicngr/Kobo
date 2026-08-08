import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getProjectSettings } from './settings-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace, updateDevServerStatus } from './workspace-service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a clean env for child processes, stripping Kobo-specific variables. */
function cleanEnv(): Record<string, string | undefined> {
  const { PORT, SERVER_PORT, ...rest } = process.env
  return rest
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

// ── Types ──────────────────────────────────────────────────────────────────────

/** Runtime status of a dev-server instance (Docker-based or direct process). */
export interface DevServerStatus {
  status: 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  instanceName: string
  projectName: string
  httpPort: string
  url: string
  containers: string[]
  error?: string
}

/** Configuration parsed from a `.container/instances/*.env` file. */
export interface InstanceConfig {
  instanceName: string
  projectName: string
  httpPort: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** workspaceId -> spawned dev-server process */
const trackedProcesses = new Map<string, ChildProcess>()

/** Test-only: clear the tracked-processes map between tests. */
export function _resetTrackedProcessesForTests(): void {
  trackedProcesses.clear()
}

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

    if (
      parsed.INSTANCE_NAME &&
      parsed.INSTANCE_NAME.toLowerCase() === sanitized &&
      parsed.PROJECT_NAME &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(parsed.PROJECT_NAME)
    ) {
      return {
        instanceName: parsed.INSTANCE_NAME,
        projectName: parsed.PROJECT_NAME,
        httpPort: parsed.HTTP_PORT ?? '',
      }
    }
  }

  return null
}

function containerBelongsToProject(containerName: string, projectName: string): boolean {
  const name = containerName.toLowerCase()
  const project = projectName.toLowerCase()
  return name === project || name.startsWith(`${project}-`) || name.startsWith(`${project}_`)
}

// ── Docker helpers ─────────────────────────────────────────────────────────────

/**
 * List all running Docker container names.
 * Uses execFile so Docker inspection cannot block the Node event loop.
 */
export async function listRunningContainers(): Promise<string[]> {
  try {
    const output = await runCommand('docker', ['ps', '--format', '{{.Names}}'], { timeout: 10_000 })
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
 *
 * When `workspaceId` is provided and a start process for that workspace is
 * still running (e.g. `docker compose up -d` is pulling/building images), the
 * status is reported as `'starting'` even if no matching container is visible
 * in `docker ps` yet. This prevents the UI from flashing to `'stopped'` during
 * long build phases.
 */
export async function getStatus(
  projectPath: string,
  workingBranch: string,
  workspaceId?: string,
): Promise<DevServerStatus> {
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

  const running = await listRunningContainers()
  const matching = running.filter((name) => containerBelongsToProject(name, config.projectName))

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

  // No matching container yet — but is a start process still in flight?
  // This covers the long `docker compose up -d` build/pull phase where the
  // CLI hasn't exited yet and containers haven't appeared in `docker ps`.
  if (workspaceId && trackedProcesses.has(workspaceId)) {
    return {
      status: 'starting',
      instanceName: config.instanceName,
      projectName: config.projectName,
      httpPort: config.httpPort,
      url: '',
      containers: [],
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

  // Reject a second concurrent start for the same workspace instead of
  // silently overwriting the tracked process — the first process would
  // otherwise become untrackable (never killed by stopDevServer) and its
  // exit handler could later clobber state set by the second process.
  if (trackedProcesses.has(workspaceId)) {
    throw new Error(`Dev server for workspace '${workspaceId}' is already starting`)
  }

  const instanceName = sanitizeBranchName(workspace.workingBranch)

  // Execute as bash script (supports multi-line scripts)
  const worktreePath = workspace.worktreePath
  const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : workspace.projectPath
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
    void getStatus(workspace.projectPath, workspace.workingBranch)
      .then((currentStatus) => {
        updateDevServerStatus(workspaceId, currentStatus.status)
        emitEphemeral(workspaceId, 'devserver:status', currentStatus)
      })
      .catch((err) => {
        console.error(`[dev-server] Failed to refresh status for workspace ${workspaceId}:`, err)
      })
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
export async function stopDevServer(workspaceId: string): Promise<DevServerStatus> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }

  const config = resolveInstance(workspace.projectPath, workspace.workingBranch)
  const instanceName = config?.instanceName ?? sanitizeBranchName(workspace.workingBranch)
  const worktreePath = workspace.worktreePath
  const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : workspace.projectPath

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
    try {
      await runCommand('bash', ['-c', settings.devServer.stopCommand], {
        cwd,
        env: {
          ...cleanEnv(),
          INSTANCE: instanceName,
          PROJECT_NAME: config?.projectName ?? '',
        },
        timeout: 30_000,
      })
    } catch (err) {
      console.error(`[dev-server] Stop command failed:`, err instanceof Error ? err.message : err)
    }
  }

  // Always try docker compose down with project name if we have one
  // (handles cases where custom stop command doesn't use -p flag)
  if (config?.projectName) {
    try {
      await runCommand('docker', ['compose', '-p', config.projectName, 'down'], { cwd, timeout: 30_000 })
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
 * Docker log reads run concurrently without blocking the Node event loop.
 */
export async function getDevServerLogs(workspaceId: string, tail = 200): Promise<string> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) {
    return 'Workspace not found'
  }

  const config = resolveInstance(workspace.projectPath, workspace.workingBranch)
  if (!config) {
    return 'No dev-server instance found'
  }

  const running = await listRunningContainers()
  const matching = running.filter((name) => containerBelongsToProject(name, config.projectName))

  if (matching.length === 0) {
    return 'No running containers found'
  }

  const outputs = await Promise.all(
    matching.map(async (container) => {
      try {
        const logs = await runCommand('docker', ['logs', '--tail', String(tail), container], { timeout: 10_000 })
        return `=== ${container} ===\n${logs}`
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `=== ${container} ===\n[Error fetching logs: ${message}]`
      }
    }),
  )

  return outputs.join('\n\n')
}
