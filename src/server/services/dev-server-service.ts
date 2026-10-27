import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { resolveInstance, sanitizeBranchName } from '../utils/dev-server-instance.js'

import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'
import { getGlobalSettings, getProjectSettings } from './settings-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace, listWorkspaces, updateDevServerStatus } from './workspace-service.js'

export { type InstanceConfig, parseEnvFile, resolveInstance, sanitizeBranchName } from '../utils/dev-server-instance.js'

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
  status: 'queued' | 'unknown' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  instanceName: string
  projectName: string
  httpPort: string
  url: string
  containers: string[]
  error?: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** workspaceId -> spawned dev-server process */
const trackedProcesses = new Map<string, ChildProcess>()
const directServerStatuses = new Map<string, DevServerStatus>()
const stoppingProcesses = new Map<string, Promise<DevServerStatus>>()
const generations = new Map<string, number>()
const queuedStarts = new Map<string, DevServerStatus>()
// A running reservation survives CLI exit and failed Docker/process inspection.
const reservations = new Map<string, 'starting' | 'running'>()
let draining = false
let drainRequested = false
let admissionEpoch = 0
let shuttingDown = false

function queuedStatus(workspaceId: string): DevServerStatus {
  return {
    status: 'queued',
    instanceName: sanitizeBranchName(getWorkspace(workspaceId)!.workingBranch),
    projectName: '',
    httpPort: '',
    url: '',
    containers: [],
  }
}

function hasAdmissionCapacity(): boolean {
  const { serializeDevServerStarts, maxRunningDevServers } = getGlobalSettings()
  return (
    !(serializeDevServerStarts && [...reservations.values()].includes('starting')) &&
    !(maxRunningDevServers > 0 && reservations.size >= maxRunningDevServers)
  )
}

function dockerWorkspaces() {
  return (listWorkspaces(true) ?? []).filter((workspace) =>
    resolveInstance(workspace.projectPath, workspace.workingBranch),
  )
}

/** Reconsider FIFO starts after confirmed capacity release or a settings change. */
export function resumeQueuedDevServers(): void {
  if (shuttingDown || !queuedStarts.size) return
  if (draining) {
    drainRequested = true
    return
  }
  draining = true
  drainRequested = false
  const epoch = admissionEpoch
  void (async () => {
    // Recover preserved Docker services before reserving new capacity. A failed
    // query cannot prove an existing service stopped.
    for (const workspace of dockerWorkspaces()) {
      if (trackedProcesses.has(workspace.id) || stoppingProcesses.has(workspace.id)) continue
      const generation = generations.get(workspace.id)
      const config = resolveInstance(workspace.projectPath, workspace.workingBranch)!
      try {
        const containers = await inspectRunningContainers(config.projectName)
        if (shuttingDown || epoch !== admissionEpoch) return
        if (
          generations.get(workspace.id) !== generation ||
          trackedProcesses.has(workspace.id) ||
          stoppingProcesses.has(workspace.id)
        )
          continue
        if (containers.length) {
          reservations.set(workspace.id, 'running')
          if (queuedStarts.delete(workspace.id))
            publishStatus(workspace.id, {
              status: 'running',
              instanceName: config.instanceName,
              projectName: config.projectName,
              httpPort: config.httpPort,
              url: `http://localhost:${config.httpPort}`,
              containers,
            })
        } else reservations.delete(workspace.id)
      } catch {
        if (epoch !== admissionEpoch || shuttingDown) return
        if (generations.get(workspace.id) === generation && !reservations.has(workspace.id))
          reservations.set(workspace.id, 'starting')
      }
    }
    for (const [workspaceId] of queuedStarts) {
      if (shuttingDown || epoch !== admissionEpoch) return
      const workspace = getWorkspace(workspaceId)
      if (!workspace || workspace.archivedAt || workspace.worktreePurgedAt) {
        queuedStarts.delete(workspaceId)
        if (workspace) publishStatus(workspaceId, { ...queuedStatus(workspaceId), status: 'stopped' })
        continue
      }
      if (reservations.has(workspaceId)) break
      if (!hasAdmissionCapacity()) break
      queuedStarts.delete(workspaceId)
      try {
        launchDevServer(workspaceId)
      } catch (err) {
        publishStatus(workspaceId, {
          ...queuedStatus(workspaceId),
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })()
    .finally(() => {
      if (epoch !== admissionEpoch) return
      draining = false
      if (drainRequested) resumeQueuedDevServers()
    })
    .catch((err) => console.error('[dev-server] Failed to resume queued starts:', err))
}

function publishStatus(workspaceId: string, status: DevServerStatus): void {
  updateDevServerStatus(workspaceId, status.status)
  emitEphemeral(workspaceId, 'devserver:status', status)
}

export function beginDevServerShutdown(): void {
  shuttingDown = true
  for (const [workspaceId, status] of queuedStarts) publishStatus(workspaceId, { ...status, status: 'stopped' })
  queuedStarts.clear()
}

/** Test-only: clear the tracked-processes map between tests. */
export function _resetTrackedProcessesForTests(): void {
  admissionEpoch++
  drainRequested = false
  draining = false
  queuedStarts.clear()
  reservations.clear()
  trackedProcesses.clear()
  directServerStatuses.clear()
  stoppingProcesses.clear()
  generations.clear()
  shuttingDown = false
}

// ── Docker helpers ─────────────────────────────────────────────────────────────

/**
 * List all running Docker container names.
 * Uses execFile so Docker inspection cannot block the Node event loop.
 */
async function inspectRunningContainers(projectName?: string): Promise<string[]> {
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
}

export async function listRunningContainers(projectName?: string): Promise<string[]> {
  try {
    return await inspectRunningContainers(projectName)
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
 * long build phases. Direct processes report running and their URL after a
 * recognized local readiness announcement on stdout or stderr.
 */
export async function getStatus(
  projectPath: string,
  workingBranch: string,
  workspaceId?: string,
): Promise<DevServerStatus> {
  const queued = workspaceId ? queuedStarts.get(workspaceId) : undefined
  if (queued) {
    resumeQueuedDevServers()
    return { ...queued }
  }
  const config = resolveInstance(projectPath, workingBranch)
  const directStatus = workspaceId ? directServerStatuses.get(workspaceId) : undefined
  if (workspaceId && directStatus && trackedProcesses.has(workspaceId)) return { ...directStatus }

  if (!config) {
    return {
      status: workspaceId && trackedProcesses.has(workspaceId) ? 'starting' : 'unknown',
      instanceName: workspaceId && trackedProcesses.has(workspaceId) ? sanitizeBranchName(workingBranch) : '',
      projectName: '',
      httpPort: '',
      url: '',
      containers: [],
    }
  }

  let matching: string[]
  const generation = workspaceId ? generations.get(workspaceId) : undefined
  try {
    matching = await inspectRunningContainers(config.projectName)
    if (
      workspaceId &&
      generations.get(workspaceId) === generation &&
      !trackedProcesses.has(workspaceId) &&
      !stoppingProcesses.has(workspaceId)
    ) {
      if (matching.length) {
        const wasStarting = reservations.get(workspaceId) === 'starting'
        reservations.set(workspaceId, 'running')
        if (wasStarting) resumeQueuedDevServers()
      } else {
        reservations.delete(workspaceId)
        resumeQueuedDevServers()
      }
    }
  } catch {
    return {
      status: workspaceId && reservations.has(workspaceId) ? reservations.get(workspaceId)! : 'unknown',
      instanceName: config.instanceName,
      projectName: config.projectName,
      httpPort: config.httpPort,
      url: '',
      containers: [],
    }
  }

  if (workspaceId && trackedProcesses.has(workspaceId) && reservations.get(workspaceId) === 'starting') {
    return {
      status: 'starting',
      instanceName: config.instanceName,
      projectName: config.projectName,
      httpPort: config.httpPort,
      url: '',
      containers: matching,
    }
  }

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
  if (shuttingDown) throw new Error('Kōbō is shutting down')
  assertWorkspaceLifecycleAvailable(workspaceId)
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)
  if (!getProjectSettings(workspace.projectPath)?.devServer.startCommand)
    throw new Error('No dev-server start command configured')
  if (stoppingProcesses.has(workspaceId)) throw new Error(`Dev server for workspace '${workspaceId}' is stopping`)
  const queued = queuedStarts.get(workspaceId)
  if (queued) {
    resumeQueuedDevServers()
    return { ...queued }
  }
  if (trackedProcesses.has(workspaceId) || reservations.has(workspaceId))
    throw new Error(`Dev server for workspace '${workspaceId}' is already starting or running`)
  if (
    queuedStarts.size ||
    draining ||
    !hasAdmissionCapacity() ||
    dockerWorkspaces().some((item) => !reservations.has(item.id))
  ) {
    const status = queuedStatus(workspaceId)
    queuedStarts.set(workspaceId, status)
    publishStatus(workspaceId, status)
    resumeQueuedDevServers()
    return status
  }
  return launchDevServer(workspaceId)
}

function launchDevServer(workspaceId: string): DevServerStatus {
  if (shuttingDown) throw new Error('Kōbō is shutting down')
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
  reservations.set(workspaceId, 'starting')

  // Parse complete lines separately per stream: CLI output and ANSI sequences
  // can span arbitrary pipe chunks. Bound the unfinished line retained in memory.
  const observeOutput = () => {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    return (data: Buffer): void => {
      if (
        shuttingDown ||
        trackedProcesses.get(workspaceId) !== proc ||
        generations.get(workspaceId) !== generation ||
        stoppingProcesses.has(workspaceId) ||
        directServerStatuses.has(workspaceId)
      )
        return
      pending += decoder.write(data)
      const lines = pending.split(/[\r\n]/)
      pending = lines.pop()!.slice(-8192)
      for (const line of lines) {
        // Quasar's "App URL....." and Vite/Next's "Local:" are explicit
        // readiness announcements; unrelated links in build output are not.
        const match = stripVTControlCharacters(line).match(
          /^\s*(?:[»➜-]\s*)?(?:App URL[.\s]*|Local:\s*)(https?:\/\/\S+)\s*$/i,
        )
        // The startup script may create its Docker instance configuration before announcing a URL.
        if (!match || resolveInstance(workspace.projectPath, workspace.workingBranch)) continue
        let url: URL
        try {
          url = new URL(match[1]!)
        } catch {
          continue
        }
        if (
          url.username ||
          url.password ||
          !['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(url.hostname)
        )
          continue
        if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost'
        const status: DevServerStatus = {
          status: 'running',
          instanceName,
          projectName: '',
          httpPort: url.port || (url.protocol === 'https:' ? '443' : '80'),
          url: url.href,
          containers: [],
        }
        directServerStatuses.set(workspaceId, status)
        reservations.set(workspaceId, 'running')
        resumeQueuedDevServers()
        updateDevServerStatus(workspaceId, 'running')
        emitEphemeral(workspaceId, 'devserver:status', status)
        break
      }
    }
  }
  const observeStdout = observeOutput()
  const observeStderr = observeOutput()
  proc.stdout?.on('data', (data: Buffer) => {
    console.log(`[dev-server:${instanceName}] ${data.toString().trim()}`)
    observeStdout(data)
  })
  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[dev-server:${instanceName}] ${data.toString().trim()}`)
    observeStderr(data)
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
        directServerStatuses.delete(workspaceId)
        const currentStatus = await getStatus(workspace.projectPath, workspace.workingBranch)
        if (shuttingDown || generations.get(workspaceId) !== generation || stoppingProcesses.has(workspaceId)) return
        if (currentStatus.status === 'running') reservations.set(workspaceId, 'running')
        else if (currentStatus.status !== 'unknown' || !resolveInstance(workspace.projectPath, workspace.workingBranch))
          reservations.delete(workspaceId)
        resumeQueuedDevServers()
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
    if (shuttingDown || trackedProcesses.get(workspaceId) !== proc || generations.get(workspaceId) !== generation)
      return
    // A signal failure is also an 'error' event; it does not prove process exit.
    if (!proc.pid) {
      trackedProcesses.delete(workspaceId)
      reservations.delete(workspaceId)
      resumeQueuedDevServers()
    }
    directServerStatuses.delete(workspaceId)
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
  const workspace = getWorkspace(workspaceId)
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1)
  const queued = queuedStarts.get(workspaceId)
  if (queued) {
    queuedStarts.delete(workspaceId)
    // A queued request may be recovering Docker services preserved across restart.
    if (
      !trackedProcesses.has(workspaceId) &&
      !reservations.has(workspaceId) &&
      workspace &&
      !resolveInstance(workspace.projectPath, workspace.workingBranch)
    ) {
      const status: DevServerStatus = { ...queued, status: 'stopped' }
      publishStatus(workspaceId, status)
      resumeQueuedDevServers()
      return status
    }
    reservations.set(workspaceId, reservations.get(workspaceId) ?? 'starting')
  }
  // Preserved Docker services may be stopped before any start or status read recovers them.
  if (workspace && resolveInstance(workspace.projectPath, workspace.workingBranch))
    reservations.set(workspaceId, reservations.get(workspaceId) ?? 'running')
  directServerStatuses.delete(workspaceId)
  const stopping = stopDevServerOwned(workspaceId)
  stoppingProcesses.set(workspaceId, stopping)
  try {
    const status = await stopping
    reservations.delete(workspaceId)
    return status
  } finally {
    if (stoppingProcesses.get(workspaceId) === stopping) stoppingProcesses.delete(workspaceId)
    resumeQueuedDevServers()
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
    // Some CI process supervisors reject the signal-0 probe after the shell
    // exits even though `ps` can still inspect its former group. `ps` below is
    // our authoritative liveness check and distinguishes live descendants
    // from a reaped group without turning that platform quirk into a failed
    // dev-server stop.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
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

async function stopTrackedProcess(workspaceId: string): Promise<void> {
  const tracked = trackedProcesses.get(workspaceId)
  if (!tracked) return
  const exited = (await signalAndWait(tracked, 'SIGTERM', 3_000)) || (await signalAndWait(tracked, 'SIGKILL', 1_000))
  if (!exited) throw new Error('Dev server stop is not confirmed; retry after the process exits')
  if (trackedProcesses.get(workspaceId) === tracked) trackedProcesses.delete(workspaceId)
  directServerStatuses.delete(workspaceId)
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
  await stopTrackedProcess(workspaceId)

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

/** Shut down local processes; optionally leave independently running Docker services alone. */
export async function stopAllDevServers(options: { preserveDocker?: boolean } = {}): Promise<void> {
  beginDevServerShutdown()
  const workspaceIds = new Set([...listWorkspaces(true).map((workspace) => workspace.id), ...trackedProcesses.keys()])
  await Promise.all(
    [...workspaceIds].map(async (workspaceId) => {
      try {
        if (!options.preserveDocker) {
          await stopDevServer(workspaceId)
        } else {
          // A stop already requested by the user must still finish.
          const stopping = stoppingProcesses.get(workspaceId)
          if (stopping) {
            await stopping
            return
          }
          const hadProcess = trackedProcesses.has(workspaceId)
          await stopTrackedProcess(workspaceId)
          const workspace = getWorkspace(workspaceId)
          // Preserve Docker state; getStatus re-inspects Compose after restart.
          if (hadProcess && workspace && !resolveInstance(workspace.projectPath, workspace.workingBranch)) {
            updateDevServerStatus(workspaceId, 'stopped')
          }
        }
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
