import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'
import { getProjectSettings } from './settings-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace, listWorkspaces, updateDevServerStatus } from './workspace-service.js'

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
const stoppingProcesses = new Map<string, Promise<DevServerStatus>>()
const generations = new Map<string, number>()

/** Test-only: clear the tracked-processes map between tests. */
export function _resetTrackedProcessesForTests(): void {
  trackedProcesses.clear()
  stoppingProcesses.clear()
  generations.clear()
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

// ── Docker helpers ─────────────────────────────────────────────────────────────

/**
 * List all running Docker container names.
 * Uses execFile so Docker inspection cannot block the Node event loop.
 */
export async function listRunningContainers(projectName?: string): Promise<string[]> {
  try {
    const args = projectName
      ? [
          'ps',
          '--filter',
          `label=com.docker.compose.project=${projectName}`,
          '--format',
          '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
        ]
      : ['ps', '--format', '{{.Names}}']
    const output = await runCommand('docker', args, { timeout: 10_000 })
    return output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((line) => !projectName || line.split('\t')[1] === projectName)
      .map((line) => (projectName ? line.split('\t')[0]! : line))
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

  const matching = await listRunningContainers(config.projectName)

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
  assertWorkspaceLifecycleAvailable(workspaceId)
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
  if (stoppingProcesses.has(workspaceId)) throw new Error(`Dev server for workspace '${workspaceId}' is stopping`)
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

  const generation = (generations.get(workspaceId) ?? 0) + 1
  generations.set(workspaceId, generation)
  trackedProcesses.set(workspaceId, proc)

  // Log stdout/stderr for debugging
  proc.stdout?.on('data', (data: Buffer) => {
    console.log(`[dev-server:${instanceName}] ${data.toString().trim()}`)
  })
  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[dev-server:${instanceName}] ${data.toString().trim()}`)
  })

  proc.on('exit', (code) => {
    // Shell exit does not imply that its background children have stopped.
    void (async () => {
      while (trackedProcesses.get(workspaceId) === proc && !stoppingProcesses.has(workspaceId)) {
        if (proc.pid && (await hasLiveProcessGroup(proc.pid))) {
          await pollDelay(250)
          continue
        }
        if (trackedProcesses.get(workspaceId) !== proc || stoppingProcesses.has(workspaceId)) return
        trackedProcesses.delete(workspaceId)
        const currentStatus = await getStatus(workspace.projectPath, workspace.workingBranch)
        if (generations.get(workspaceId) !== generation || stoppingProcesses.has(workspaceId)) return
        updateDevServerStatus(workspaceId, currentStatus.status)
        emitEphemeral(workspaceId, 'devserver:status', currentStatus)
        return
      }
    })().catch((err) => {
      console.error(`[dev-server] Failed to confirm process-group exit for workspace ${workspaceId}:`, err)
    })
    if (code !== 0) console.error(`[dev-server] Process exited with code ${code} for workspace ${workspaceId}`)
  })

  proc.on('error', (err) => {
    if (trackedProcesses.get(workspaceId) !== proc) return
    // A signal failure is also an 'error' event; it does not prove process exit.
    if (!proc.pid) trackedProcesses.delete(workspaceId)
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
  const pending = stoppingProcesses.get(workspaceId)
  if (pending) return pending
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1)
  const stopping = stopDevServerOwned(workspaceId)
  stoppingProcesses.set(workspaceId, stopping)
  try {
    return await stopping
  } finally {
    if (stoppingProcesses.get(workspaceId) === stopping) stoppingProcesses.delete(workspaceId)
  }
}

function pollDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** A zombie cannot write files, even if the OS has not reaped its PID yet. */
async function hasLiveProcessGroup(groupId: number): Promise<boolean> {
  try {
    process.kill(-groupId, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw err
  }
  const processes = await runCommand('ps', ['-eo', 'pgid=,stat='], { timeout: 1000 })
  return processes.split('\n').some((line) => {
    const [group, state] = line.trim().split(/\s+/)
    return Number(group) === groupId && !!state && !/^[ZX]/.test(state)
  })
}

async function signalGroupAndWait(groupId: number, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(-groupId, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw err
  }
  const deadline = Date.now() + timeoutMs
  while (await hasLiveProcessGroup(groupId)) {
    if (Date.now() >= deadline) return false
    await pollDelay(50)
  }
  return true
}

function signalAndWait(proc: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  if (proc.pid) return signalGroupAndWait(proc.pid, signal, timeoutMs)
  if (proc.exitCode != null || proc.signalCode != null) return Promise.resolve(true)
  return new Promise((resolve, reject) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const onError = (err: Error): void => {
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      reject(err)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    proc.once('exit', onExit)
    proc.once('error', onError)
    try {
      if (proc.pid) process.kill(-proc.pid, signal)
      else proc.kill(signal)
    } catch (err) {
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      reject(err)
    }
  })
}

async function stopDevServerOwned(workspaceId: string): Promise<DevServerStatus> {
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
    const exited = (await signalAndWait(tracked, 'SIGTERM', 3_000)) || (await signalAndWait(tracked, 'SIGKILL', 1_000))
    if (!exited) throw new Error('Dev server stop is not confirmed; retry after the process exits')
    if (trackedProcesses.get(workspaceId) === tracked) trackedProcesses.delete(workspaceId)
  }

  const settings = getProjectSettings(workspace.projectPath)

  let stopError: unknown
  let customStopSucceeded = false
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
      customStopSucceeded = true
    } catch (err) {
      stopError = err
    }
  }

  // Always try docker compose down with project name if we have one
  // (handles cases where custom stop command doesn't use -p flag)
  if (config?.projectName) {
    try {
      await runCommand('docker', ['compose', '-p', config.projectName, 'down'], { cwd, timeout: 30_000 })
      stopError = undefined
    } catch (err) {
      stopError = err
      // The custom command may use -f/--env-file absent from the generic fallback.
      // Only an independent, successful Docker query can confirm it stopped everything.
      if (customStopSucceeded) {
        try {
          const remaining = await runCommand(
            'docker',
            ['ps', '--filter', `label=com.docker.compose.project=${config.projectName}`, '--format', '{{.ID}}'],
            { timeout: 10_000 },
          )
          if (!remaining.trim()) stopError = undefined
        } catch {
          // An unavailable daemon is not confirmation of shutdown.
        }
      }
    }
  }

  if (stopError)
    throw new Error(`Dev server stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`)

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

/** Stop direct and Docker dev servers for every persisted workspace. */
export async function stopAllDevServers(): Promise<void> {
  const workspaceIds = new Set([...listWorkspaces(true).map((workspace) => workspace.id), ...trackedProcesses.keys()])
  await Promise.all(
    [...workspaceIds].map(async (workspaceId) => {
      try {
        await stopDevServer(workspaceId)
      } catch (err) {
        console.error(`[dev-server] Failed to stop '${workspaceId}' during shutdown:`, err)
      }
    }),
  )
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

  const matching = await listRunningContainers(config.projectName)

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
