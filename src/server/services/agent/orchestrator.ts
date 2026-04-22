import { readFileSync, writeFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/index.js'
import {
  ensureKoboHome,
  getCompiledMcpServerPath,
  getDbPath,
  getKoboHome,
  getMcpServerSourcePath,
  getSettingsPath,
  getSkillsPath,
} from '../../utils/paths.js'
import { unregisterProcess } from '../../utils/process-tracker.js'
import { getEffectiveSettings } from '../settings-service.js'
import * as wakeupService from '../wakeup-service.js'
import { emitEphemeral } from '../websocket-service.js'
import { getWorkspace as getWs, markWorkspaceUnread, updateWorkspaceStatus } from '../workspace-service.js'
import { resolveEngine } from './engines/registry.js'
import type { AgentEvent, McpServerSpec, StartOptions } from './engines/types.js'
import { routeEvent } from './event-router.js'
import { SessionController } from './session-controller.js'

// ── Types ──────────────────────────────────────────────────────────────────────

/** The value returned synchronously from startAgent — mirrors today's shape. */
export interface StartAgentResult {
  agentSessionId: string
  /** Always undefined immediately — pid becomes available after engine.start resolves. */
  pid: number | undefined
}

// ── State ──────────────────────────────────────────────────────────────────────

/** Actual bound port of the running backend — set at startup via setBackendPort() */
let backendPort: number = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000

/** Called from index.ts once the HTTP server is listening so MCP children can reach it. */
export function setBackendPort(port: number): void {
  backendPort = port
}

/** workspaceId -> SessionController */
const controllers = new Map<string, SessionController>()

/** workspaceId -> last engine session ID (for resume) */
const sessionIds = new Map<string, string>()

/** Cached list of available slash commands — persisted to <KOBO_HOME>/skills.json */
let availableSkills: string[] = (() => {
  try {
    const data = JSON.parse(readFileSync(getSkillsPath(), 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
})()

/** workspaceId -> retry count (for quota backoff) */
const retryCounts = new Map<string, number>()

/** workspaceId -> backoff timer */
const backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Watchdog ──────────────────────────────────────────────────────────────────

const WATCHDOG_INTERVAL_MS = 30_000

let watchdogTimer: ReturnType<typeof setInterval> | null = null

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runWatchdog(): void {
  for (const [workspaceId, ctrl] of controllers) {
    const pid = ctrl.pid
    if (pid === undefined || isProcessAlive(pid)) continue

    console.error(`[watchdog] Agent process for workspace '${workspaceId}' (PID ${pid}) is dead — cleaning up`)

    // Emit an error + session:ended AgentEvent pair so clients can react uniformly
    try {
      routeEvent(workspaceId, ctrl.agentSessionId, {
        kind: 'error',
        category: 'other',
        message: 'Agent process died unexpectedly',
      })
      routeEvent(workspaceId, ctrl.agentSessionId, {
        kind: 'session:ended',
        reason: 'killed',
        exitCode: null,
      })
    } catch (err) {
      console.warn('[watchdog] Failed to route death notification events:', err)
    }

    unregisterProcess(workspaceId)
    if (controllers.get(workspaceId) === ctrl) controllers.delete(workspaceId)
    retryCounts.delete(workspaceId)

    try {
      const db = getDb()
      db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?').run(
        'error',
        new Date().toISOString(),
        ctrl.agentSessionId,
      )
    } catch (err) {
      console.error('[watchdog] Failed to update agent_sessions:', err)
    }

    try {
      updateWorkspaceStatus(workspaceId, 'error')
    } catch (err) {
      console.warn('[watchdog] Failed to transition workspace to error (likely invalid transition):', err)
    }

    try {
      markWorkspaceUnread(workspaceId)
      emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
    } catch (err) {
      console.warn('[watchdog] Failed to mark workspace unread:', err)
    }
  }
}

/**
 * On server start, any `agent_sessions` row still in `running` status is
 * necessarily orphaned — the process that owned it died with the previous
 * server run. Mark those rows as `error` (or `completed` if the PID is
 * somehow still alive and reachable) so the health check stops complaining
 * and the UI doesn't show ghost agents.
 *
 * Called once at boot, BEFORE `startWatchdog`.
 */
export function reconcileOrphanSessions(): void {
  try {
    const db = getDb()
    const rows = db.prepare("SELECT id, pid FROM agent_sessions WHERE status = 'running'").all() as Array<{
      id: string
      pid: number | null
    }>
    if (rows.length === 0) return

    const now = new Date().toISOString()
    const update = db.prepare("UPDATE agent_sessions SET status = 'error', ended_at = ? WHERE id = ?")
    let fixed = 0
    for (const row of rows) {
      if (row.pid && isProcessAlive(row.pid)) continue // genuine leftover from a graceful restart — skip
      update.run(now, row.id)
      fixed++
    }
    if (fixed > 0) {
      console.log(`[orchestrator] Reconciled ${fixed} orphan agent_sessions row(s) at boot.`)
    }
  } catch (err) {
    console.error('[orchestrator] Failed to reconcile orphan agent_sessions at boot:', err)
  }
}

/** Start the watchdog (called once from server bootstrap). */
export function startWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS)
  watchdogTimer.unref?.()
}

/** Stop the watchdog (for clean shutdown / tests). */
export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

// ── Engine + settings helpers ─────────────────────────────────────────────────

function readWorkspaceEngineId(workspaceId: string): string {
  const db = getDb()
  try {
    const row = db
      .prepare<[string], { engine?: string } | undefined>('SELECT engine FROM workspaces WHERE id = ?')
      .get(workspaceId)
    return row?.engine ?? 'claude-code'
  } catch (err) {
    // Guard against a test DB or mid-migration DB where the column doesn't
    // exist yet. Only treat "no such column" as a benign fallback; every
    // other DB error propagates so we don't silently mask real failures.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('no such column: engine')) {
      console.warn(`[orchestrator] 'engine' column missing on workspaces, defaulting to claude-code`)
      return 'claude-code'
    }
    throw err
  }
}

function readEffectiveSettingsSafe(projectPath: string): ReturnType<typeof getEffectiveSettings> {
  try {
    return getEffectiveSettings(projectPath)
  } catch (err) {
    console.warn('[orchestrator] Failed to load settings, using defaults:', err)
    return {
      model: 'claude-opus-4-7',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      notionStatusProperty: '',
      notionInProgressStatus: '',
    }
  }
}

function buildMcpServers(workspaceId: string): McpServerSpec[] {
  const mcpServerCompiled = getCompiledMcpServerPath()
  const mcpServerSource = getMcpServerSourcePath()
  return [
    {
      name: 'kobo-tasks',
      command: mcpServerCompiled ? 'node' : 'npx',
      args: mcpServerCompiled ? [mcpServerCompiled] : ['tsx', mcpServerSource],
      env: {
        KOBO_WORKSPACE_ID: workspaceId,
        KOBO_DB_PATH: getDbPath(),
        KOBO_SETTINGS_PATH: getSettingsPath(),
        KOBO_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      },
    },
  ]
}

// ── DB session row helpers ────────────────────────────────────────────────────

interface AgentSessionRow {
  id: string
  engine_session_id: string | null
}

function resolveSessionForResume(
  workspaceId: string,
  existingSessionId: string | undefined,
): { agentSessionId: string; engineSessionId: string | undefined; existed: boolean } {
  const db = getDb()
  let lastSession: AgentSessionRow | undefined
  if (existingSessionId) {
    lastSession = db
      .prepare(
        'SELECT id, engine_session_id FROM agent_sessions WHERE id = ? AND workspace_id = ? AND engine_session_id IS NOT NULL LIMIT 1',
      )
      .get(existingSessionId, workspaceId) as AgentSessionRow | undefined
    if (!lastSession) {
      throw new Error(
        `Cannot resume session '${existingSessionId}' for workspace '${workspaceId}': ` +
          'session not found or has no associated engine conversation',
      )
    }
  } else {
    lastSession = db
      .prepare(
        'SELECT id, engine_session_id FROM agent_sessions WHERE workspace_id = ? AND engine_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get(workspaceId) as AgentSessionRow | undefined
  }

  const engineSessionId =
    lastSession?.engine_session_id ?? (existingSessionId ? undefined : sessionIds.get(workspaceId))

  if (engineSessionId) {
    const existingId =
      lastSession?.id ??
      (
        db
          .prepare('SELECT id FROM agent_sessions WHERE engine_session_id = ? ORDER BY started_at DESC LIMIT 1')
          .get(engineSessionId) as { id: string } | undefined
      )?.id
    const agentSessionId = existingId ?? nanoid()
    if (existingId) {
      db.prepare('UPDATE agent_sessions SET status = ?, ended_at = NULL WHERE id = ?').run('running', agentSessionId)
    } else {
      db.prepare(
        'INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(agentSessionId, workspaceId, null, 'running', engineSessionId, new Date().toISOString())
    }
    return { agentSessionId, engineSessionId, existed: Boolean(existingId) }
  }

  // No engine session to resume — fall through to fresh session creation
  const agentSessionId = nanoid()
  db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
    agentSessionId,
    workspaceId,
    null,
    'running',
    new Date().toISOString(),
  )
  return { agentSessionId, engineSessionId: undefined, existed: false }
}

function reuseOrCreateFreshSession(workspaceId: string, existingSessionId: string | undefined): string {
  const db = getDb()
  if (existingSessionId) {
    const result = db
      .prepare(
        'UPDATE agent_sessions SET status = ?, started_at = ?, ended_at = NULL WHERE id = ? AND workspace_id = ?',
      )
      .run('running', new Date().toISOString(), existingSessionId, workspaceId)
    if (result.changes === 0) {
      throw new Error(`Agent session '${existingSessionId}' not found for workspace '${workspaceId}'`)
    }
    return existingSessionId
  }
  const agentSessionId = nanoid()
  db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
    agentSessionId,
    workspaceId,
    null,
    'running',
    new Date().toISOString(),
  )
  return agentSessionId
}

// ── Event handler ─────────────────────────────────────────────────────────────

function handleEvent(workspaceId: string, agentSessionId: string, ev: AgentEvent): void {
  routeEvent(workspaceId, agentSessionId, ev)

  if (ev.kind === 'tool:call' && ev.name === 'ScheduleWakeup') {
    const input = ev.input as Record<string, unknown> | undefined
    const delay = typeof input?.delaySeconds === 'number' ? input.delaySeconds : 0
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    const reason = typeof input?.reason === 'string' ? input.reason : undefined
    if (delay > 0 && prompt) {
      wakeupService.schedule(workspaceId, delay, prompt, reason)
    }
  }

  if (ev.kind === 'skills:discovered') {
    availableSkills = ev.skills
    try {
      ensureKoboHome()
      writeFileSync(getSkillsPath(), JSON.stringify(availableSkills))
    } catch (err) {
      console.error('[orchestrator] Failed to persist skills:', err)
    }
  }
  if (ev.kind === 'session:brainstorm-complete') {
    try {
      updateWorkspaceStatus(workspaceId, 'executing')
    } catch (err) {
      console.error('[orchestrator] Failed to transition to executing:', err)
    }
  }
  if (ev.kind === 'error' && ev.category === 'quota') {
    handleQuota(workspaceId, agentSessionId)
  }
  if (ev.kind === 'session:ended') {
    onSessionEnded(workspaceId, agentSessionId, ev.exitCode)
  }
  if (ev.kind === 'session:started' && ev.engineSessionId) {
    sessionIds.set(workspaceId, ev.engineSessionId)
    try {
      const db = getDb()
      db.prepare('UPDATE agent_sessions SET engine_session_id = ? WHERE id = ?').run(ev.engineSessionId, agentSessionId)
    } catch (err) {
      console.error('[orchestrator] Failed to persist engine session id:', err)
    }
    // The workspace must be in an active status while the agent is
    // running — otherwise the frontend's `sessionActive` check stays
    // false and streaming messages render without the "typing" spinner.
    // Transition from a terminal state (completed/idle/error/quota) to
    // executing so the UI reflects that a new turn is happening.
    try {
      const ws = getWs(workspaceId)
      if (ws && (ws.status === 'completed' || ws.status === 'idle' || ws.status === 'error' || ws.status === 'quota')) {
        updateWorkspaceStatus(workspaceId, 'executing')
      }
    } catch (err) {
      // Transition may be invalid for some edge states — best-effort.
      console.warn('[orchestrator] Could not transition workspace to executing on session:started:', err)
    }
  }
}

function onSessionEnded(workspaceId: string, agentSessionId: string, exitCode: number | null): void {
  const ctrl = controllers.get(workspaceId)
  const wasStopping = ctrl?.status === 'stopping'

  // Identity-preserving cleanup: only remove the controller if the map still
  // points to this exact instance (a new controller may have been started in
  // the meantime via stop-then-start).
  if (ctrl && controllers.get(workspaceId) === ctrl) {
    controllers.delete(workspaceId)
  }

  unregisterProcess(workspaceId)
  retryCounts.delete(workspaceId)

  // Update the agent_sessions row
  try {
    const db = getDb()
    db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?').run(
      exitCode === 0 ? 'completed' : 'error',
      new Date().toISOString(),
      agentSessionId,
    )
  } catch (err) {
    console.error('[orchestrator] Failed to update agent_sessions on exit:', err)
  }

  if (wasStopping) {
    // session:ended with reason='killed' already emitted by the engine covers
    // the "stopped" status. No legacy emit needed.
    return
  }

  // Clear any pending backoff timer on non-stopping exits
  const pendingBackoff = backoffTimers.get(workspaceId)
  if (pendingBackoff) {
    clearTimeout(pendingBackoff)
    backoffTimers.delete(workspaceId)
  }

  if (exitCode !== null && exitCode !== 0) {
    try {
      updateWorkspaceStatus(workspaceId, 'error')
    } catch (err) {
      console.error('[orchestrator] Failed to update workspace status on exit:', err)
    }
    try {
      markWorkspaceUnread(workspaceId)
      emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
    } catch {
      // best-effort
    }
  } else {
    try {
      updateWorkspaceStatus(workspaceId, 'completed')
    } catch (err) {
      console.error('[orchestrator] Failed to update workspace status on exit:', err)
    }
    try {
      markWorkspaceUnread(workspaceId)
      emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
    } catch {
      // best-effort
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawn an agent (via the resolved engine) for a workspace. Returns
 * synchronously with the DB agent session id. The PID becomes available only
 * after `engine.start` resolves — callers should subscribe to WS events or
 * query the controller via `_getControllers()` for tests.
 */
export function startAgent(
  workspaceId: string,
  workingDir: string,
  prompt: string,
  model?: string,
  resume = false,
  permissionMode: 'auto-accept' | 'plan' = 'auto-accept',
  existingSessionId?: string,
  reasoningEffort?: string,
): StartAgentResult {
  if (controllers.has(workspaceId)) {
    throw new Error(`Agent already running for workspace '${workspaceId}'`)
  }

  const ws = getWs(workspaceId)
  const engineId = readWorkspaceEngineId(workspaceId)
  const engine = resolveEngine(engineId)

  let agentSessionId: string
  let resumeFromEngineSessionId: string | undefined
  // Note: plan-mode prompt prefixing is an engine-specific concern handled by
  // the Claude Code engine's args-builder. Do NOT prepend it here — that would
  // double-prepend the marker when the engine applies its own prefix.

  if (resume) {
    const r = resolveSessionForResume(workspaceId, existingSessionId)
    agentSessionId = r.agentSessionId
    resumeFromEngineSessionId = r.engineSessionId
  } else {
    agentSessionId = reuseOrCreateFreshSession(workspaceId, existingSessionId)
  }

  const settings = ws ? readEffectiveSettingsSafe(ws.projectPath) : readEffectiveSettingsSafe(workingDir)

  const options: StartOptions = {
    workspaceId,
    workingDir,
    prompt,
    model,
    effort: reasoningEffort,
    permissionMode,
    resumeFromEngineSessionId,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    koboHome: (() => {
      try {
        return getKoboHome()
      } catch {
        return ''
      }
    })(),
    settings,
    mcpServers: buildMcpServers(workspaceId),
  }

  const controller = new SessionController(workspaceId, agentSessionId, engine, (ev) =>
    handleEvent(workspaceId, agentSessionId, ev),
  )
  controllers.set(workspaceId, controller)

  // "Agent running" is signalled via the engine's session:started event.
  // The legacy `agent:status { status: 'executing' }` emit is gone.

  // Kick off engine.start asynchronously. Errors surface as error events.
  void controller
    .start(options)
    .then(() => {
      const pid = controller.pid
      if (pid !== undefined) {
        try {
          const db = getDb()
          db.prepare('UPDATE agent_sessions SET pid = ? WHERE id = ?').run(pid, agentSessionId)
        } catch (err) {
          console.error('[orchestrator] Failed to update pid:', err)
        }
      }
    })
    .catch((err) => {
      console.error('[orchestrator] engine.start failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      handleEvent(workspaceId, agentSessionId, {
        kind: 'error',
        category: 'spawn_failed',
        message,
      })
      handleEvent(workspaceId, agentSessionId, {
        kind: 'session:ended',
        reason: 'error',
        exitCode: null,
      })
    })

  return { agentSessionId, pid: undefined }
}

/**
 * Soft-interrupt the running agent by sending SIGINT. The session remains
 * alive — the current tool call is aborted and the agent waits for the next
 * user message.
 */
export function interruptAgent(workspaceId: string): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  try {
    ctrl.interrupt()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to interrupt agent for workspace '${workspaceId}': ${message}`)
  }
}

/** Gracefully stop an agent (the engine handles SIGTERM + SIGKILL). */
export function stopAgent(workspaceId: string): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }

  wakeupService.cancel(workspaceId, 'stopped')

  // Remove from the map immediately so startAgent can proceed right away.
  // The session:ended handler checks identity before removing, so a new
  // controller started in the meantime is preserved.
  controllers.delete(workspaceId)

  const timer = backoffTimers.get(workspaceId)
  if (timer) {
    clearTimeout(timer)
    backoffTimers.delete(workspaceId)
  }

  // Fire-and-forget: controller.stop is async but we don't block callers.
  void ctrl.stop().catch((err) => {
    console.error('[orchestrator] controller.stop failed:', err)
  })
}

/** Write a user message to the running agent. */
export function sendMessage(workspaceId: string, content: string): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  wakeupService.cancel(workspaceId, 'user-message')
  ctrl.sendMessage(content)
}

/** In-memory status of the agent for a workspace, or null if not running. */
export function getAgentStatus(workspaceId: string): 'running' | 'stopping' | null {
  return controllers.get(workspaceId)?.status ?? null
}

/** True when an agent controller is currently running for the workspace. */
export function hasController(workspaceId: string): boolean {
  return controllers.has(workspaceId)
}

/** Number of currently running controllers. */
export function getRunningCount(): number {
  return controllers.size
}

/** Kobo built-in slash commands injected into the skill list (without leading /). */
const KOBO_COMMANDS = ['kobo-check-progress']

/** Cached list of slash commands discovered from the last agent init, plus Kobo built-ins. */
export function getAvailableSkills(): string[] {
  return [...KOBO_COMMANDS, ...availableSkills]
}

// ── Quota handling ────────────────────────────────────────────────────────────

function handleQuota(workspaceId: string, _agentSessionId?: string): void {
  try {
    updateWorkspaceStatus(workspaceId, 'quota')
  } catch {
    // May fail if transition is not valid
  }

  // The quota state is already signalled by the `error { category: 'quota' }`
  // AgentEvent that triggered this handler. No legacy `agent:status { quota }`
  // emit needed.

  // 15min first, then 30min, then 60min cap
  const retryCount = retryCounts.get(workspaceId) ?? 0
  const backoffMinutes = Math.min(15 * 2 ** retryCount, 60)
  const backoffMs = backoffMinutes * 60 * 1000

  retryCounts.set(workspaceId, retryCount + 1)

  // Surface the backoff schedule as an ephemeral event so the UI can display
  // retry count / wait time without polluting the persistent event log.
  emitEphemeral(workspaceId, 'agent:quota-backoff', {
    retryCount: retryCount + 1,
    backoffMinutes,
  })

  const timer = setTimeout(() => {
    backoffTimers.delete(workspaceId)

    if (!controllers.has(workspaceId)) {
      const freshWs = getWs(workspaceId)
      if (!freshWs || freshWs.archivedAt !== null || freshWs.status !== 'quota') {
        return
      }
      try {
        const freshWorkingDir = `${freshWs.projectPath}/.worktrees/${freshWs.workingBranch}`
        startAgent(workspaceId, freshWorkingDir, 'Continue the previous task where you left off.', undefined, true)
      } catch (err) {
        console.error(`[orchestrator] Quota retry for workspace '${workspaceId}' failed:`, err)
        const msg = err instanceof Error ? err.message : String(err)
        try {
          updateWorkspaceStatus(workspaceId, 'error')
        } catch {
          // transition may not be valid
        }
        routeEvent(workspaceId, '', {
          kind: 'error',
          category: 'other',
          message: `Quota retry failed: ${msg}`,
        })
      }
    }
  }, backoffMs)

  timer.unref?.()
  backoffTimers.set(workspaceId, timer)
}

// ── Testing utilities ─────────────────────────────────────────────────────────

/** @internal test-only */
export function _getControllers(): Map<string, SessionController> {
  return controllers
}

/** @internal test-only */
export function _getRetryCounts(): Map<string, number> {
  return retryCounts
}

/** @internal test-only */
export function _getBackoffTimers(): Map<string, ReturnType<typeof setTimeout>> {
  return backoffTimers
}

/** @internal test-only */
export function _getSessionIds(): Map<string, string> {
  return sessionIds
}

/** @internal test-only — runs a single watchdog sweep synchronously. */
export function _runWatchdogForTest(): void {
  runWatchdog()
}

/** Test-only export. Not part of the public module API. */
export const __test__ = { handleEvent }
