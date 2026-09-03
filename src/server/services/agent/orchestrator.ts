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
import * as autoLoopService from '../auto-loop-service.js'
import * as cleanupScriptService from '../cleanup-script-service.js'
import * as cronService from '../cron-service.js'
import { resolveForge } from '../forge/resolve.js'
import * as quotaBackoffService from '../quota-backoff-service.js'
import { getEffectiveSettings, getGlobalSettings } from '../settings-service.js'
import { refreshNow } from '../usage/poller.js'
import * as wakeupService from '../wakeup-service.js'
import { emit, emitEphemeral } from '../websocket-service.js'
import * as permissionPolicyService from '../workspace-permission-policy-service.js'
import {
  getWorkspace as getWs,
  markWorkspaceUnread,
  updateWorkspaceStatus,
  type WorkspaceStatus,
} from '../workspace-service.js'
import { resolveEngine } from './engines/registry.js'
import {
  AGENT_NO_LONGER_RUNNING_TEXT,
  type AgentEvent,
  type McpServerSpec,
  type RateLimitInfo,
  type StartOptions,
} from './engines/types.js'
import { routeEvent } from './event-router.js'
import { SessionController } from './session-controller.js'

// ── Types ──────────────────────────────────────────────────────────────────────

/** The value returned synchronously from startAgent — mirrors today's shape. */
export interface StartAgentResult {
  agentSessionId: string
  /** Always undefined immediately — pid becomes available after engine.start resolves. */
  pid: number | undefined
}

export interface InterruptAgentOptions {
  expectedSessionId?: string
  disableAutoLoop?: boolean
}

export type InterruptAgentErrorCode = 'no_agent_running' | 'session_not_active' | 'interrupt_failed'

export class InterruptAgentError extends Error {
  constructor(
    message: string,
    readonly code: InterruptAgentErrorCode,
  ) {
    super(message)
    this.name = 'InterruptAgentError'
  }
}

// ── State ──────────────────────────────────────────────────────────────────────

/** Actual bound port of the running backend — set at startup via setBackendPort() */
let backendPort: number = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000

/** Called from index.ts once the HTTP server is listening so MCP children can reach it. */
export function setBackendPort(port: number): void {
  backendPort = port
}

/** Current bound port of the running backend. */
export function getBackendPort(): number {
  return backendPort
}

/** workspaceId -> SessionController */
const controllers = new Map<string, SessionController>()

interface SessionLifecycleOwnership {
  owner: SessionController
  ownerEnded: boolean
  supersededControllers: Set<SessionController>
}

/**
 * Latest controller generation per persisted session row. A resumed run can
 * reuse an agentSessionId while its predecessor is still draining events, so
 * controller-map membership alone is not a durable ownership signal.
 */
const sessionLifecycleOwners = new Map<string, Map<string, SessionLifecycleOwnership>>()

function registerSessionLifecycleOwner(
  workspaceId: string,
  agentSessionId: string,
  controller: SessionController,
): void {
  const workspaceOwners = sessionLifecycleOwners.get(workspaceId) ?? new Map<string, SessionLifecycleOwnership>()
  const existing = workspaceOwners.get(agentSessionId)
  if (existing) {
    if (!existing.ownerEnded) existing.supersededControllers.add(existing.owner)
    existing.owner = controller
    existing.ownerEnded = false
  } else {
    workspaceOwners.set(agentSessionId, {
      owner: controller,
      ownerEnded: false,
      supersededControllers: new Set(),
    })
  }
  sessionLifecycleOwners.set(workspaceId, workspaceOwners)
}

function getSessionLifecycleOwnership(
  workspaceId: string,
  agentSessionId: string,
): SessionLifecycleOwnership | undefined {
  return sessionLifecycleOwners.get(workspaceId)?.get(agentSessionId)
}

function deleteSessionLifecycleOwnershipIfSettled(workspaceId: string, agentSessionId: string): void {
  const workspaceOwners = sessionLifecycleOwners.get(workspaceId)
  const ownership = workspaceOwners?.get(agentSessionId)
  if (!workspaceOwners || !ownership?.ownerEnded || ownership.supersededControllers.size > 0) return
  workspaceOwners.delete(agentSessionId)
  if (workspaceOwners.size === 0) sessionLifecycleOwners.delete(workspaceId)
}

function markSessionLifecycleOwnerEnded(
  workspaceId: string,
  agentSessionId: string,
  controller: SessionController | undefined,
): void {
  const ownership = getSessionLifecycleOwnership(workspaceId, agentSessionId)
  if (!controller || !ownership || ownership.owner !== controller) return
  ownership.ownerEnded = true
  deleteSessionLifecycleOwnershipIfSettled(workspaceId, agentSessionId)
}

function settleSupersededSessionController(
  workspaceId: string,
  agentSessionId: string,
  controller: SessionController,
): void {
  const ownership = getSessionLifecycleOwnership(workspaceId, agentSessionId)
  if (!ownership) return
  ownership.supersededControllers.delete(controller)
  deleteSessionLifecycleOwnershipIfSettled(workspaceId, agentSessionId)
}

export const FALLBACK_CONTROLLER_TURNOVER_TIMEOUT_MS = 2_000
export const FALLBACK_CONTROLLER_TURNOVER_POLL_MS = 25

/** workspaceId -> last engine session ID (for resume) */
const sessionIds = new Map<string, string>()

/**
 * A pending item is either an AskUserQuestion (kind: 'question') or an
 * interactive permission request (kind: 'permission'). Items are queued
 * FIFO per workspace; the head is what the UI surfaces.
 */
export type PendingItem =
  | { kind: 'question'; agentSessionId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'permission'; agentSessionId: string; toolCallId: string; toolName: string; toolInput: unknown }

/** workspaceId -> FIFO queue of pending items */
const pendingQueue = new Map<string, PendingItem[]>()

/**
 * workspaceId -> the workspace status held BEFORE we transitioned to
 * `awaiting-user` because the SDK is awaiting an answer via canUseTool.
 * Restored when the user answers so an agent paused mid-`brainstorming`
 * returns to that status instead of being yanked to `executing`.
 */
const preAwaitStatus = new Map<string, WorkspaceStatus>()

function enqueuePending(workspaceId: string, item: PendingItem): void {
  const arr = pendingQueue.get(workspaceId) ?? []
  arr.push(item)
  pendingQueue.set(workspaceId, arr)
}

function peekPending(workspaceId: string): PendingItem | undefined {
  return pendingQueue.get(workspaceId)?.[0]
}

function dequeuePending(workspaceId: string): PendingItem | undefined {
  const arr = pendingQueue.get(workspaceId)
  if (!arr || arr.length === 0) return undefined
  const head = arr.shift()
  if (arr.length === 0) pendingQueue.delete(workspaceId)
  return head
}

/**
 * Remove persisted `session:user-input-requested` events for a given
 * toolCallId from `ws_events`, so a future F5 / WS reconnect doesn't
 * resurrect a question the user has already answered or cancelled.
 */
function purgePersistedUserInputRequest(workspaceId: string, toolCallId: string): void {
  try {
    const db = getDb()
    db.prepare(
      `DELETE FROM ws_events
       WHERE workspace_id = ?
         AND type = 'agent:event'
         AND json_extract(payload, '$.kind') = 'session:user-input-requested'
         AND json_extract(payload, '$.toolCallId') = ?`,
    ).run(workspaceId, toolCallId)
  } catch (err) {
    console.error('[orchestrator] Failed to purge persisted user-input-requested:', err)
  }
}

/**
 * Remove every persisted `session:user-input-requested` event tied to a
 * specific session — used when the session is killed (stopAgent / archive /
 * delete) so a future F5 doesn't resurrect panels that no longer have a live
 * canUseTool callback to resolve.
 */
function purgeAllPersistedUserInputRequests(workspaceId: string, agentSessionId: string): void {
  try {
    const db = getDb()
    db.prepare(
      `DELETE FROM ws_events
       WHERE workspace_id = ?
         AND session_id = ?
         AND type = 'agent:event'
         AND json_extract(payload, '$.kind') = 'session:user-input-requested'`,
    ).run(workspaceId, agentSessionId)
  } catch (err) {
    console.error('[orchestrator] Failed to purge persisted user-input-requested (session-wide):', err)
  }
}

/**
 * Snapshot the workspace's current status so that on resolve we can restore
 * it. Idempotent: when called while already in `awaiting-user` we keep the
 * FIRST pre-await status (defensive against multiple requests before reply).
 */
function rememberPreAwaitStatus(workspaceId: string): void {
  if (preAwaitStatus.has(workspaceId)) return
  const ws = getWs(workspaceId)
  if (!ws) return
  if (ws.status === 'awaiting-user') return
  preAwaitStatus.set(workspaceId, ws.status)
}

/**
 * Pop the snapshotted status from the pre-await map. Returns `'executing'`
 * if no snapshot exists — that's the safe default for a session that started
 * in `executing` and asked the user immediately.
 */
function consumePreAwaitStatus(workspaceId: string): WorkspaceStatus {
  const remembered = preAwaitStatus.get(workspaceId)
  preAwaitStatus.delete(workspaceId)
  return remembered ?? 'executing'
}

function clearPendingForSession(workspaceId: string, agentSessionId: string): void {
  const arr = pendingQueue.get(workspaceId)
  if (arr) {
    const filtered = arr.filter((item) => item.agentSessionId !== agentSessionId)
    if (filtered.length === 0) pendingQueue.delete(workspaceId)
    else pendingQueue.set(workspaceId, filtered)
  }
  if (!pendingQueue.has(workspaceId)) {
    preAwaitStatus.delete(workspaceId)
  }
}

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

/** Tracks agent sessions that failed due to a stale --resume session ID. */
const resumeFailedSessions = new Map<string, Set<string>>()

// ── Watchdog ──────────────────────────────────────────────────────────────────

const WATCHDOG_INTERVAL_MS = 30_000

let watchdogTimer: ReturnType<typeof setInterval> | null = null

/**
 * Grace window for a controller whose `engine.start` has not resolved yet.
 * `engineProcess` is undefined during that window, so there is no probe to
 * call — and concluding "dead" from a missing pid is exactly the dormant bug
 * that would kill every new session the day the start path becomes blocking.
 */
const CONTROLLER_STARTUP_GRACE_MS = 60_000

function runWatchdog(): void {
  for (const [workspaceId, ctrl] of controllers) {
    // D1 — a controller already in `stopping` state is being torn down by
    // `stopController`/`stopAgentAndWait`, which has its own bounded deadline
    // (STOP_AGENT_TIMEOUT_MS) and its own eviction path once that deadline
    // passes. Before D1 this branch could never see a stopping controller —
    // the entry was removed from `controllers` synchronously, before
    // `ctrl.stop()` was even awaited. Now that the entry survives the whole
    // stop, a slow-but-honest voluntary stop (the engine's iterator already
    // closed, `isAlive()` already reporting `false`, well within the 15s
    // window) must not be raced here: doing so would report a false "Agent
    // process died unexpectedly", force the workspace to `error`, and set an
    // unread badge — all on a stop the user explicitly asked for.
    if (ctrl.status === 'stopping') continue

    const ep = ctrl.engineProcess

    if (!ep) {
      // engine.start is still in flight — stay silent until the grace window
      // closes, then treat a controller that never produced a process as dead.
      if (Date.now() - ctrl.startedAt < CONTROLLER_STARTUP_GRACE_MS) continue
      console.error(
        `[watchdog] Controller for workspace '${workspaceId}' produced no engine process within ${CONTROLLER_STARTUP_GRACE_MS}ms — cleaning up`,
      )
    } else {
      // D1 — the pid is never a liveness criterion. The Claude engine exposes
      // none, and a pid recycled after a machine restart reads as alive. An
      // engine that cannot answer is presumed alive: only an explicit `false`
      // triggers the cleanup below.
      if (ep.isAlive?.() !== false) continue
      console.error(`[watchdog] Agent engine for workspace '${workspaceId}' reports dead — cleaning up`)
    }

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
 * Boot-time reconciliation. D1 — the `controllers` map is THE liveness source
 * of truth, and it is empty by definition at this point: every row implying a
 * live agent is therefore orphaned, unconditionally, with no probe to run.
 *
 * The former `isProcessAlive(row.pid)` guard was wrong in both directions. The
 * Claude engine never exposes a pid, so the column stayed NULL and the probe
 * never ran for the default engine. And after a machine restart, a pid
 * recycled by an unrelated program read as "still alive" — pinning the session
 * as running forever, with no controller and no watchdog to ever clean it up.
 *
 * Called once at boot, BEFORE `startWatchdog`.
 */
export function reconcileOrphanSessions(): void {
  const now = new Date().toISOString()

  try {
    const db = getDb()
    const result = db
      .prepare("UPDATE agent_sessions SET status = 'error', ended_at = ? WHERE status = 'running'")
      .run(now)
    if (result.changes > 0) {
      console.log(`[orchestrator] Reconciled ${result.changes} orphan agent_sessions row(s) at boot.`)
    }
  } catch (err) {
    console.error('[orchestrator] Failed to reconcile orphan agent_sessions at boot:', err)
  }

  // Same reasoning for the workspaces themselves: a status that implies a live
  // agent has no controller left to drive it, so the UI would show "the agent
  // is busy" forever with the chat input disabled.
  //
  // Raw SQL on purpose: `updateWorkspaceStatus` lives in a module that forms a
  // cycle with this one and may not be initialised this early. Every
  // transition performed here (executing / brainstorming / extracting /
  // awaiting-user → idle) is allowed by VALID_TRANSITIONS anyway.
  try {
    const db = getDb()
    const result = db
      .prepare(
        `UPDATE workspaces SET status = 'idle', updated_at = ?
          WHERE status IN ('executing', 'brainstorming', 'extracting', 'awaiting-user')`,
      )
      .run(now)
    if (result.changes > 0) {
      console.log(`[orchestrator] Reconciled ${result.changes} orphan workspace status(es) at boot.`)
    }
  } catch (err) {
    console.error('[orchestrator] Failed to reconcile orphan workspace statuses at boot:', err)
  }

  // The dev-server children died with the previous server run too, so a
  // `running` / `starting` column is exactly as false as an orphan agent
  // status — and the health page counts it.
  try {
    const db = getDb()
    const result = db
      .prepare(
        `UPDATE workspaces SET dev_server_status = 'stopped', updated_at = ?
          WHERE dev_server_status IN ('running', 'starting')`,
      )
      .run(now)
    if (result.changes > 0) {
      console.log(`[orchestrator] Reconciled ${result.changes} orphan dev_server_status value(s) at boot.`)
    }
  } catch (err) {
    console.error('[orchestrator] Failed to reconcile dev_server_status at boot:', err)
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
      model: 'auto',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      reviewPromptTemplate: '',
      ciFixPromptTemplate: '',
      notionInitialPromptTemplate: '',
      sentryInitialPromptTemplate: '',
      gitConventions: '',
      sourceBranch: 'main',
      devServer: null,
      setupScript: '',
      cleanupScript: '',
      cleanupScriptMode: 'no-tasks',
      cleanupScriptOnlyOnChanges: false,
      archiveScript: '',
      changeSourceBranchScript: '',
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

function isBitbucketProject(projectPath: string): boolean {
  try {
    return resolveForge(projectPath) === 'bitbucket-community'
  } catch {
    return false
  }
}

function buildAgentEnv(projectPath: string): NodeJS.ProcessEnv | undefined {
  if (!isBitbucketProject(projectPath)) return undefined
  const global = getGlobalSettings()
  if (!global.bitbucketToken) return undefined
  return {
    ...process.env,
    BKT_HOST: 'https://bitbucket.org',
    BKT_TOKEN: global.bitbucketToken,
    BKT_USERNAME: global.bitbucketUsername,
  }
}

function buildAgentPrompt(prompt: string, projectPath: string | undefined): string {
  if (!projectPath || !isBitbucketProject(projectPath)) return prompt
  return [
    '[Kōbō Bitbucket] Bitbucket credentials are available through the `bkt` CLI in this session.',
    'Use `bkt pr edit <number> --body <description>` and `bkt pr comment <number> --body <comment>` for PR updates.',
    'Do not call the Bitbucket REST API with curl or reuse BKT_TOKEN as a Bearer token: Bitbucket Cloud API tokens require the bkt CLI authentication flow.',
    '',
    prompt,
  ].join('\n')
}

// ── DB session row helpers ────────────────────────────────────────────────────

interface AgentSessionRow {
  id: string
  engine_session_id: string | null
  engine: string | null
}

function resolveSessionForResume(
  workspaceId: string,
  existingSessionId: string | undefined,
  model: string | undefined,
): { agentSessionId: string; engineSessionId: string | undefined; existed: boolean } {
  const db = getDb()
  let lastSession: AgentSessionRow | undefined
  if (existingSessionId) {
    lastSession = db
      .prepare(
        'SELECT id, engine_session_id, engine FROM agent_sessions WHERE id = ? AND workspace_id = ? AND engine_session_id IS NOT NULL LIMIT 1',
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
        'SELECT id, engine_session_id, engine FROM agent_sessions WHERE workspace_id = ? AND engine_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
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
      db.prepare('UPDATE agent_sessions SET status = ?, ended_at = NULL, model = ? WHERE id = ?').run(
        'running',
        model ?? null,
        agentSessionId,
      )
    } else {
      db.prepare(
        'INSERT INTO agent_sessions (id, workspace_id, pid, status, engine_session_id, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(agentSessionId, workspaceId, null, 'running', engineSessionId, model ?? null, new Date().toISOString())
    }
    return { agentSessionId, engineSessionId, existed: Boolean(existingId) }
  }

  // No engine session to resume — fall through to fresh session creation
  const agentSessionId = nanoid()
  db.prepare(
    'INSERT INTO agent_sessions (id, workspace_id, pid, status, model, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(agentSessionId, workspaceId, null, 'running', model ?? null, new Date().toISOString())
  return { agentSessionId, engineSessionId: undefined, existed: false }
}

function reuseOrCreateFreshSession(
  workspaceId: string,
  existingSessionId: string | undefined,
  model: string | undefined,
  engine: string,
): string {
  const db = getDb()
  if (existingSessionId) {
    const result = db
      .prepare(
        'UPDATE agent_sessions SET status = ?, started_at = ?, ended_at = NULL, model = ?, engine = ? WHERE id = ? AND workspace_id = ?',
      )
      .run('running', new Date().toISOString(), model ?? null, engine, existingSessionId, workspaceId)
    if (result.changes === 0) {
      throw new Error(`Agent session '${existingSessionId}' not found for workspace '${workspaceId}'`)
    }
    return existingSessionId
  }
  const agentSessionId = nanoid()
  db.prepare(
    'INSERT INTO agent_sessions (id, workspace_id, pid, engine, status, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(agentSessionId, workspaceId, null, engine, 'running', model ?? null, new Date().toISOString())
  return agentSessionId
}

// ── Event handler ─────────────────────────────────────────────────────────────

/**
 * Snapshots of task completion and task state at `session:started`, read back
 * at `session:ended` for auto-loop stall detection. A task moved to
 * `in_progress` is meaningful progress even if it is not done yet.
 */
interface TaskProgressSnapshot {
  doneCount: number
  stateSignature: string
}

const taskProgressSnapshots = new Map<string, Map<string, TaskProgressSnapshot>>()

function createTaskProgressSnapshot(workspaceId: string): TaskProgressSnapshot {
  return {
    doneCount: getDoneTaskCount(workspaceId),
    stateSignature: getTaskStateSignature(workspaceId),
  }
}

function rememberTaskProgressSnapshot(
  workspaceId: string,
  agentSessionId: string,
  snapshot: TaskProgressSnapshot = createTaskProgressSnapshot(workspaceId),
): void {
  const workspaceSnapshots = taskProgressSnapshots.get(workspaceId) ?? new Map<string, TaskProgressSnapshot>()
  workspaceSnapshots.set(agentSessionId, snapshot)
  taskProgressSnapshots.set(workspaceId, workspaceSnapshots)
}

function parseTaskProgressSnapshot(value: string | null): TaskProgressSnapshot | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<TaskProgressSnapshot>
    if (typeof parsed.doneCount !== 'number' || typeof parsed.stateSignature !== 'string') return undefined
    return { doneCount: parsed.doneCount, stateSignature: parsed.stateSignature }
  } catch {
    return undefined
  }
}

function captureTaskProgressBaseline(workspaceId: string, agentSessionId: string): void {
  const snapshot = createTaskProgressSnapshot(workspaceId)
  rememberTaskProgressSnapshot(workspaceId, agentSessionId, snapshot)
  try {
    getDb()
      .prepare('UPDATE agent_sessions SET task_progress_baseline = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), agentSessionId)
  } catch (err) {
    console.warn('[orchestrator] Failed to persist task progress baseline:', err)
  }
}

function ensureTaskProgressBaseline(workspaceId: string, agentSessionId: string): void {
  if (taskProgressSnapshots.get(workspaceId)?.has(agentSessionId)) return
  try {
    const row = getDb().prepare('SELECT task_progress_baseline FROM agent_sessions WHERE id = ?').get(agentSessionId) as
      | { task_progress_baseline: string | null }
      | undefined
    if (row?.task_progress_baseline) return
  } catch {
    // The in-memory fallback below is still useful in narrow unit-test and
    // bootstrap windows where the persisted session row is unavailable.
  }
  captureTaskProgressBaseline(workspaceId, agentSessionId)
}

function consumeTaskProgressSnapshot(workspaceId: string, agentSessionId: string): TaskProgressSnapshot | undefined {
  const workspaceSnapshots = taskProgressSnapshots.get(workspaceId)
  const memorySnapshot = workspaceSnapshots?.get(agentSessionId)
  workspaceSnapshots?.delete(agentSessionId)
  if (workspaceSnapshots?.size === 0) taskProgressSnapshots.delete(workspaceId)

  try {
    const db = getDb()
    const readAndClear = db.transaction((id: string) => {
      const row = db.prepare('SELECT task_progress_baseline FROM agent_sessions WHERE id = ?').get(id) as
        | { task_progress_baseline: string | null }
        | undefined
      db.prepare('UPDATE agent_sessions SET task_progress_baseline = NULL WHERE id = ?').run(id)
      return row?.task_progress_baseline ?? null
    })
    const persistedSnapshot = parseTaskProgressSnapshot(readAndClear(agentSessionId))
    if (persistedSnapshot) return persistedSnapshot
  } catch (err) {
    console.warn('[orchestrator] Failed to consume task progress baseline:', err)
  }
  return memorySnapshot
}

function rememberResumeFailed(workspaceId: string, agentSessionId: string): void {
  const workspaceSessions = resumeFailedSessions.get(workspaceId) ?? new Set<string>()
  workspaceSessions.add(agentSessionId)
  resumeFailedSessions.set(workspaceId, workspaceSessions)
}

function consumeResumeFailed(workspaceId: string, agentSessionId: string): boolean {
  const workspaceSessions = resumeFailedSessions.get(workspaceId)
  const hadResumeFailure = workspaceSessions?.delete(agentSessionId) ?? false
  if (workspaceSessions?.size === 0) resumeFailedSessions.delete(workspaceId)
  return hadResumeFailure
}

function getDoneTaskCount(workspaceId: string): number {
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = ?')
      .get(workspaceId, 'done') as { c: number }
    return row.c
  } catch (err) {
    // Best-effort: DB closed during async teardown, or missing schema. Fall back
    // to 0 so auto-loop's done-delta stays correct (no progress).
    console.warn('[orchestrator] getDoneTaskCount failed, returning 0:', err)
    return 0
  }
}

function getTaskStateSignature(workspaceId: string): string {
  try {
    const db = getDb()
    const rows = db
      .prepare('SELECT id, status, updated_at FROM tasks WHERE workspace_id = ? ORDER BY id')
      .all(workspaceId) as Array<{ id: string; status: string; updated_at: string }>
    return JSON.stringify(rows)
  } catch (err) {
    console.warn('[orchestrator] getTaskStateSignature failed, returning empty state:', err)
    return ''
  }
}

/** Clear the in-memory done-count snapshot for a workspace (called on delete). */
export function forgetTasksDoneSnapshot(workspaceId: string): void {
  taskProgressSnapshots.delete(workspaceId)
}

/** Drop the resume-failed flag for a workspace (called on delete). */
export function forgetResumeFailed(workspaceId: string): void {
  resumeFailedSessions.delete(workspaceId)
}

/** Drop the pending question/permission queue for a workspace (called on delete). */
export function forgetPendingQueue(workspaceId: string): void {
  pendingQueue.delete(workspaceId)
}

/** Drop the pre-await status snapshot for a workspace (called on delete). */
export function forgetPreAwaitStatus(workspaceId: string): void {
  preAwaitStatus.delete(workspaceId)
}

/** Drop the cached engine session id for a workspace (called on delete). */
export function forgetSessionId(workspaceId: string): void {
  sessionIds.delete(workspaceId)
  sessionLifecycleOwners.delete(workspaceId)
}

function handleEvent(
  workspaceId: string,
  agentSessionId: string,
  sourceController: SessionController | undefined,
  ev: AgentEvent,
): void {
  const registeredController = controllers.get(workspaceId)
  const hasReplacement =
    sourceController !== undefined && registeredController !== undefined && registeredController !== sourceController
  const sourceNoLongerOwnsWorkspace = sourceController !== undefined && registeredController !== sourceController
  const lifecycleOwnership = getSessionLifecycleOwnership(workspaceId, agentSessionId)
  const sourceIsSuperseded =
    sourceController !== undefined &&
    lifecycleOwnership !== undefined &&
    lifecycleOwnership.owner !== sourceController &&
    lifecycleOwnership.supersededControllers.has(sourceController)

  // An EVICTED controller (replaced, or timed out past STOP_AGENT_TIMEOUT_MS)
  // can continue draining buffered engine events after it has lost ownership.
  // Drop every stale non-terminal event before it reaches persistence/live
  // delivery, including the gap where no replacement is registered yet. A
  // terminal event still records session-local history; it carries a durable
  // marker only when a different controller now owns the workspace, or when
  // the latest owner already ended, so replay does not depend on transient
  // browser state.
  //
  // This does NOT cover the `stopping` window (D1): a controller mid-stop
  // stays registered as its own workspace's owner, so its events are real and
  // reach persistence/delivery below unconditionally. What must NOT happen is
  // any side effect that could resurrect the session the user just told to
  // stop — see `sourceControllerIsStopping` further down.
  if (sourceNoLongerOwnsWorkspace && ev.kind !== 'session:ended') return
  // A controller already told to stop (D1) keeps emitting real events until it
  // actually dies — they are persisted and broadcast like any other (see
  // `routeEvent` below, unconditional). But a handful of side effects here
  // would re-arm or re-open a session the user just stopped: a new wakeup, a
  // new cron, a quota/auto-loop backoff, or a status bounce back into
  // `awaiting-user`/`executing`. Every branch that does one of those must
  // check this guard.
  const sourceControllerIsStopping = sourceController?.status === 'stopping'
  const routedEvent =
    ev.kind === 'session:ended' && (hasReplacement || sourceIsSuperseded) ? { ...ev, superseded: true } : ev
  routeEvent(workspaceId, agentSessionId, routedEvent)

  if (ev.kind === 'rate_limit') {
    latestRateLimitInfo.set(workspaceId, ev.info)
  }

  // The normal start path captures this synchronously before engine.start.
  // Keep an idempotent fallback for engines/tests that emit session:started
  // without first going through startAgent.
  if (ev.kind === 'session:started') {
    ensureTaskProgressBaseline(workspaceId, agentSessionId)
  }

  // Legacy fallback: the built-in `ScheduleWakeup` tool (CLI tradition) isn't
  // declared by the SDK, so we intercept the tool:call event and apply the
  // side-effect ourselves. Agents should prefer `kobo__schedule_wakeup` —
  // logged here so we can monitor remaining usage.
  if (ev.kind === 'tool:call' && ev.name === 'ScheduleWakeup') {
    const input = ev.input as Record<string, unknown> | undefined
    const delay = typeof input?.delaySeconds === 'number' ? input.delaySeconds : 0
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    const reason = typeof input?.reason === 'string' ? input.reason : undefined
    if (delay > 0 && prompt && !sourceControllerIsStopping) {
      console.warn(
        `[orchestrator] Legacy ScheduleWakeup intercepted for workspace '${workspaceId}' — agent should use kobo__schedule_wakeup instead.`,
      )
      wakeupService.schedule(workspaceId, delay, prompt, reason, agentSessionId)
    }
  }

  // Same legacy bridge for the SDK's native `CronCreate`. The native tool is
  // session-only (the cron dies when the agent session exits and is not
  // persisted to disk), which makes it useless for any real "schedule a
  // recurring trigger" need. We intercept the tool:call and arm an equivalent
  // kobo cron in parallel — persistent across restarts, owned by the backend.
  if (ev.kind === 'tool:call' && ev.name === 'CronCreate') {
    const input = ev.input as Record<string, unknown> | undefined
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    // The SDK's exact field name has drifted across versions — try the most
    // likely candidates. If none match we log the input shape so the user
    // can extend this list.
    const expression =
      (typeof input?.cron === 'string' && input.cron) ||
      (typeof input?.schedule === 'string' && input.schedule) ||
      (typeof input?.expression === 'string' && input.expression) ||
      ''
    if (prompt && expression) {
      if (!sourceControllerIsStopping) {
        console.warn(
          `[orchestrator] Native CronCreate intercepted for workspace '${workspaceId}' — armed equivalent kobo cron. Prefer kobo__cron_create.`,
        )
        try {
          cronService.arm(workspaceId, {
            expression,
            prompt,
            label: 'from-native-CronCreate',
            agentSessionId,
          })
        } catch (err) {
          console.error('[orchestrator] Failed to mirror native CronCreate as kobo cron:', err)
        }
      }
    } else if (prompt || input) {
      console.warn(
        `[orchestrator] Native CronCreate intercepted but unrecognised input shape (workspace '${workspaceId}'):`,
        Object.keys(input ?? {}),
      )
    }
  }

  // Native `CronDelete` and `CronList` are noisy but harmless to ignore.
  // The native cron is session-only so deletion is moot once the session
  // ends; the kobo equivalents (kobo__cron_delete / kobo__cron_list) are
  // the persistent path. Log to track usage and avoid silent confusion.
  if (ev.kind === 'tool:call' && (ev.name === 'CronDelete' || ev.name === 'CronList')) {
    console.warn(
      `[orchestrator] Native ${ev.name} called on workspace '${workspaceId}' — has no effect on kobo crons. Use kobo__${ev.name === 'CronDelete' ? 'cron_delete' : 'cron_list'} instead.`,
    )
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
  // The `[BRAINSTORM_COMPLETE]` marker is produced by both engine mappers from
  // assistant text, so it can arrive during `stop()`'s own drain — same class
  // of bug as `session:started`'s executing-bounce (D1). The whole block is
  // nothing but this status transition (no separate bookkeeping to preserve),
  // so it is entirely behind the guard; the event itself is still
  // persisted/broadcast unconditionally via `routeEvent` above.
  if (ev.kind === 'session:brainstorm-complete' && !sourceControllerIsStopping) {
    try {
      const ws = getWs(workspaceId)
      if (ws && ws.status !== 'executing') {
        updateWorkspaceStatus(workspaceId, 'executing')
      }
    } catch (err) {
      console.error('[orchestrator] Failed to transition to executing:', err)
    }
  }
  if (ev.kind === 'error' && ev.category === 'quota' && !sourceControllerIsStopping) {
    void handleQuota(workspaceId, agentSessionId)
  }
  if (
    ev.kind === 'error' &&
    ev.category === 'other' &&
    TRANSIENT_SERVER_ERROR_PATTERN.test(ev.message) &&
    getWs(workspaceId)?.autoLoop &&
    !sourceControllerIsStopping
  ) {
    void handleTransientAutoLoopFailure(workspaceId)
  }
  if (ev.kind === 'error' && ev.category === 'resume_failed') {
    rememberResumeFailed(workspaceId, agentSessionId)
    clearStaleEngineSessionId(workspaceId)
  }
  if (ev.kind === 'session:ended') {
    if (sourceIsSuperseded && sourceController) {
      settleSupersededSessionController(workspaceId, agentSessionId, sourceController)
      return
    }
    markSessionLifecycleOwnerEnded(workspaceId, agentSessionId, sourceController)

    const isResumeFailed = consumeResumeFailed(workspaceId, agentSessionId)

    const snapshot = consumeTaskProgressSnapshot(workspaceId, agentSessionId)
    const before = snapshot?.doneCount ?? getDoneTaskCount(workspaceId)
    const after = getDoneTaskCount(workspaceId)
    const completedDelta = Math.max(0, after - before)
    const taskStateBefore = snapshot?.stateSignature ?? getTaskStateSignature(workspaceId)
    const taskStateAfter = getTaskStateSignature(workspaceId)
    const progressDelta = completedDelta > 0 || taskStateBefore !== taskStateAfter ? 1 : 0

    clearPendingForSession(workspaceId, agentSessionId)
    // A completed/failed SDK session cannot resolve canUseTool anymore. Drop
    // its persisted prompts too, otherwise a reconnect resurrects a panel
    // whose backend callback has already been discarded.
    purgeAllPersistedUserInputRequests(workspaceId, agentSessionId)

    // A watchdog end means Kōbō forced the stream closed after the engine
    // failed to drain. It is neither a clean completion nor evidence of an
    // agent stall. Move auto-loop work onto the existing persisted, bounded
    // transient-retry path before lifecycle cleanup observes the status.
    //
    // `!hasReplacement` is load-bearing: this recovery is workspace-scoped,
    // not session-scoped, and it runs BEFORE onSessionEnded's own superseded
    // guard. Without it, an old session timing out would flip the workspace
    // that a NEW session is already running into `quota` and arm a backoff.
    // This is not covered by `sourceControllerIsStopping`: `runWatchdog`'s
    // dead-engine branch evicts a controller from the map WITHOUT ever
    // calling `.stop()` on it, so an old controller can still be 'running'
    // by the time its own drain watchdog reports a late `session:ended`.
    const watchdogRecovery = !hasReplacement && ev.reason === 'watchdog' && getWs(workspaceId)?.autoLoop === true
    // A drain watchdog can fire mid-`stop()`: `stopController` already cancelled
    // any pending quota backoff (`quotaBackoffService.cancel(id, 'user')`), and
    // re-arming one here would resurrect a session the user just stopped — the
    // same `sourceControllerIsStopping` guard as every other revive side effect
    // in this function. `watchdogRecovery` itself stays computed unguarded: the
    // `onSessionEnded` call below independently bails out via its own
    // `wasStopping` check before its later `if (watchdogRecovery) return` use
    // could matter.
    if (watchdogRecovery && !sourceControllerIsStopping) {
      console.warn(`[auto-loop] watchdog recovery scheduled for workspace '${workspaceId}'`)
      void handleTransientAutoLoopFailure(workspaceId)
    }

    // Must run BEFORE autoLoopService.onSessionEnded → spawnNextIteration →
    // startAgent, otherwise startAgent throws "Agent already running" because
    // the just-ended controller is still in the map.
    const ownsWorkspaceLifecycle = onSessionEnded(
      workspaceId,
      agentSessionId,
      sourceController,
      ev.exitCode,
      ev.reason,
      isResumeFailed,
    )

    if (!ownsWorkspaceLifecycle) return

    if (watchdogRecovery) return

    // resume_failed exits with an error but the workspace is fine (stale id
    // cleared, next iteration will start fresh) — report 'completed' to
    // auto-loop so it continues.
    const effectiveReason = isResumeFailed ? 'completed' : ev.reason
    // Capture the auto-loop flag BEFORE autoLoopService.onSessionEnded —
    // disable() clears it, and the cleanup hook needs to know whether this was
    // a mid-loop session (never cleans) or a standalone one.
    const wasAutoLoop = autoLoopService.getStatus(workspaceId).auto_loop
    autoLoopService.onSessionEnded(workspaceId, effectiveReason, progressDelta)
    cleanupScriptService.onSessionEnded(workspaceId, effectiveReason, { wasAutoLoop })
  }

  if (ev.kind === 'session:user-input-requested' && !sourceControllerIsStopping) {
    if (ev.requestKind === 'question') {
      enqueuePending(workspaceId, {
        kind: 'question',
        agentSessionId,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        input: ev.payload,
      })
    } else {
      enqueuePending(workspaceId, {
        kind: 'permission',
        agentSessionId,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        toolInput: ev.payload,
      })
    }
    rememberPreAwaitStatus(workspaceId)
    try {
      updateWorkspaceStatus(workspaceId, 'awaiting-user')
    } catch (err) {
      console.warn('[orchestrator] Failed to transition to awaiting-user:', err)
    }
  }
  if (ev.kind === 'session:started' && ev.engineSessionId) {
    sessionIds.set(workspaceId, ev.engineSessionId)
    try {
      const db = getDb()
      db.prepare('UPDATE agent_sessions SET engine_session_id = ?, model = COALESCE(?, model) WHERE id = ?').run(
        ev.engineSessionId,
        ev.model ?? null,
        agentSessionId,
      )
    } catch (err) {
      console.error('[orchestrator] Failed to persist engine session id:', err)
    }
    // Transition terminal states (completed/idle/error/quota) → executing so
    // the frontend's `sessionActive` flips and streaming messages get the
    // typing spinner. Skip while the source controller is stopping — this
    // would bounce a workspace the user just stopped back into `executing`.
    if (!sourceControllerIsStopping) {
      try {
        const ws = getWs(workspaceId)
        if (
          ws &&
          (ws.status === 'completed' || ws.status === 'idle' || ws.status === 'error' || ws.status === 'quota')
        ) {
          updateWorkspaceStatus(workspaceId, 'executing')
        }
      } catch (err) {
        // Transition may be invalid for some edge states — best-effort.
        console.warn('[orchestrator] Could not transition workspace to executing on session:started:', err)
      }
    }
  }
}

function onSessionEnded(
  workspaceId: string,
  agentSessionId: string,
  sourceController: SessionController | undefined,
  exitCode: number | null,
  reason: 'completed' | 'error' | 'killed' | 'watchdog',
  resumeFailed = false,
): boolean {
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

  const registeredController = controllers.get(workspaceId)
  const isSuperseded =
    sourceController !== undefined && registeredController !== undefined && registeredController !== sourceController
  if (isSuperseded) return false

  const currentWorkspace = getWs(workspaceId)
  const preserveQuotaBackoff = currentWorkspace?.status === 'quota'
  const wasStopping = sourceController?.status === 'stopping'

  if (registeredController === sourceController) {
    controllers.delete(workspaceId)
  }

  if (!preserveQuotaBackoff) {
    retryCounts.delete(workspaceId)
  }

  if (wasStopping) return false

  // When the session hit quota, handleQuota() already transitioned the
  // workspace to `quota` and armed the retry via quotaBackoffService.
  // Preserve that pending backoff in the quota path; otherwise clear any
  // stale entry (defensive — shouldn't normally exist on a non-quota end).
  if (!preserveQuotaBackoff) {
    quotaBackoffService.cancel(workspaceId, 'completed')
  }

  if (preserveQuotaBackoff) {
    try {
      markWorkspaceUnread(workspaceId)
      emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
    } catch {
      // best-effort
    }
    return true
  }

  // `reason` is authoritative (with the SDK engine `exitCode` is often null,
  // so reason='error'+exitCode=null would otherwise map wrongly to 'completed').
  // `resumeFailed` is benign: stale id cleared, next iteration starts fresh.
  // 'watchdog' is a forced kill, never a success. For an auto-loop workspace,
  // handleTransientAutoLoopFailure (called above, before onSessionEnded) runs
  // synchronously up to its first await and writes status 'quota' as its very
  // first statement — that write lands before `currentWorkspace` is read above
  // (line ~1144), so `preserveQuotaBackoff` is already true and this function
  // returns early at the `if (preserveQuotaBackoff) return true` branch above.
  // This computation is therefore never reached at all for that path, not
  // merely short-circuited afterwards — it only runs on session ends that
  // don't go through the auto-loop transient-failure path.
  const isErrorOutcome =
    !resumeFailed && (reason === 'error' || reason === 'watchdog' || (exitCode !== null && exitCode !== 0))
  const targetStatus: WorkspaceStatus = isErrorOutcome ? 'error' : 'completed'
  // Skip the transition when the workspace is already in a terminal state.
  // This happens when stopAgent (or an equivalent caller) synchronously
  // normalised the status before the engine's async stop emitted session:ended
  // — typically `awaiting-user → idle`. Without this guard we'd attempt e.g.
  // `idle → completed` and log a benign error on every such manual stop.
  const currentStatus = currentWorkspace?.status
  const alreadyTerminal =
    currentStatus === 'idle' || currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'quota'
  if (!alreadyTerminal) {
    try {
      updateWorkspaceStatus(workspaceId, targetStatus)
    } catch (err) {
      console.error('[orchestrator] Failed to update workspace status on exit:', err)
    }
  }
  try {
    markWorkspaceUnread(workspaceId)
    emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
  } catch {
    // best-effort
  }
  return true
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
  agentPermissionMode?: 'plan' | 'bypass' | 'strict' | 'interactive',
  existingSessionId?: string,
  reasoningEffort?: string,
): StartAgentResult {
  const workspace = getWs(workspaceId)
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)
  if (workspace.archivedAt) throw new Error(`Workspace '${workspaceId}' is archived`)
  if (workspace.worktreePurgedAt) throw new Error(`Workspace '${workspaceId}' worktree is purged`)

  // "For this turn" never survives a new agent session.
  permissionPolicyService.clearTurnPermissions(workspaceId)
  // Zombie detection: an SDK iterator hung on a never-resolved canUseTool
  // callback can leave its controller in the map after the workspace is
  // logically idle. Evict it instead of refusing the new session.
  //
  // A controller already in `stopping` state is evictable too: it stays
  // registered for the whole teardown now (D1), and refusing here would break
  // every legitimate stop-then-start sequence.
  let zombieEviction: Promise<void> = Promise.resolve()
  const existingCtrl = controllers.get(workspaceId)
  if (existingCtrl) {
    const wsForCheck = getWs(workspaceId)
    const status = wsForCheck?.status
    const isLogicallyDone = status === 'idle' || status === 'completed' || status === 'error' || status === 'quota'
    if (isLogicallyDone || existingCtrl.status === 'stopping') {
      console.warn(
        `[orchestrator] Evicting zombie controller for workspace '${workspaceId}' (status=${status}, controller=${existingCtrl.status}) before starting fresh session`,
      )
      // The new engine must not touch the worktree while the zombie may still
      // be writing to it — a zombie that ignores its own stop is exactly the
      // case this path exists for. Bounded: it cannot hold the new session
      // hostage for more than STOP_AGENT_TIMEOUT_MS.
      zombieEviction = stopWithTimeout(existingCtrl, STOP_AGENT_TIMEOUT_MS).then((stopped) => {
        if (!stopped) {
          console.error(
            `[orchestrator] Zombie controller for workspace '${workspaceId}' did not stop within ${STOP_AGENT_TIMEOUT_MS}ms — starting the new session anyway`,
          )
        }
      })
      // Drop any queued pending items + persisted user-input-requested events
      // tied to the zombie's agentSessionId so the new session doesn't inherit
      // a stale queue and so a future sync replay doesn't resurrect them.
      try {
        clearPendingForSession(workspaceId, existingCtrl.agentSessionId)
        preAwaitStatus.delete(workspaceId)
        const db = getDb()
        db.prepare(
          `DELETE FROM ws_events
           WHERE workspace_id = ?
             AND session_id = ?
             AND type = 'agent:event'
             AND json_extract(payload, '$.kind') = 'session:user-input-requested'`,
        ).run(workspaceId, existingCtrl.agentSessionId)
      } catch (err) {
        console.warn('[orchestrator] Failed to purge zombie pending state:', err)
      }
      controllers.delete(workspaceId)
    } else {
      throw new Error(`Agent already running for workspace '${workspaceId}'`)
    }
  }

  const ws = getWs(workspaceId)
  const engineId = readWorkspaceEngineId(workspaceId)
  const engine = resolveEngine(engineId)

  let agentSessionId: string
  let resumeFromEngineSessionId: string | undefined

  if (resume) {
    const r = resolveSessionForResume(workspaceId, existingSessionId, model)
    agentSessionId = r.agentSessionId
    resumeFromEngineSessionId = r.engineSessionId
    // A native resume is only used by the currently selected workspace engine.
    // Keep older DB rows attributable even when they were created pre-migration.
    getDb().prepare('UPDATE agent_sessions SET engine = ? WHERE id = ?').run(engineId, agentSessionId)
  } else {
    agentSessionId = reuseOrCreateFreshSession(workspaceId, existingSessionId, model, engineId)
  }

  // Persist before the asynchronous engine can emit its first event. This
  // survives a Kōbō restart and does not depend on SDK system:init delivery.
  captureTaskProgressBaseline(workspaceId, agentSessionId)

  const settings = ws ? readEffectiveSettingsSafe(ws.projectPath) : readEffectiveSettingsSafe(workingDir)

  const options: StartOptions = {
    workspaceId,
    workingDir,
    prompt: buildAgentPrompt(prompt, ws?.projectPath),
    model,
    effort: reasoningEffort,
    // Cascade: explicit caller override → workspace setting → 'bypass'.
    agentPermissionMode: agentPermissionMode ?? ws?.agentPermissionMode ?? 'bypass',
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
    env: ws ? buildAgentEnv(ws.projectPath) : undefined,
  }

  let controller: SessionController
  controller = new SessionController(workspaceId, agentSessionId, engine, (ev) =>
    handleEvent(workspaceId, agentSessionId, controller, ev),
  )
  registerSessionLifecycleOwner(workspaceId, agentSessionId, controller)
  controllers.set(workspaceId, controller)

  // Kick off engine.start asynchronously, BEHIND the zombie eviction so the
  // new engine never runs concurrently with the one it replaces. Errors
  // surface as error events.
  void zombieEviction
    .then(() => controller.start(options))
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
      handleEvent(workspaceId, agentSessionId, controller, {
        kind: 'error',
        category: 'spawn_failed',
        message,
      })
      handleEvent(workspaceId, agentSessionId, controller, {
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
export function interruptAgent(workspaceId: string, options: InterruptAgentOptions = {}): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new InterruptAgentError(`No agent running for workspace '${workspaceId}'`, 'no_agent_running')
  }
  if (options.expectedSessionId !== undefined && ctrl.agentSessionId !== options.expectedSessionId) {
    throw new InterruptAgentError(
      `Session '${options.expectedSessionId}' is not active for workspace '${workspaceId}'`,
      'session_not_active',
    )
  }
  try {
    ctrl.interrupt()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new InterruptAgentError(
      `Failed to interrupt agent for workspace '${workspaceId}': ${message}`,
      'interrupt_failed',
    )
  }
  if (options.disableAutoLoop && autoLoopService.getStatus(workspaceId).auto_loop) {
    autoLoopService.disable(workspaceId, 'user-action')
  }
}

/**
 * Upper bound on a stop. Beyond this the engine is considered deaf to its own
 * stop path: we evict the controller so the workspace becomes usable again.
 *
 * This is an honest abandonment, not an escalation to something else that
 * watches over the process: Kōbō has no graduated SIGTERM/SIGKILL path of its
 * own, the `process-tracker` module that used to exist was removed, and the
 * session watchdog only walks the `controllers` map — the very map this
 * eviction just removed the entry from. Whatever survives past this timeout
 * is untracked by anyone in this process; only the OS or the user can end it.
 */
export const STOP_AGENT_TIMEOUT_MS = 15_000

export type StopAgentOutcome = 'stopped' | 'not-running' | 'timeout'

async function stopController(workspaceId: string, ctrl: SessionController): Promise<void> {
  wakeupService.cancel(workspaceId, 'stopped')

  // Normalize the state synchronously so callers (archive, delete, manual
  // stop) see a clean workspace immediately — without waiting for the async
  // controller.stop() → session:ended round-trip, which onSessionEnded skips
  // entirely for a controller already in `stopping` state (see `wasStopping`
  // there). Every status that implies a live agent must be covered here —
  // the same four covered by boot-time reconciliation — or a manual stop
  // from `executing`/`brainstorming`/`extracting` leaves the workspace
  // stuck showing "agent busy" with nothing left to ever clear it.
  //   1. drop queued pending items for this session,
  //   2. purge persisted `session:user-input-requested` events so a F5 can't
  //      resurrect zombie panels,
  //   3. transition the workspace out of the active status (→ idle) so
  //      badges and unarchive don't leave a stuck status.
  // Steps 1-2 are `awaiting-user`-specific: they only make sense when the
  // session actually left a pending question/permission behind.
  const wsBefore = getWs(workspaceId)
  const activeStatuses: WorkspaceStatus[] = ['executing', 'brainstorming', 'extracting', 'awaiting-user']
  if (wsBefore && activeStatuses.includes(wsBefore.status)) {
    if (wsBefore.status === 'awaiting-user') {
      clearPendingForSession(workspaceId, ctrl.agentSessionId)
      purgeAllPersistedUserInputRequests(workspaceId, ctrl.agentSessionId)
    }
    try {
      updateWorkspaceStatus(workspaceId, 'idle')
    } catch (err) {
      console.warn(`[orchestrator] Failed to normalize ${wsBefore.status} → idle on stop:`, err)
    }
  }

  // Manual stop should also drop any pending quota auto-resume.
  quotaBackoffService.cancel(workspaceId, 'user')

  // D1 — the controller stays REGISTERED for the whole stop, in `stopping`
  // state. Removing it up-front (as we used to) made the only "is an agent
  // running?" signal of the system lie for the entire teardown window: cron
  // and auto-loop could start a second agent on the same worktree, and delete
  // could pull the worktree from under a process still writing to it.
  try {
    await ctrl.stop()
  } finally {
    if (controllers.get(workspaceId) === ctrl) controllers.delete(workspaceId)
  }
}

/**
 * Race an arbitrary promise against a bounded deadline. Resolves to the
 * winner's value; if the deadline wins, `onTimeout()` supplies the value
 * instead. Never throws — the timer is always cleared. Single source of
 * truth for the "stop, but not forever" pattern: both `stopWithTimeout` and
 * `stopAgentAndWait` used to hand-roll their own `Promise.race` + timer, two
 * copies of the same logic that could silently drift apart.
 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Race a controller stop against a bounded deadline. Never throws. */
async function stopWithTimeout(ctrl: SessionController, timeoutMs: number): Promise<boolean> {
  return raceWithTimeout(
    ctrl
      .stop()
      .then(() => true)
      .catch((err) => {
        console.error('[orchestrator] controller.stop rejected:', err)
        return true
      }),
    timeoutMs,
    () => false,
  )
}

/**
 * Stop the agent and wait for it to actually die. Every caller that mutates
 * the worktree afterwards — delete, archive, purge, setup script, engine
 * switch — MUST use this: the fire-and-forget `stopAgent` returns while the
 * engine may still be writing files.
 */
export async function stopAgentAndWait(
  workspaceId: string,
  timeoutMs: number = STOP_AGENT_TIMEOUT_MS,
): Promise<StopAgentOutcome> {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) return 'not-running'

  const finished = await raceWithTimeout(
    stopController(workspaceId, ctrl).then(
      () => true,
      (err) => {
        console.error(`[orchestrator] controller.stop failed for '${workspaceId}':`, err)
        return true
      },
    ),
    timeoutMs,
    () => false,
  )
  if (finished) return 'stopped'

  console.error(
    `[orchestrator] Agent for workspace '${workspaceId}' did not stop within ${timeoutMs}ms — evicting its controller`,
  )
  if (controllers.get(workspaceId) === ctrl) controllers.delete(workspaceId)
  return 'timeout'
}

/**
 * Fire-and-forget stop, for the few callers that cannot await (WebSocket
 * handlers). Anything that touches the worktree afterwards must call
 * `stopAgentAndWait` instead. Escalation is the engine's business — Kōbō has
 * no graduated SIGTERM/SIGKILL path of its own.
 */
export function stopAgent(workspaceId: string): void {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  void stopAgentAndWait(workspaceId).catch((err) => {
    console.error('[orchestrator] stopAgent failed:', err)
  })
}

/** Stop every live engine before process shutdown, with a bounded wait per engine. */
export async function stopAllAgents(timeoutMs = 3_000): Promise<void> {
  // No per-workspace try/catch here: unlike the pre-D1 shutdown path,
  // `stopAgentAndWait` never rejects — every internal failure (a rejecting
  // `controller.stop()`, or the bounded deadline firing) is already converted
  // into a logged, returned `StopAgentOutcome` ('stopped' | 'timeout')
  // instead of a thrown error. A wrapping catch here would be unreachable
  // dead code pretending to guard against a failure mode that can't occur.
  await Promise.all([...controllers.keys()].map((workspaceId) => stopAgentAndWait(workspaceId, timeoutMs)))
}

/** Write a user message to the running agent. */
export async function sendMessage(workspaceId: string, content: string, expectedSessionId?: string): Promise<void> {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  if (expectedSessionId && ctrl.agentSessionId !== expectedSessionId) {
    throw new Error(`Session '${expectedSessionId}' is not active for workspace '${workspaceId}'`)
  }
  wakeupService.cancel(workspaceId, 'user-message')
  await ctrl.sendMessage(content)
}

/**
 * Deliver a prompt without racing a controller that is already shutting down.
 * A failed steering attempt is ambiguous until the captured controller leaves
 * the registry: only its removal authorizes a caller to start a resume.
 */
export type FallbackDeliveryResult = { status: 'sent'; sessionId: string } | { status: 'stopped' }

export async function sendMessageForFallback(workspaceId: string, content: string): Promise<FallbackDeliveryResult> {
  const capturedController = controllers.get(workspaceId)
  if (!capturedController) return { status: 'stopped' }

  wakeupService.cancel(workspaceId, 'user-message')
  try {
    await capturedController.sendMessage(content)
    return { status: 'sent', sessionId: capturedController.agentSessionId }
  } catch {
    const deadline = Date.now() + FALLBACK_CONTROLLER_TURNOVER_TIMEOUT_MS
    while (controllers.get(workspaceId) === capturedController) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for agent controller turnover for workspace '${workspaceId}'`)
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(FALLBACK_CONTROLLER_TURNOVER_POLL_MS, remaining))
      })
    }

    const replacementController = controllers.get(workspaceId)
    if (!replacementController) return { status: 'stopped' }
    await replacementController.sendMessage(content)
    return { status: 'sent', sessionId: replacementController.agentSessionId }
  }
}

/**
 * Error shapes that all mean the same thing to a chat sender: this workspace
 * has no agent able to receive a message right now, so the correct reaction is
 * to resume a session — never to reject and drop what the user typed.
 *
 * `Claude input stream is closed` / `Claude agent is no longer running` are
 * exactly what the Claude engine throws after a one-prompt-one-turn session
 * closed its stdin. The former literal `includes('No agent running')` test
 * missed both, and the message vanished with no feedback at all.
 *
 * The third pattern is built from `AGENT_NO_LONGER_RUNNING_TEXT`
 * (`engines/types.ts`) rather than hardcoded again here: the Codex engine's
 * `sendMessage` throws `Codex ${AGENT_NO_LONGER_RUNNING_TEXT}` once its
 * session has fully ended (JSON-RPC peer closed, child killed) and a message
 * arrives afterward — the same "resume, don't reject" situation Claude hits,
 * reusing this one already-recognized shape instead of adding a fourth,
 * engine-specific string to maintain here.
 *
 * Deliberately EXCLUDED: `SessionController is stopping` and
 * `SessionController not started` (Claude), and Codex's own
 * `Codex session is not ready to receive a message` (thrown before its first
 * turn is established). Resuming any of those would spawn a second agent on
 * a worktree that is mid-teardown or mid-startup, or mask a genuine startup
 * failure behind a resume loop. Those stay visible rejections.
 */
const AGENT_UNAVAILABLE_PATTERNS = [
  /no agent running/i,
  /input stream is closed/i,
  new RegExp(AGENT_NO_LONGER_RUNNING_TEXT, 'i'),
] as const

export function isAgentUnavailableError(message: string): boolean {
  return AGENT_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Render the user's answer to an AskUserQuestion as a markdown chat
 * message. Each question becomes a bullet line `**<question>** → <answer>`.
 * Empty answers are skipped — questions the user didn't fill won't appear.
 */
function formatDeferredAnswerForChat(questions: unknown, answers: Record<string, string>): string {
  if (!Array.isArray(questions)) return ''
  const lines: string[] = []
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue
    if ((q as { isSecret?: unknown }).isSecret === true) continue
    const questionText =
      typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : null
    if (!questionText) continue
    const questionId = typeof (q as { id?: unknown }).id === 'string' ? (q as { id: string }).id : questionText
    const answer = answers[questionId] ?? answers[questionText]
    if (!answer) continue
    lines.push(`- **${questionText}** → ${answer}`)
  }
  return lines.length > 0 ? lines.join('\n') : ''
}

/**
 * Answer a pending AskUserQuestion by resolving the engine's `canUseTool`
 * callback with the user's answers. The SDK iterator continues on its own
 * once the callback resolves — no resume / re-spawn needed.
 */
export async function answerPendingQuestion(
  workspaceId: string,
  answers: Record<string, string>,
  expectedToolCallId?: string,
  opts?: { awaitingFreeForm?: boolean; response?: string },
): Promise<void> {
  const head = peekPending(workspaceId)
  if (!head) {
    // Self-heal an orphan `awaiting-user` (queue empty but status not restored,
    // typically after a server restart). Default to `idle` rather than
    // `executing` since there's no live agent here.
    try {
      const ws = getWs(workspaceId)
      if (ws?.status === 'awaiting-user') {
        const remembered = preAwaitStatus.get(workspaceId)
        preAwaitStatus.delete(workspaceId)
        const restoreTo: WorkspaceStatus = remembered ?? 'idle'
        updateWorkspaceStatus(workspaceId, restoreTo)
      }
    } catch (err) {
      console.warn('[orchestrator] Self-heal awaiting-user → idle failed:', err)
    }
    throw new Error(`No deferred tool use pending for workspace '${workspaceId}'`)
  }
  if (head.kind !== 'question') {
    throw new Error(`Expected a deferred question at the head of the queue, got '${head.kind}'`)
  }
  // Race protection: head may have rotated between the panel opening and
  // submit (previous defer cancelled, new one queued).
  if (expectedToolCallId && head.toolCallId !== expectedToolCallId) {
    throw new Error(
      `Pending question changed: expected toolCallId '${expectedToolCallId}', current head is '${head.toolCallId}'`,
    )
  }
  const ws = getWs(workspaceId)
  if (!ws) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  const engineProcess = ctrl.engineProcess
  if (!engineProcess) {
    throw new Error(`Agent for workspace '${workspaceId}' has no active engine process`)
  }

  const resolved = engineProcess.resolvePendingUserInput(head.toolCallId, {
    kind: 'question',
    answers,
    ...(opts?.response !== undefined ? { response: opts.response } : {}),
  })
  if (!resolved) {
    throw new Error(`No pending callback for toolCallId '${head.toolCallId}'`)
  }

  dequeuePending(workspaceId)
  purgePersistedUserInputRequest(workspaceId, head.toolCallId)
  const restoreTo = peekPending(workspaceId) ? 'awaiting-user' : consumePreAwaitStatus(workspaceId)
  try {
    updateWorkspaceStatus(workspaceId, restoreTo)
  } catch (err) {
    console.warn(`[orchestrator] Failed to transition awaiting-user → ${restoreTo}:`, err)
  }

  // "Other" means the user owes a free-form clarification in their next chat
  // message. If auto-loop is active, the agent finishing its turn would
  // otherwise chain the next iteration before that clarification arrives — so
  // pause the loop. The user re-enables it manually after clarifying.
  if (opts?.awaitingFreeForm && autoLoopService.getStatus(workspaceId).auto_loop) {
    try {
      autoLoopService.disable(workspaceId, 'awaiting-clarification')
    } catch (err) {
      console.error('[orchestrator] Failed to disable auto-loop on awaiting-clarification:', err)
    }
  }

  const questions = (head.input as { questions?: unknown } | null)?.questions
  try {
    const formatted = formatDeferredAnswerForChat(questions, answers)
    if (formatted) {
      emit(workspaceId, 'user:message', { content: formatted, sender: 'user' }, head.agentSessionId)
    }
  } catch (err) {
    console.error('[orchestrator] Failed to emit user:message for question answer:', err)
  }
}

/**
 * Answer a pending interactive permission request by resolving the engine's
 * `canUseTool` callback with allow/deny.
 */
export async function answerPendingPermission(
  workspaceId: string,
  decision: {
    toolCallId: string
    decision: 'allow' | 'deny'
    reason?: string
    scope?: 'once' | 'turn' | 'operation' | 'tool'
  },
): Promise<void> {
  const head = peekPending(workspaceId)
  if (!head) {
    // Self-heal an orphan `awaiting-user` (see answerPendingQuestion).
    try {
      const ws = getWs(workspaceId)
      if (ws?.status === 'awaiting-user') {
        const remembered = preAwaitStatus.get(workspaceId)
        preAwaitStatus.delete(workspaceId)
        updateWorkspaceStatus(workspaceId, remembered ?? 'idle')
      }
    } catch (err) {
      console.warn('[orchestrator] Self-heal awaiting-user → idle failed:', err)
    }
    throw new Error(`No deferred tool use pending for workspace '${workspaceId}'`)
  }
  if (head.kind !== 'permission') {
    throw new Error(`Expected a deferred permission at the head of the queue, got '${head.kind}'`)
  }
  if (head.toolCallId !== decision.toolCallId) {
    throw new Error(`Decision toolCallId '${decision.toolCallId}' does not match head toolCallId '${head.toolCallId}'`)
  }
  const ws = getWs(workspaceId)
  if (!ws) {
    throw new Error(`Workspace '${workspaceId}' not found`)
  }
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  const engineProcess = ctrl.engineProcess
  if (!engineProcess) {
    throw new Error(`Agent for workspace '${workspaceId}' has no active engine process`)
  }

  const response =
    decision.decision === 'allow'
      ? ({ kind: 'permission-allow' } as const)
      : ({ kind: 'permission-deny', reason: decision.reason } as const)
  if (decision.decision === 'allow' && (decision.scope === 'operation' || decision.scope === 'tool')) {
    permissionPolicyService.createWorkspacePermissionRule(
      workspaceId,
      { engine: (ws as { engine?: string }).engine ?? 'claude-code', toolName: head.toolName, payload: head.toolInput },
      decision.scope,
    )
  }
  if (decision.decision === 'allow' && decision.scope === 'turn') {
    permissionPolicyService.allowPermissionForTurn(workspaceId, {
      engine: (ws as { engine?: string }).engine ?? 'claude-code',
      toolName: head.toolName,
      payload: head.toolInput,
    })
  }
  const resolved = engineProcess.resolvePendingUserInput(decision.toolCallId, response)
  if (!resolved) {
    throw new Error(`No pending callback for toolCallId '${decision.toolCallId}'`)
  }

  dequeuePending(workspaceId)
  purgePersistedUserInputRequest(workspaceId, head.toolCallId)
  const restoreTo = peekPending(workspaceId) ? 'awaiting-user' : consumePreAwaitStatus(workspaceId)
  try {
    updateWorkspaceStatus(workspaceId, restoreTo)
  } catch (err) {
    console.warn(`[orchestrator] Failed to transition awaiting-user → ${restoreTo}:`, err)
  }
}

/**
 * Cancel a pending question without answering: resolves the SDK callback
 * with `behavior: 'deny'` so the agent receives an error tool_result and
 * can adapt (proceed with defaults, re-ask, or abandon). The session
 * keeps running — Cancel ≠ Stop.
 */
export async function cancelPendingQuestion(
  workspaceId: string,
  reason?: string,
  expectedToolCallId?: string,
): Promise<void> {
  const head = peekPending(workspaceId)
  if (!head) {
    // Self-heal an orphan `awaiting-user` (see answerPendingQuestion).
    try {
      const ws = getWs(workspaceId)
      if (ws?.status === 'awaiting-user') {
        const remembered = preAwaitStatus.get(workspaceId)
        preAwaitStatus.delete(workspaceId)
        updateWorkspaceStatus(workspaceId, remembered ?? 'idle')
      }
    } catch (err) {
      console.warn('[orchestrator] Self-heal awaiting-user → idle failed:', err)
    }
    throw new Error(`No deferred tool use pending for workspace '${workspaceId}'`)
  }
  if (head.kind !== 'question') {
    throw new Error(`Expected a deferred question at the head of the queue, got '${head.kind}'`)
  }
  // toolCallId mismatch on cancel is logged but NOT fatal: the user clicked
  // Cancel on whatever was visible. Worst case is a benign deny on a question
  // the agent was about to ask anyway. (Mismatch on submit IS fatal — wrong
  // answers would be applied to the wrong question.)
  if (expectedToolCallId && head.toolCallId !== expectedToolCallId) {
    console.warn(
      `[orchestrator] cancel toolCallId mismatch — expected '${expectedToolCallId}', head is '${head.toolCallId}'. Cancelling head anyway.`,
    )
  }
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }
  const engineProcess = ctrl.engineProcess
  if (!engineProcess) {
    throw new Error(`Agent for workspace '${workspaceId}' has no active engine process`)
  }

  const resolved = engineProcess.resolvePendingUserInput(head.toolCallId, {
    kind: 'question-cancel',
    reason,
  })
  if (!resolved) {
    throw new Error(`No pending callback for toolCallId '${head.toolCallId}'`)
  }

  dequeuePending(workspaceId)
  purgePersistedUserInputRequest(workspaceId, head.toolCallId)
  const restoreTo = peekPending(workspaceId) ? 'awaiting-user' : consumePreAwaitStatus(workspaceId)
  try {
    updateWorkspaceStatus(workspaceId, restoreTo)
  } catch (err) {
    console.warn(`[orchestrator] Failed to transition awaiting-user → ${restoreTo}:`, err)
  }
}

/** @deprecated use `answerPendingQuestion` instead. Kept for legacy callers/tests. */
export async function resumeDeferredQuestion(workspaceId: string, answers: Record<string, string>): Promise<void> {
  return answerPendingQuestion(workspaceId, answers)
}

/** @deprecated use `answerPendingPermission` instead. Kept for legacy callers/tests. */
export async function resumeDeferredPermission(
  workspaceId: string,
  decision: { toolCallId: string; decision: 'allow' | 'deny'; reason?: string },
): Promise<void> {
  return answerPendingPermission(workspaceId, decision)
}

/** @deprecated alias kept for older tests. */
export async function resumeDeferredToolUse(workspaceId: string, answers: Record<string, string>): Promise<void> {
  return answerPendingQuestion(workspaceId, answers)
}

/** @internal test-only */
export function _getPendingQueue(): Map<string, PendingItem[]> {
  return pendingQueue
}

/**
 * @internal test-only — legacy shim. Returns a Map<workspaceId, PendingItem>
 * containing only the head of each queue (question kind only) flattened to the
 * pre-queue shape so older tests keep passing without rewriting. New tests
 * should use `_getPendingQueue` instead.
 */
export function _getPendingDeferred(): Map<
  string,
  { toolCallId: string; toolName: string; input: unknown; agentSessionId: string }
> {
  const out = new Map<string, { toolCallId: string; toolName: string; input: unknown; agentSessionId: string }>()
  for (const [wid, arr] of pendingQueue) {
    const head = arr[0]
    if (head?.kind !== 'question') continue
    out.set(wid, {
      toolCallId: head.toolCallId,
      toolName: head.toolName,
      input: head.input,
      agentSessionId: head.agentSessionId,
    })
  }
  return out
}

/** In-memory status of the agent for a workspace, or null if not running. */
export function getAgentStatus(workspaceId: string): 'running' | 'stopping' | null {
  return controllers.get(workspaceId)?.status ?? null
}

/** True when an agent controller is currently running for the workspace. */
export function hasController(workspaceId: string): boolean {
  return controllers.has(workspaceId)
}

/** The agent_session_id of the active controller for the workspace, if any. */
export function getActiveSessionId(workspaceId: string): string | undefined {
  return controllers.get(workspaceId)?.agentSessionId
}

/** Number of currently running controllers. */
export function getRunningCount(): number {
  return controllers.size
}

/**
 * D1 — liveness is memory, not a column. Serializing it is what lets the
 * client stop inferring "an agent is running" from `workspaces.status`: a
 * workspace stuck in `executing` with no controller is an orphan, and only
 * this shape can say so.
 */
export interface AgentLiveness {
  status: 'running' | 'stopping'
  agentSessionId: string
  startedAt: string
  lastEventAt: string
}

/** Liveness for one workspace, or `null` when no controller owns it. */
export function getAgentLiveness(workspaceId: string): AgentLiveness | null {
  const ctrl = controllers.get(workspaceId)
  if (!ctrl) return null
  return {
    status: ctrl.status,
    agentSessionId: ctrl.agentSessionId,
    startedAt: new Date(ctrl.startedAt).toISOString(),
    lastEventAt: new Date(ctrl.lastEventAt).toISOString(),
  }
}

/** Liveness for every live controller, keyed by workspace id. */
export function getAllAgentLiveness(): Record<string, AgentLiveness> {
  const out: Record<string, AgentLiveness> = {}
  for (const workspaceId of controllers.keys()) {
    const liveness = getAgentLiveness(workspaceId)
    if (liveness) out[workspaceId] = liveness
  }
  return out
}

/** Kobo built-in slash commands injected into the skill list (without leading /). */
const KOBO_COMMANDS = ['kobo-check-progress', 'kobo-prep-autoloop']

/** Cached list of slash commands discovered from the last agent init, plus Kobo built-ins. */
export function getAvailableSkills(): string[] {
  return [...KOBO_COMMANDS, ...availableSkills]
}

// ── Quota handling ────────────────────────────────────────────────────────────

/**
 * Last `rate_limit.info` received per workspace. Used by handleQuota to
 * schedule the backoff at the actual reset time instead of a hardcoded
 * exponential. In-memory only — rebuilt on the next rate_limit event after
 * a server restart.
 */
const latestRateLimitInfo = new Map<string, RateLimitInfo>()

/** Clear the rate-limit info cache for a workspace (called on deleteWorkspace). */
export function forgetRateLimitInfo(workspaceId: string): void {
  latestRateLimitInfo.delete(workspaceId)
}

/**
 * Null out every engine_session_id for the workspace and clear its cache.
 * This runs only while the failing session owns the workspace, ensuring a
 * future resume cannot fall back to an older stale engine session.
 */
function clearStaleEngineSessionId(workspaceId: string): void {
  try {
    const db = getDb()
    db.prepare('UPDATE agent_sessions SET engine_session_id = NULL WHERE workspace_id = ?').run(workspaceId)
    sessionIds.delete(workspaceId)
  } catch (err) {
    console.error('[orchestrator] Failed to clear stale engine session ID:', err)
  }
}

/** Return shape for computeQuotaBackoffMs — callers need delay + observability fields. */
export interface QuotaBackoff {
  delayMs: number
  resetsAt?: string
  source: 'rate_limit_info' | 'usage_api' | 'fallback_ladder'
}

/** Retryable upstream failures for an auto-loop iteration (not coding errors). */
export const TRANSIENT_SERVER_ERROR_PATTERN =
  /\b(?:http\s*)?500\b|internal server error|service unavailable|temporarily unavailable|overloaded/i

const QUOTA_SAFETY_MARGIN_MS = 30_000
const QUOTA_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000
const QUOTA_SATURATION_THRESHOLD_PCT = 95

/**
 * Fallback backoff ladder (in minutes) used when the `rate_limit` info
 * isn't usable. Indexed by `retryCount`; anything past the last entry
 * clamps to the final value (5 h) — long enough to cross a weekly
 * bucket reset if the rate_limit info truly never arrives.
 */
const QUOTA_FALLBACK_LADDER_MINUTES = [15, 30, 60, 180, 300] as const

/**
 * Compute the delay before retrying a workspace hit by quota.
 *
 * Prefers (1) the `resetsAt` of the saturated bucket with the furthest-future
 * reset reported by the agent's `rate_limit` event, then (1.5) the official
 * Anthropic usage API (`five_hour` bucket) when it reports saturation, and
 * finally (2) a fixed ladder (15 → 30 → 60 → 180 → 300 min) whenever neither
 * source is usable.
 */
export async function computeQuotaBackoffMs(
  workspaceId: string,
  retryCount: number,
  preferQuotaReset = true,
): Promise<QuotaBackoff> {
  if (!preferQuotaReset) {
    const idx = Math.min(Math.max(0, retryCount), QUOTA_FALLBACK_LADDER_MINUTES.length - 1)
    return { delayMs: QUOTA_FALLBACK_LADDER_MINUTES[idx] * 60 * 1000, source: 'fallback_ladder' }
  }
  // 1. Prefer the rate_limit event from the agent stream — most recent + most precise.
  const info = latestRateLimitInfo.get(workspaceId)
  if (info?.buckets?.length) {
    const candidates = info.buckets
      .filter((b) => b.usedPct >= QUOTA_SATURATION_THRESHOLD_PCT && typeof b.resetsAt === 'string')
      .map((b) => ({ resetsAt: b.resetsAt as string, ts: new Date(b.resetsAt as string).getTime() }))
      .filter((x) => !Number.isNaN(x.ts))
      .sort((a, b) => b.ts - a.ts)

    const chosen = candidates[0]
    if (chosen) {
      const delta = chosen.ts - Date.now() + QUOTA_SAFETY_MARGIN_MS
      if (delta > 0 && delta <= QUOTA_MAX_BACKOFF_MS) {
        return { delayMs: delta, resetsAt: chosen.resetsAt, source: 'rate_limit_info' }
      }
    }
  }

  // 1.5. Try the official usage API (Claude subscription). Best-effort; never throws.
  try {
    const snap = await refreshNow('claude-code')
    if (snap) {
      const fiveHour = snap.buckets.find((b) => b.id === 'five_hour')
      if (
        fiveHour &&
        typeof fiveHour.usedPct === 'number' &&
        fiveHour.usedPct >= QUOTA_SATURATION_THRESHOLD_PCT &&
        typeof fiveHour.resetsAt === 'string'
      ) {
        const resetTs = Date.parse(fiveHour.resetsAt)
        const delta = resetTs - Date.now() + QUOTA_SAFETY_MARGIN_MS
        if (delta > 0 && delta <= QUOTA_MAX_BACKOFF_MS) {
          return { delayMs: delta, resetsAt: fiveHour.resetsAt, source: 'usage_api' }
        }
      }
    }
  } catch (err) {
    console.warn('[orchestrator] computeQuotaBackoffMs — usage API call failed:', err)
  }

  // 2. Hard-coded ladder.
  const idx = Math.min(Math.max(0, retryCount), QUOTA_FALLBACK_LADDER_MINUTES.length - 1)
  const backoffMinutes = QUOTA_FALLBACK_LADDER_MINUTES[idx]
  return { delayMs: backoffMinutes * 60 * 1000, source: 'fallback_ladder' }
}

/** @internal test-only — re-export of `computeQuotaBackoffMs` to anchor a stable seam. */
export const _computeQuotaBackoffMs = computeQuotaBackoffMs

/** @internal Test-only. */
export function _test_setRateLimitInfo(workspaceId: string, info: RateLimitInfo): void {
  latestRateLimitInfo.set(workspaceId, info)
}

async function handleQuota(workspaceId: string, _agentSessionId?: string): Promise<void> {
  try {
    updateWorkspaceStatus(workspaceId, 'quota')
  } catch (err) {
    // Never silent: a refused transition here loses the backoff two lines down.
    console.warn(`[orchestrator] Could not transition workspace '${workspaceId}' to quota:`, err)
  }

  const retryCount = retryCounts.get(workspaceId) ?? 0
  const autoLoopEnabled = getWs(workspaceId)?.autoLoop === true
  const maxRetries = autoLoopEnabled ? (getGlobalSettings().autoLoopMaxRetries ?? 5) : 5
  if (autoLoopEnabled && retryCount >= maxRetries) {
    autoLoopService.disable(workspaceId, 'error')
    try {
      updateWorkspaceStatus(workspaceId, 'error')
    } catch {
      // The loop is disabled even if an already-terminal status rejects this transition.
    }
    return
  }
  const { delayMs, resetsAt, source } = await computeQuotaBackoffMs(workspaceId, retryCount)
  retryCounts.set(workspaceId, retryCount + 1)

  // The quotaBackoffService owns the timer + the persistent row + the
  // 'agent:quota-backoff' WS emit. Hand off everything to it.
  quotaBackoffService.arm(workspaceId, delayMs, { resetsAt: resetsAt ?? null, source, reason: 'quota' })
}

/** First retry after a transient failure (watchdog recovery, HTTP 500). The
 *  quota ladder's 15-minute floor is tuned for real quota windows — a forced
 *  kill or a server blip deserves a much faster first attempt. */
const TRANSIENT_FIRST_RETRY_MS = 2 * 60_000

/**
 * Use the same persisted retry path for temporary upstream failures (HTTP 500
 * and overloads) while deliberately ignoring quota-reset data: a server error
 * is unrelated to the user's quota window and follows the fallback ladder.
 */
async function handleTransientAutoLoopFailure(workspaceId: string): Promise<void> {
  try {
    updateWorkspaceStatus(workspaceId, 'quota')
  } catch (err) {
    console.warn(
      `[orchestrator] Could not transition workspace '${workspaceId}' to quota for a transient failure:`,
      err,
    )
  }

  const retryCount = retryCounts.get(workspaceId) ?? 0
  const maxRetries = getGlobalSettings().autoLoopMaxRetries ?? 5
  if (retryCount >= maxRetries) {
    autoLoopService.disable(workspaceId, 'error')
    try {
      updateWorkspaceStatus(workspaceId, 'error')
    } catch {
      // The loop is disabled even if an already-terminal status rejects this transition.
    }
    return
  }
  const { delayMs, resetsAt, source } = await computeQuotaBackoffMs(workspaceId, retryCount, false)
  const effectiveDelayMs = retryCount === 0 ? Math.min(delayMs, TRANSIENT_FIRST_RETRY_MS) : delayMs
  retryCounts.set(workspaceId, retryCount + 1)
  quotaBackoffService.arm(workspaceId, effectiveDelayMs, { resetsAt: resetsAt ?? null, source, reason: 'transient' })
}

/** @internal test-only — re-export of `handleQuota` for direct testing. */
export const _handleQuota = handleQuota

/** @internal test-only — re-export of the transient auto-loop retry handler. */
export const _handleTransientAutoLoopFailure = handleTransientAutoLoopFailure

/**
 * Rebuild the in-memory `retryCounts` map from the persisted `pending_quota_backoffs`
 * rows. Called from `index.ts` at boot, before `quotaBackoffService.restoreOnBoot`.
 * Without this, an arm() after restart would compute the next backoff from
 * `retryCount=0`, undoing the ladder progression.
 */
export function restoreRetryCountsFromDb(): void {
  for (const pending of quotaBackoffService.listPending()) {
    retryCounts.set(pending.workspaceId, pending.retryCount)
  }
}

// One-time wire: when the persisted backoff timer fires (or a row is
// restored at boot), hand the workspace off to auto-loop. The auto-loop
// service decides whether to spawn the next iteration or fall back to a
// manual resume.
//
// IMPORTANT — behavioural contract: only auto-loop workspaces auto-resume
// after a quota backoff. `onQuotaBackoffExpired` no-ops if `auto_loop !== 1`
// (see auto-loop-service). Workspaces hit by quota WITHOUT auto-loop stay
// in `quota` status and require manual user action (resume / new message)
// to leave that state. This is intentional: without an auto-loop intent,
// firing a fresh agent run in the user's absence would surprise them.
quotaBackoffService.setOnFireCallback((workspaceId: string) => {
  autoLoopService.onQuotaBackoffExpired(workspaceId)
})

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
export function _getSessionIds(): Map<string, string> {
  return sessionIds
}

/** @internal test-only — runs a single watchdog sweep synchronously. */
export function _runWatchdogForTest(): void {
  runWatchdog()
}

/** Test-only export. Not part of the public module API. */
export const __test__ = {
  getSessionLifecycleOwnerCount(workspaceId: string): number {
    return sessionLifecycleOwners.get(workspaceId)?.size ?? 0
  },
  handleEvent(workspaceId: string, agentSessionId: string, ev: AgentEvent): void {
    const sourceController = controllers.get(workspaceId)
    if (sourceController && sourceController.agentSessionId !== agentSessionId) {
      throw new Error(`Session '${agentSessionId}' is not active for workspace '${workspaceId}'`)
    }
    handleEvent(workspaceId, agentSessionId, sourceController, ev)
  },
  handleQuota,
}
