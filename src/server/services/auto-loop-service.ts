import fs from 'node:fs'
import path from 'node:path'
import { buildE2eIterationBlock, buildFinalizationIterationBlock } from '../../shared/auto-loop-prompts.js'
import { getDb } from '../db/index.js'
import * as orchestrator from './agent/orchestrator.js'
import * as settingsService from './settings-service.js'
import { emit, emitEphemeral } from './websocket-service.js'
import { listTasks, type Task } from './workspace-service.js'

export interface AutoLoopStatus {
  auto_loop: boolean
  auto_loop_ready: boolean
  no_progress_streak: number
}

export type DisableReason = 'user-action' | 'completed' | 'stall' | 'error'

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
  no_progress_streak: number
  archived_at: string | null
}

function getRow(workspaceId: string): WorkspaceRow | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, project_path, working_branch, worktree_path, model, permission_mode, agent_permission_mode, reasoning_effort,
              status, auto_loop, auto_loop_ready, no_progress_streak, archived_at
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
  if (!row) return { auto_loop: false, auto_loop_ready: false, no_progress_streak: 0 }
  return {
    auto_loop: row.auto_loop === 1,
    auto_loop_ready: row.auto_loop_ready === 1,
    no_progress_streak: row.no_progress_streak,
  }
}

/**
 * Enable auto-loop for the workspace. Spawns immediately if idle + pending
 * tasks. If the initial spawn fails (e.g. worktree missing, engine misconfig),
 * re-throws so the HTTP caller gets a 4xx instead of a silent 200 — the
 * workspace will already have been auto-disabled by `spawnNextIteration`.
 */
export function enable(workspaceId: string): void {
  const row = getRow(workspaceId)
  if (!row) throw new Error(`Workspace '${workspaceId}' not found`)
  if (row.auto_loop_ready !== 1) {
    throw new Error(`Workspace '${workspaceId}' is not ready for auto-loop (run grooming first)`)
  }

  const db = getDb()
  db.prepare('UPDATE workspaces SET auto_loop = 1, no_progress_streak = 0 WHERE id = ?').run(workspaceId)
  emitEphemeral(workspaceId, 'autoloop:enabled', {})

  const pending = countPendingTasks(workspaceId)
  if (pending === 0) return
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
  if (!row || row.auto_loop !== 1) return
  const db = getDb()
  db.prepare('UPDATE workspaces SET auto_loop = 0 WHERE id = ?').run(workspaceId)
  emitEphemeral(workspaceId, 'autoloop:disabled', { reason })
}

/**
 * Route a `session:ended` event into the auto-loop state machine.
 *
 * Called by orchestrator.handleEvent. The delta is the number of tasks that
 * transitioned to `done` during this session (computed from a snapshot taken
 * at `session:started`).
 *
 * When status is `quota` we skip spawning: the orchestrator's handleQuota
 * already scheduled a backoff timer and will call `onQuotaBackoffExpired` once
 * the window closes — that function owns the next spawn in that case.
 */
export function onSessionEnded(
  workspaceId: string,
  reason: 'completed' | 'error' | 'killed',
  tasksDoneDelta: number,
): void {
  const row = getRow(workspaceId)
  if (!row) return
  if (row.auto_loop !== 1) return

  // When a quota backoff is in flight (orchestrator.handleQuota scheduled a
  // timer), let that timer own the next spawn so the backoff delay is respected.
  if (row.status === 'quota') return

  // Don't spawn a competing session while paused on canUseTool — the user
  // will resume the deferred turn explicitly.
  if (row.status === 'awaiting-user') return

  if (reason === 'error' || reason === 'killed') {
    disable(workspaceId, 'error')
    return
  }

  // When grooming hasn't run yet (auto_loop_ready=false), the loop is "armed"
  // but waiting for tasks to be created. Skip streak tracking and task checks —
  // onAutoLoopReadySet() will trigger the first spawn once grooming completes.
  if (row.auto_loop_ready !== 1) return

  const db = getDb()
  let streak: number
  if (tasksDoneDelta > 0) {
    db.prepare('UPDATE workspaces SET no_progress_streak = 0 WHERE id = ?').run(workspaceId)
    streak = 0
  } else {
    db.prepare('UPDATE workspaces SET no_progress_streak = no_progress_streak + 1 WHERE id = ?').run(workspaceId)
    streak = row.no_progress_streak + 1
  }

  if (streak >= NO_PROGRESS_STALL_THRESHOLD) {
    disable(workspaceId, 'stall')
    return
  }

  if (countPendingTasks(workspaceId) === 0) {
    disable(workspaceId, 'completed')
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
    const rows = db.prepare('SELECT id FROM workspaces WHERE auto_loop = 1 AND archived_at IS NULL').all() as Array<{
      id: string
    }>

    for (const { id } of rows) {
      try {
        if (orchestrator.hasController(id)) continue
        // Workspaces still in grooming (ready=0) have their session killed by
        // the server reload. Don't disable — the user can re-trigger grooming
        // manually. Auto-disable on missing pending tasks would also fire here
        // if the agent hadn't yet seeded any task before the reload.
        const row = getRow(id)
        if (row?.auto_loop_ready !== 1) continue
        if (countPendingTasks(id) === 0) {
          disable(id, 'completed')
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

const PROMPT_TEMPLATE = `[Kōbō auto-loop — iteration #{n}]

Current pending task (highest priority, non-acceptance-criterion first):
- Task ID: {taskId}
- Title: {taskTitle}
- Is acceptance criterion: {isAcceptanceCriterion}
{overrideBlock}
Your job this iteration:
1. Read \`kobo__list_tasks\` to see all tasks and the big picture.
2. Implement the SINGLE task above and nothing else. Do not pick a different task.
3. Run the project's quality checks (lint, typecheck, tests). Check \`.ai/.git-conventions.md\` for the exact commands if unclear.
4. If checks fail, fix until they pass. If blocked, leave the task unchanged and explain in chat.
5. Commit with a conventional message (\`feat: [short description]\` or similar per repo conventions).
6. Code review gate — BEFORE marking the task done, dispatch an independent code-reviewer subagent via the Task tool with \`subagent_type: "code-reviewer"\` (or \`"superpowers:code-reviewer"\` / \`"pr-review-toolkit:code-reviewer"\` — use whichever exists in this environment; fall back to \`superpowers:requesting-code-review\` skill if none is available). Brief the reviewer with: what you just implemented, the task title, and the commit SHA (via \`git rev-parse HEAD\`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean.
7. Act on the review:
   - If Critical/Important issues: fix them, amend or add a fix-up commit, re-run checks from step 3. Do NOT mark_task_done.
   - If only Minor issues: fix them if trivial (< 2 min), otherwise note them in the chat and proceed.
   - If approved with no issues: proceed.
8. Only if the review cleared (or only minor notes remain), call \`kobo__mark_task_done(taskId="{taskId}")\`.

Do NOT modify other tasks' state. Do NOT create a PR. Do NOT skip the checks.
Do NOT run \`kill\`, \`pkill\`, \`killall\`, \`pgrep -k\`, or any process-killing command — you may tear down the Kōbō server itself or sibling dev servers. If a dev server needs restarting, let the user do it.
When you're done (success or blocked), end your turn cleanly.`

function pickNextTask(workspaceId: string): Task | null {
  const pending = listTasks(workspaceId).filter((t) => t.status !== 'done')
  if (pending.length === 0) return null
  // Rule D: non-acceptance first, each group in sort_order (listTasks orders).
  const nonCriteria = pending.filter((t) => !t.isAcceptanceCriterion)
  const criteria = pending.filter((t) => t.isAcceptanceCriterion)
  return [...nonCriteria, ...criteria][0] ?? null
}

function computeIterationNumber(workspaceId: string): number {
  const done = countDoneTasks(workspaceId)
  const status = getStatus(workspaceId)
  return done + status.no_progress_streak + 1
}

/**
 * Pick the next task, build the prompt, call `orchestrator.startAgent`.
 *
 * When called by `onSessionEnded` / `rehydrate`, `startAgent` throws are
 * swallowed and the loop auto-disables (`reason: 'error'`). When called from
 * `enable` (initial user-driven spawn), we want the HTTP endpoint to surface
 * the failure instead of lying with 200, so the caller passes
 * `throwOnStartAgentError: true` and we re-throw after disabling.
 *
 * Worktree-missing edge: if the worktree directory has been deleted on disk,
 * `orchestrator.startAgent` throws during engine.start — caught below.
 */
function spawnNextIteration(workspaceId: string, opts: { throwOnStartAgentError?: boolean } = {}): void {
  const row = getRow(workspaceId)
  if (!row) return
  // Same guard as onSessionEnded — never race a deferred-resume start.
  if (row.status === 'awaiting-user') return
  const task = pickNextTask(workspaceId)
  if (!task) {
    disable(workspaceId, 'completed')
    return
  }

  const iterationNumber = computeIterationNumber(workspaceId)
  // Override block: replaces the standard iteration prompt body when the task
  // title carries a recognized prefix (case-sensitive, trailing space required).
  // Empty string otherwise so the placeholder collapses cleanly in PROMPT_TEMPLATE.
  // A title cannot literally start with both prefixes, so the order of these
  // branches is purely cosmetic.
  const projectSettings = settingsService.getProjectSettings(row.project_path)
  const e2eSettings = projectSettings?.e2e ?? { framework: '', skill: '', prompt: '' }
  const finalizationSettings = projectSettings?.finalization ?? { prompt: '' }

  let overrideBlock = ''
  if (task.title.startsWith('[FINAL] ')) {
    overrideBlock = buildFinalizationIterationBlock(finalizationSettings)
  } else if (task.title.startsWith('[E2E] ') && e2eSettings.framework) {
    overrideBlock = buildE2eIterationBlock(e2eSettings)
  }

  const prompt = PROMPT_TEMPLATE.replaceAll('{n}', String(iterationNumber))
    .replaceAll('{taskId}', task.id)
    .replaceAll('{taskTitle}', task.title)
    .replaceAll('{isAcceptanceCriterion}', String(task.isAcceptanceCriterion))
    .replaceAll('{overrideBlock}', overrideBlock)

  const worktreePath = row.worktree_path ?? path.join(row.project_path, '.worktrees', row.working_branch)
  // Plan mode would deadlock the loop (blocks MCP + edits) — promote to bypass.
  // Other modes (bypass/strict/interactive) are honored.
  const stored = (row.agent_permission_mode ?? 'bypass') as 'plan' | 'bypass' | 'strict' | 'interactive'
  const agentPermissionMode: 'bypass' | 'strict' | 'interactive' = stored === 'plan' ? 'bypass' : stored

  // Pre-check: if the worktree directory is gone (user `rm -rf`-ed it),
  // fail loudly rather than letting startAgent throw a deep engine error.
  if (!fs.existsSync(worktreePath)) {
    const msg = `Worktree directory missing: ${worktreePath}`
    console.error('[auto-loop-service]', msg)
    disable(workspaceId, 'error')
    if (opts.throwOnStartAgentError) throw new Error(msg)
    return
  }

  let agentSessionId: string | undefined
  try {
    const agent = orchestrator.startAgent(
      workspaceId,
      worktreePath,
      prompt,
      row.model,
      false, // resume=false — fresh context for each iteration
      agentPermissionMode,
      undefined,
      row.reasoning_effort,
    )
    agentSessionId = agent.agentSessionId
  } catch (err) {
    console.error('[auto-loop-service] startAgent failed:', err)
    disable(workspaceId, 'error')
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
    taskId: task.id,
    taskTitle: task.title,
    tasksPending,
    tasksDone,
  })
}

/**
 * Called by orchestrator.handleQuota's backoff timer when auto-loop is enabled.
 * Spawns the next auto-loop iteration if the workspace is still in quota status
 * with auto_loop active; no-ops otherwise (race-safe).
 */
export function onQuotaBackoffExpired(workspaceId: string): void {
  const row = getRow(workspaceId)
  if (!row) return
  if (row.auto_loop !== 1) return
  if (row.status !== 'quota') return
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
export function _test_pickNextTask(workspaceId: string): Task | null {
  return pickNextTask(workspaceId)
}
