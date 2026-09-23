import fs from 'node:fs'
import {
  AUTO_LOOP_HARD_RULES,
  AUTO_LOOP_ITERATION_RULES,
  buildAutoLoopGroomingSteps,
  buildE2eIterationBlock,
  buildFinalizationIterationBlock,
} from '../../shared/auto-loop-prompts.js'
import type { AutoLoopRuntime } from '../../shared/auto-loop-types.js'
import type { AutomaticAdmissionReason, AutomaticAdmissionStatus } from '../../shared/automatic-admission.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { deferUntilWorkspaceAvailable, isWorkspaceLifecycleBusy } from '../utils/workspace-lifecycle-guard.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import * as orchestrator from './agent/orchestrator.js'
import {
  bindLoopMessages,
  claimLoopMessages,
  enqueueLoopMessage,
  hasLoopMessage,
  listLoopMessages,
  recoverLoopMessages,
  settleLoopMessages,
} from './auto-loop-message-service.js'
import { getRuntime, setRuntime } from './auto-loop-state-service.js'
import * as cleanupScriptService from './cleanup-script-service.js'
import * as lifecycleHookService from './lifecycle-hook-service.js'
import * as quotaBackoffService from './quota-backoff-service.js'
import * as settingsService from './settings-service.js'
import { getSuitePrompts } from './skill-suite-prompts.js'
import { invalidateTaskFinalization } from './task-mutations.js'
import { emit, emitEphemeral } from './websocket-service.js'
import { createTask, listTasks, type Task, updateWorkspaceStatus } from './workspace-service.js'

export interface AutoLoopStatus extends AutoLoopRuntime {
  retry_at: string | null

  auto_loop: boolean
  auto_loop_ready: boolean
  no_progress_streak: number
}

export type DisableReason = 'user-action' | 'completed' | 'stall' | 'error' | 'awaiting-clarification'

const NO_PROGRESS_STALL_THRESHOLD = 3

interface WorkspaceRow {
  id: string
  project_path: string
  working_branch: string
  worktree_path: string | null
  model: string
  permission_mode: string
  agent_permission_mode: string | null
  reasoning_effort: string
  status: string
  auto_loop: number
  auto_loop_ready: number
  auto_loop_session_mode: string
  no_progress_streak: number
  archived_at: string | null
  worktree_purged_at: string | null
}

function getRow(workspaceId: string): WorkspaceRow | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, project_path, working_branch, worktree_path, model, permission_mode, agent_permission_mode, reasoning_effort,
              status, auto_loop, auto_loop_ready, auto_loop_session_mode, no_progress_streak, archived_at, worktree_purged_at
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as WorkspaceRow | undefined
  return row ?? null
}

function countPendingTasks(workspaceId: string): number {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status != ?')
    .get(workspaceId, 'done') as { c: number }
  return row.c
}

function countDoneTasks(workspaceId: string): number {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status = ?')
    .get(workspaceId, 'done') as { c: number }
  return row.c
}

export function getStatus(workspaceId: string): AutoLoopStatus {
  const row = getRow(workspaceId)
  const runtime = getRuntime(workspaceId, row?.auto_loop_ready === 1)
  const pending = quotaBackoffService.getPending(workspaceId)
  return {
    ...runtime,
    state: !row?.auto_loop
      ? runtime.state === 'completed'
        ? 'completed'
        : 'stopped'
      : runtime.state === 'blocked'
        ? 'blocked'
        : pending || row.status === 'quota' || row.status === 'awaiting-user' || row.status === 'compacting'
          ? 'waiting'
          : runtime.state,
    reason: pending ? pending.reason : row?.status === 'awaiting-user' ? 'awaiting-user' : runtime.reason,
    retry_at: pending?.targetAt ?? null,
    auto_loop: row?.auto_loop === 1,
    auto_loop_ready: row?.auto_loop_ready === 1,
    no_progress_streak: row?.no_progress_streak ?? 0,
  }
}

/** Durable instructions join the next iteration, never a stale engine session. */
export function queueInstruction(
  workspaceId: string,
  content: string,
  clientMessageId: string,
  source?: MessageSource,
): boolean {
  if (hasLoopMessage(workspaceId, clientMessageId)) {
    enqueueLoopMessage(workspaceId, content, clientMessageId, source)
    return true
  }
  const row = getRow(workspaceId)
  if (!row?.auto_loop) return false
  if (row.archived_at || row.worktree_purged_at || isWorkspaceLifecycleBusy(workspaceId))
    throw new Error('Workspace is unavailable')
  enqueueLoopMessage(workspaceId, content, clientMessageId, source)
  spawnNextIteration(workspaceId)
  return true
}

/** Incomplete work keeps its intent, but requires an explicit human resume. */
export function block(workspaceId: string, reason: string): void {
  if (getRow(workspaceId)?.auto_loop !== 1) return
  quotaBackoffService.cancel(workspaceId, 'completed')
  setRuntime(workspaceId, { state: 'blocked', reason })
}

/** Read-only explanation of the shared admission gate; does not consume or reschedule work. */
export function getAutomaticAdmissionStatus(workspaceId: string): AutomaticAdmissionStatus {
  const row = getRow(workspaceId)
  const running = orchestrator.runningAgentCount()
  const configuredLimit = settingsService.getGlobalSettings().maxConcurrentAgents
  const limit = typeof configuredLimit === 'number' && configuredLimit > 0 ? configuredLimit : 0
  let reason: AutomaticAdmissionReason | null = null
  if (!row) reason = 'not-found'
  else if (row.archived_at) reason = 'archived'
  else if (row.worktree_purged_at) reason = 'purged'
  else if (orchestrator.isShuttingDown()) reason = 'shutdown'
  else if (isWorkspaceLifecycleBusy(workspaceId)) reason = 'lifecycle'
  else if (orchestrator.hasController(workspaceId)) reason = 'active-session'
  else if (row.status === 'awaiting-user') reason = 'awaiting-user'
  else if (row.status === 'compacting') reason = 'compacting'
  // Manual schedules can resume an expired quota; active loops remain owned by quota recovery.
  else if ((row.status === 'quota' && row.auto_loop === 1) || quotaBackoffService.getPending(workspaceId))
    reason = 'quota'
  else if (getRuntime(workspaceId).state === 'blocked') reason = 'blocked'
  else if (limit > 0 && running >= limit) reason = 'capacity'
  return { allowed: reason === null, reason, running, limit }
}

/** Shared admission gate for all unattended starts. Manual launches remain exempt. */
export function canStartAutomatically(workspaceId: string): boolean {
  return getAutomaticAdmissionStatus(workspaceId).allowed
}

/**
 * Enable auto-loop for the workspace. Spawns immediately if idle + pending
 * tasks. If the initial spawn fails (e.g. worktree missing, engine misconfig),
 * re-throws so the HTTP caller gets a 4xx; the mission remains explicitly blocked.
 */
export function enable(workspaceId: string): void {
  const row = getRow(workspaceId)
  if (!row) throw new Error(`Workspace '${workspaceId}' not found`)
  if (row.archived_at) throw new Error(`Workspace '${workspaceId}' is already archived`)
  if (row.worktree_purged_at) throw new Error(`Workspace '${workspaceId}' is unavailable`)
  if (isWorkspaceLifecycleBusy(workspaceId)) throw new Error(`Workspace '${workspaceId}' is busy`)
  if (row.auto_loop_ready !== 1 && !row.auto_loop) {
    throw new Error(`Workspace '${workspaceId}' is not ready for auto-loop (run grooming first)`)
  }

  // Refuse to enable when there is nothing to spawn — without this, auto_loop
  // would flip to 1 silently with no iteration running, locking the chat input
  // (auto-loop banner) without doing any work. The user must add a task or
  // unmark a done task before re-enabling.
  const pending = countPendingTasks(workspaceId)
  if (pending === 0 && !row.auto_loop) {
    throw new Error(`Workspace '${workspaceId}' has no pending tasks; add or unmark a task before enabling auto-loop`)
  }

  if (
    getRuntime(workspaceId).state === 'blocked' &&
    row.status === 'quota' &&
    !quotaBackoffService.getPending(workspaceId) &&
    !orchestrator.hasController(workspaceId)
  )
    updateWorkspaceStatus(workspaceId, 'idle')
  const db = getDb()
  db.prepare('UPDATE workspaces SET auto_loop = 1, no_progress_streak = 0 WHERE id = ?').run(workspaceId)
  orchestrator.resetAutoLoopRetries(workspaceId)
  db.prepare('DELETE FROM auto_loop_progress WHERE workspace_id=?').run(workspaceId)
  setRuntime(workspaceId, {
    state: 'waiting',
    reason: null,
    diagnostic_attempts: 0,
    phase: row.auto_loop_ready ? 'execution' : 'grooming',
  })
  emitEphemeral(workspaceId, 'autoloop:enabled', {})

  if (orchestrator.hasController(workspaceId)) return
  // spawnNextIteration throws on initial spawn failure (see flag).
  spawnNextIteration(workspaceId, { throwOnStartAgentError: true })
}

/**
 * Disable auto-loop. Idempotent: if the flag is already 0, returns without
 * emitting a duplicate `autoloop:disabled` event.
 */
export function disable(workspaceId: string, reason: DisableReason): void {
  const row = getRow(workspaceId)
  if (row?.auto_loop !== 1) return
  if (reason === 'error' || reason === 'stall' || reason === 'awaiting-clarification') {
    block(workspaceId, reason)
    return
  }
  const db = getDb()
  quotaBackoffService.cancel(workspaceId, 'completed')
  setRuntime(workspaceId, { state: reason === 'completed' ? 'completed' : 'stopped', reason })
  db.prepare('UPDATE workspaces SET auto_loop = 0 WHERE id = ?').run(workspaceId)
  const diagnostic = {
    reason,
    tasksPending: countPendingTasks(workspaceId),
    noProgressStreak: row.no_progress_streak,
    status: row.status,
  }
  console.info(
    `[auto-loop] disabled workspace '${workspaceId}' reason=${reason}` +
      ` pending=${diagnostic.tasksPending} streak=${diagnostic.noProgressStreak} status=${diagnostic.status}`,
  )
  emitEphemeral(workspaceId, 'autoloop:disabled', diagnostic)

  // Only actual disable transitions fire this hook. A blocked mission retains its intent.
  void lifecycleHookService.onAutoLoopDisabled(workspaceId, {
    reason,
    tasksPending: diagnostic.tasksPending,
  })

  // The loop finished every task — run the project's cleanup script. Other
  // disable reasons (stall / error / user-action) leave tasks unfinished, so
  // they intentionally skip the cleanup.
  if (reason === 'completed') {
    cleanupScriptService.onAutoLoopCompleted(workspaceId)
  }
}

/**
 * Route a `session:ended` event into the auto-loop state machine.
 *
 * Called by orchestrator.handleEvent. The delta records whether task state
 * progressed during this session, including transitions such as pending to
 * in_progress, not only completion.
 * Instruction-intake turns preserve the stagnation budget: their prompt only
 * integrates requirements. The orchestrator reports them after settling delivery.
 *
 * When status is `quota` we skip spawning: the orchestrator's handleQuota
 * already scheduled a backoff timer and will call `onQuotaBackoffExpired` once
 * the window closes — that function owns the next spawn in that case.
 */
export function onSessionEnded(
  workspaceId: string,
  reason: 'completed' | 'error' | 'killed' | 'watchdog',
  taskProgressDelta: number,
  instructionIntake = false,
): void {
  const row = getRow(workspaceId)
  if (!row) return
  if (row.auto_loop !== 1) return
  const settledInstructions = settleLoopMessages(
    workspaceId,
    getRuntime(workspaceId).current_session_id,
    reason === 'completed',
  )
  // The orchestrator may already have settled this exact turn's deliveries.
  instructionIntake ||= settledInstructions > 0
  if (listLoopMessages(workspaceId).some((m) => m.state === 'unknown')) {
    block(workspaceId, 'message-delivery-unknown')
    return
  }

  // When a quota backoff is in flight (orchestrator.handleQuota scheduled a
  // timer), let that timer own the next spawn so the backoff delay is respected.
  if (row.status === 'quota') return

  // Don't spawn a competing session while paused on canUseTool — the user
  // will resume the deferred turn explicitly.
  if (row.status === 'awaiting-user' || row.status === 'compacting') return

  // A watchdog denotes Kōbō's own forced recovery from a stuck engine stream.
  // The orchestrator owns its bounded backoff/retry path; counting it as a
  // normal no-progress iteration would falsely disable an otherwise healthy
  // loop after three SDK teardown timeouts.
  if (reason === 'watchdog') return

  if (reason === 'error') {
    block(workspaceId, 'error')
    return
  }

  if (getRuntime(workspaceId).state === 'blocked') return
  if (row.auto_loop_ready === 1 && countPendingTasks(workspaceId) === 0 && listLoopMessages(workspaceId).length === 0) {
    spawnNextIteration(workspaceId)
    return
  }
  const db = getDb()
  const runtime = getRuntime(workspaceId)
  const streak = taskProgressDelta > 0 ? 0 : row.no_progress_streak + (instructionIntake ? 0 : 1)
  db.prepare('UPDATE workspaces SET no_progress_streak=? WHERE id=?').run(streak, workspaceId)
  if (taskProgressDelta > 0) setRuntime(workspaceId, { diagnostic_attempts: 0 })
  // One diagnostic session after three stagnant iterations, followed by two attempts.
  if (!instructionIntake && taskProgressDelta <= 0 && runtime.diagnostic_attempts >= 3) {
    block(
      workspaceId,
      'No progress after diagnostic and two further attempts. Review the session findings and resume after resolving the blocker.',
    )
    return
  }

  spawnNextIteration(workspaceId)
}

/**
 * Re-register auto-loop timers at server boot. For every non-archived workspace
 * with `auto_loop=true` and no active controller, either spawn the next
 * iteration (if pending tasks exist) or disable with reason=completed.
 */
export function rehydrate(): void {
  try {
    const db = getDb()
    const interrupted = db
      .prepare("SELECT DISTINCT workspace_id FROM auto_loop_messages WHERE state='dispatching'")
      .all() as { workspace_id: string }[]
    for (const row of interrupted)
      if (!orchestrator.hasController(row.workspace_id)) recoverLoopMessages(row.workspace_id)
    const rows = db.prepare('SELECT id FROM workspaces WHERE auto_loop = 1 AND archived_at IS NULL').all() as Array<{
      id: string
    }>

    for (const { id } of rows) {
      try {
        if (orchestrator.hasController(id)) continue
        recoverLoopMessages(id)
        if (listLoopMessages(id).some((m) => m.state === 'unknown')) {
          block(id, 'message-delivery-unknown')
          continue
        }
        if (getRuntime(id).state === 'blocked') continue
        const row = getRow(id)
        if (row?.status === 'quota') {
          if (!quotaBackoffService.getPending(id))
            quotaBackoffService.arm(id, 15_000, {
              resetsAt: null,
              source: 'fallback_ladder',
              reason: 'quota',
              retryCount: 1,
            })
          continue
        }
        spawnNextIteration(id)
      } catch (err) {
        console.error(`[auto-loop-service] rehydrate failed for workspace ${id}:`, err)
      }
    }
  } catch (err) {
    console.error('[auto-loop-service] rehydrate failed:', err)
  }
}

/** Clear in-memory state on workspace delete. Placeholder — nothing cached today. */
export function forgetAutoLoopState(workspaceId: string): void {
  void workspaceId
}

// ── Internal ──────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = `[Kōbō auto-loop — iteration #{n}{sessionModeSuffix}]

Current pending task (workspace order; finalization follows all todos and criteria):
- Task ID: {taskId}
- Title: {taskTitle}
- Is acceptance criterion: {isAcceptanceCriterion}
{overrideBlock}
Throughout the steps below, keep the workspace description current via \`kobo__set_workspace_agent_description(description)\` so the user sees your state in the sidebar without opening the workspace. Update it at the start of the iteration (e.g. "Iter #{n}: implementing <short task title>") AND whenever your focus shifts (e.g. "Running tests", "Awaiting code review", "Fixing review feedback", "Marking task done"). Plain text, ≤200 chars.

Your job this iteration:
1. Read \`kobo__list_tasks\` to see all tasks and the big picture.
   When prior-session context is useful, call \`kobo__read_workspace_events_csv\` to read the paginated user/agent history for this workspace. Use a small \`limit\` and follow \`nextOffset\` only as needed.
2. Implement the SINGLE task above and nothing else. Do not pick a different task.
3. Run the project's quality checks (lint, typecheck, tests). Check \`.ai/.git-conventions.md\` for the exact commands if unclear.
4. If checks fail, fix until they pass. If blocked, leave the task unchanged and explain in chat.
5. Commit with a conventional message (\`feat: [short description]\` or similar per repo conventions).
6. {reviewGate}
7. Act on the review:
   - If Critical/Important issues: fix them, amend or add a fix-up commit, re-run checks from step 3. Do NOT mark_task_done.
   - If only Minor issues: fix them if trivial (< 2 min), otherwise note them in the chat and proceed.
   - If approved with no issues: proceed.
8. Only if the review cleared (or only minor notes remain), call \`kobo__mark_task_done(taskId="{taskId}")\`.

Do NOT modify other tasks' state. Do NOT create a PR. Do NOT skip the checks.
Do NOT run \`kill\`, \`pkill\`, \`killall\`, \`pgrep -k\`, or any process-killing command — you may tear down the Kōbō server itself or sibling dev servers. If a dev server needs restarting, let the user do it.
When you're done (success or blocked), end your turn cleanly.`

/**
 * Resolve the active auto-loop review gate sentence (step 6 of the iteration
 * prompt) for the current global skill suite, honouring any user override in
 * `custom` mode. On the default `superpowers` suite this returns the same
 * text that was historically inlined into PROMPT_TEMPLATE.
 */
function getActiveAutoLoopReviewGate(): string {
  const global = settingsService.getGlobalSettings()
  return getSuitePrompts(global.skillSuite, {
    autoLoopReviewGate: global.customAutoLoopReviewGate,
  }).autoLoopReviewGate
}

function pickNextTask(workspaceId: string): Task | null {
  const pending = listTasks(workspaceId).filter((t) => t.status !== 'done')
  if (pending.length === 0) return null
  return pending.find((t) => !isFinalTask(t)) ?? pending[0] ?? null
}

function isFinalTask(task: Task): boolean {
  return task.role === 'finalization'
}

function ensureFinalVerification(workspaceId: string): void {
  const tasks = listTasks(workspaceId)
  if (!tasks.some(isFinalTask)) {
    createTask(workspaceId, {
      title: '[FINAL] Verify all todos and acceptance criteria',
      sortOrder: Math.max(-1, ...tasks.map((t) => t.sortOrder)) + 1,
    })
  } else {
    // Legacy completed finalizations have no evidence: preserve work but revalidate completion.
    getDb()
      .prepare(
        "UPDATE tasks SET status='pending' WHERE workspace_id=? AND role='finalization' AND status='done' AND verification IS NULL",
      )
      .run(workspaceId)
  }
}

/**
 * Pick the next task, build the prompt, call `orchestrator.startAgent`.
 *
 * When called by `onSessionEnded` / `rehydrate`, `startAgent` throws are
 * swallowed and the loop is blocked with the failure reason. When called from
 * `enable` (initial user-driven spawn), we want the HTTP endpoint to surface
 * the failure instead of lying with 200, so the caller passes
 * `throwOnStartAgentError: true` and we re-throw after disabling.
 *
 * Worktree-missing edge: if the worktree directory has been deleted on disk,
 * `orchestrator.startAgent` throws during engine.start — caught below.
 */
/**
 * Whether another unattended session may start right now. Fresh installs use
 * a limit of 2; an explicit 0 means unlimited. Auto-loop, cron and wakeup
 * launches share admission, while manual launches remain exempt.
 */
function hasFreeAgentSlot(): boolean {
  const limit = settingsService.getGlobalSettings().maxConcurrentAgents
  if (!limit || limit <= 0) return true
  return orchestrator.runningAgentCount() < limit
}

/**
 * Give every auto-loop workspace parked on "waiting for a free agent slot"
 * another chance. Called by the orchestrator after ANY session ends: a parked
 * workspace has no session of its own to end, so nothing else would ever ask
 * spawnNextIteration on its behalf again.
 *
 * Stops as soon as the slots are full again, so with three parked and one
 * free, exactly one starts and the other two keep waiting rather than each
 * re-announcing that they wait.
 */
export function resumeWaitingWorkspaces(excluded: ReadonlySet<string> = new Set()): void {
  if (orchestrator.isShuttingDown()) return
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, status FROM workspaces
        WHERE auto_loop = 1 AND archived_at IS NULL
        ORDER BY updated_at ASC`,
    )
    .all() as Array<{ id: string; status: string }>
  for (const row of rows) {
    if (excluded.has(row.id)) continue
    if (!hasFreeAgentSlot()) return
    if (orchestrator.hasController(row.id)) continue
    // Same guards as spawnNextIteration's own callers: a quota backoff or a
    // pending question owns the next start of that workspace.
    if (row.status === 'awaiting-user' || row.status === 'compacting' || row.status === 'quota') continue
    try {
      spawnNextIteration(row.id)
    } catch (err) {
      console.error(`[auto-loop] resume after slot freed failed for workspace '${row.id}':`, err)
    }
  }
}

function spawnNextIteration(workspaceId: string, opts: { throwOnStartAgentError?: boolean } = {}): void {
  // Lifecycle/ready callbacks can outlive timer suspension; preserve their persisted loop intent.
  if (orchestrator.isShuttingDown()) return
  const row = getRow(workspaceId)
  if (!row || row.archived_at || !row.auto_loop) return
  if (deferUntilWorkspaceAvailable(workspaceId, resumeWaitingWorkspaces)) return
  if (!canStartAutomatically(workspaceId)) {
    if (getRuntime(workspaceId).state !== 'blocked' && !orchestrator.hasController(workspaceId)) {
      setRuntime(workspaceId, { state: 'waiting', reason: row.status === 'quota' ? 'quota' : 'capacity-or-lifecycle' })
      if (!hasFreeAgentSlot())
        emitEphemeral(workspaceId, 'autoloop:waiting-for-slot', {
          running: orchestrator.runningAgentCount(),
          limit: settingsService.getGlobalSettings().maxConcurrentAgents,
        })
    }
    return
  }
  if (listLoopMessages(workspaceId).some((m) => m.state === 'unknown' || m.state === 'dispatching')) {
    block(workspaceId, 'message-delivery-unknown')
    return
  }
  const grooming = row.auto_loop_ready !== 1
  if (listLoopMessages(workspaceId).some((m) => m.state === 'pending')) invalidateTaskFinalization(getDb(), workspaceId)
  if (!grooming) ensureFinalVerification(workspaceId)
  const task = grooming ? null : pickNextTask(workspaceId)
  const pendingInstructions = listLoopMessages(workspaceId).filter((m) => m.state === 'pending')
  if (!grooming && !task && pendingInstructions.length === 0) {
    disable(workspaceId, 'completed')
    return
  }
  const runtime = getRuntime(workspaceId)
  const diagnostic = row.no_progress_streak >= NO_PROGRESS_STALL_THRESHOLD && runtime.diagnostic_attempts === 0
  const iterationNumber = runtime.iteration + 1
  // Override block: replaces the standard iteration prompt body when the task
  // title carries a recognized prefix (case-sensitive, trailing space required).
  // Empty string otherwise so the placeholder collapses cleanly in PROMPT_TEMPLATE.
  // A title cannot literally start with both prefixes, so the order of these
  // branches is purely cosmetic.
  const projectSettings = settingsService.getProjectSettings(row.project_path)
  const e2eSettings = projectSettings?.e2e ?? { framework: '', skill: '', prompt: '' }
  // Finalization cascades project || global; E2E stays project-only.
  const finalizationSettings = settingsService.getEffectiveFinalization(row.project_path)

  let overrideBlock = ''
  if (task && isFinalTask(task)) {
    overrideBlock = buildFinalizationIterationBlock(finalizationSettings)
  } else if (task?.title.startsWith('[E2E] ') && e2eSettings.framework) {
    overrideBlock = buildE2eIterationBlock(e2eSettings)
  }

  const continuousSession = row.auto_loop_session_mode === 'continuous'

  let prompt = PROMPT_TEMPLATE.replaceAll('{n}', String(iterationNumber))
    .replaceAll('{sessionModeSuffix}', continuousSession ? ', session continue' : '')
    .replaceAll('{taskId}', task?.id ?? '')
    .replaceAll('{taskTitle}', task?.title ?? '')
    .replaceAll('{isAcceptanceCriterion}', String(task?.isAcceptanceCriterion ?? false))
    .replaceAll('{overrideBlock}', overrideBlock)
    .replaceAll('{reviewGate}', getActiveAutoLoopReviewGate())

  if (grooming)
    prompt = `[Kōbō auto-loop — resume grooming]
Resume the interrupted preparation. Read the workspace conversation with kobo__read_workspace_events_csv, recover the user's goal and constraints, and inspect existing tasks before making changes. Do not duplicate tasks.
${buildAutoLoopGroomingSteps(e2eSettings, finalizationSettings)}
${AUTO_LOOP_HARD_RULES}`
  if (diagnostic)
    prompt = `[Kōbō auto-loop — diagnostic]
Three iterations produced no task progress. Read recent workspace events, explain the blocker, and try a different approach or decompose the task. Never mark unfinished or unverified work done. If intervention is required, state the precise action needed.
${prompt}`
  prompt += `\n${AUTO_LOOP_ITERATION_RULES}`

  const globalSettings = settingsService.getGlobalSettings()
  const projectSlug = globalSettings.worktreesPrefixByProject
    ? slugifyProjectName(projectSettings?.displayName ?? '', row.project_path)
    : undefined
  const worktreePath =
    row.worktree_path ??
    resolveWorkspaceWorktreePath(row.project_path, row.working_branch, globalSettings.worktreesPath, projectSlug)
  const storedMode = row.agent_permission_mode
  const agentPermissionMode =
    storedMode === 'bypass' || storedMode === 'strict' || storedMode === 'interactive' ? storedMode : 'plan'
  if (!grooming && agentPermissionMode === 'plan') {
    const message =
      'Execution requires an explicit permission choice. Change this workspace from Plan to an execution mode (strict, interactive where supported, or bypass), then resume auto-loop. Permissions were not changed.'
    block(workspaceId, message)
    if (opts.throwOnStartAgentError) throw new Error(message)
    return
  }

  // Pre-check: if the worktree directory is gone (user `rm -rf`-ed it),
  // fail loudly rather than letting startAgent throw a deep engine error.
  if (!fs.existsSync(worktreePath)) {
    const msg = `Worktree directory missing: ${worktreePath}`
    console.error('[auto-loop-service]', msg)
    block(workspaceId, msg)
    if (opts.throwOnStartAgentError) throw new Error(msg)
    return
  }

  let agentSessionId: string | undefined
  const instructions = claimLoopMessages(workspaceId)
  if (instructions.length)
    prompt = `[Kōbō auto-loop — integrate user instructions]\nRead kobo__list_tasks and relevant workspace history. Integrate the following instructions into the todos and acceptance criteria, preserving the user's constraints. Update existing tasks and create missing ones before ending this turn. Do not implement or finalize work during this intake turn: the next iteration will select the updated highest-priority task. Leave finalization open.\n${instructions.map((m) => `- ${m.content}`).join('\n')}\n${grooming ? prompt : AUTO_LOOP_ITERATION_RULES}`
  try {
    const agent = orchestrator.startAgent(
      workspaceId,
      worktreePath,
      prompt,
      row.model,
      // resume=false spawns a fresh session per iteration (default); resume=true
      // (auto_loop_session_mode='continuous') resumes the workspace's last
      // session so the agent keeps full context across tasks. When there is no
      // prior session to resume (e.g. the very first iteration), orchestrator's
      // resolveSessionForResume gracefully falls back to a fresh session — no
      // special-casing needed here.
      grooming || continuousSession,
      agentPermissionMode,
      undefined,
      row.reasoning_effort,
    )
    agentSessionId = agent.agentSessionId
    if (agentSessionId) bindLoopMessages(workspaceId, agentSessionId)
    setRuntime(workspaceId, {
      phase: grooming ? 'grooming' : task && isFinalTask(task) ? 'finalization' : 'execution',
      state: 'active',
      reason: null,
      iteration: iterationNumber,
      current_task_id: task?.id ?? null,
      current_session_id: agentSessionId ?? null,
      // An intake prompt replaces the diagnostic/work prompt and forbids implementation.
      diagnostic_attempts: instructions.length
        ? runtime.diagnostic_attempts
        : diagnostic
          ? 1
          : runtime.diagnostic_attempts > 0
            ? runtime.diagnostic_attempts + 1
            : 0,
    })
  } catch (err) {
    // Synchronous rejection precedes dispatch; return only this unbound claim to the queue.
    getDb()
      .prepare(
        "UPDATE auto_loop_messages SET state='pending' WHERE workspace_id=? AND state='dispatching' AND session_id IS NULL",
      )
      .run(workspaceId)
    console.error('[auto-loop-service] startAgent failed:', err)
    block(workspaceId, err instanceof Error ? err.message : String(err))
    if (opts.throwOnStartAgentError) throw err
    return
  }

  // Persist the iteration prompt as a system-prompt message so the user can
  // see exactly what was sent to Claude when they switch to this auto-loop
  // session in the UI. Tagged with the new agentSessionId so the per-session
  // filter picks it up only on its own session.
  emit(workspaceId, 'user:message', { content: prompt, sender: 'system-prompt' }, agentSessionId)

  const tasksPending = countPendingTasks(workspaceId)
  const tasksDone = countDoneTasks(workspaceId)
  emitEphemeral(workspaceId, 'autoloop:iteration-started', {
    iterationNumber,
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? 'Grooming',
    tasksPending,
    tasksDone,
  })
}

/**
 * Called by orchestrator.handleQuota's backoff timer when auto-loop is enabled.
 * Spawns the next auto-loop iteration if the workspace is still in quota status
 * with auto_loop active; no-ops otherwise (race-safe).
 *
 * No-op cases — leave the workspace unchanged:
 *   - workspace was deleted between arm and fire
 *   - workspace was archived during the backoff window
 *   - `auto_loop !== 1` (workspace was never an auto-loop target, OR the user
 *     toggled the loop off during the backoff window)
 *   - `status !== 'quota'` (user already manually resumed, or another path
 *     transitioned the workspace)
 */
const pendingQuotaStops = new Set<string>()
const QUOTA_STOP_RETRY_MS = 15_000

function deferQuotaRetry(workspaceId: string, pending?: quotaBackoffService.PendingQuotaBackoff): void {
  const attempt = pending ?? quotaBackoffService.getPending(workspaceId)
  quotaBackoffService.arm(workspaceId, QUOTA_STOP_RETRY_MS, {
    resetsAt: attempt?.resetsAt ?? null,
    source: attempt?.source ?? 'fallback_ladder',
    reason: attempt?.reason ?? 'quota',
    retryCount: attempt?.retryCount ?? 1,
  })
}

export function onQuotaBackoffExpired(workspaceId: string, pending?: quotaBackoffService.PendingQuotaBackoff): void {
  const row = getRow(workspaceId)
  if (!row) return
  if (row.archived_at !== null) return
  if (row.auto_loop !== 1) return
  if (row.status !== 'quota') return
  if (pendingQuotaStops.has(workspaceId) || orchestrator.isShuttingDown() || isWorkspaceLifecycleBusy(workspaceId)) {
    deferQuotaRetry(workspaceId, pending)
    return
  }
  if (orchestrator.hasController(workspaceId)) {
    pendingQuotaStops.add(workspaceId)
    const stopped = orchestrator.stopAgentAndWait(workspaceId, undefined, 'replacement')
    // The timer already consumed its row. Persist recovery immediately, after the
    // technical stop's synchronous cancellation, so shutdown/crash during the await loses no intent.
    deferQuotaRetry(workspaceId, pending)
    void stopped
      .then((outcome) => {
        // Stop, archive, or a manual replacement may have superseded this retry while we awaited the engine.
        const current = getRow(workspaceId)
        if (!current || current.archived_at || !current.auto_loop || current.status !== 'quota') return
        if (outcome === 'timeout' || outcome === 'failed' || orchestrator.isShuttingDown()) {
          deferQuotaRetry(workspaceId, pending)
          return
        }
        updateWorkspaceStatus(workspaceId, 'idle')
        quotaBackoffService.cancel(workspaceId, 'completed')
        spawnNextIteration(workspaceId)
      })
      .catch((err) => {
        console.error(`[auto-loop] quota controller stop failed for '${workspaceId}':`, err)
      })
      .finally(() => pendingQuotaStops.delete(workspaceId))
    return
  }
  // The timer has consumed its persisted row. Release quota ownership before
  // checking capacity so resumeWaitingWorkspaces can pick this workspace up
  // when a slot frees, even if no agent can start at this instant.
  updateWorkspaceStatus(workspaceId, 'idle')
  emitEphemeral(workspaceId, 'agent:quota-backoff-cancelled', { reason: 'completed' })
  spawnNextIteration(workspaceId)
}

/**
 * Called when a workspace transitions to auto_loop_ready=true (grooming done).
 * If the loop is armed (auto_loop=1) and tasks exist, spawns the first iteration.
 * This handles the creation-time autoLoop flag: the brainstorming session ends
 * without triggering a spawn (auto_loop_ready was false), so this function
 * starts the loop once the user completes grooming.
 */
export function onAutoLoopReadySet(workspaceId: string): void {
  const row = getRow(workspaceId)
  if (!row) return
  if (row.auto_loop !== 1) return
  if (row.archived_at !== null) return
  if (orchestrator.hasController(workspaceId)) return
  if (countPendingTasks(workspaceId) === 0) return
  spawnNextIteration(workspaceId)
}

// ── Test-only ─────────────────────────────────────────────────────────────────

/** @internal */
export function _test_setAutoLoopReady(workspaceId: string, ready: boolean): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET auto_loop_ready = ? WHERE id = ?').run(ready ? 1 : 0, workspaceId)
}

/** @internal */
export function _test_setAutoLoopSessionMode(workspaceId: string, mode: 'per_task' | 'continuous'): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET auto_loop_session_mode = ? WHERE id = ?').run(mode, workspaceId)
}

/** @internal */
export function _test_pickNextTask(workspaceId: string): Task | null {
  return pickNextTask(workspaceId)
}
