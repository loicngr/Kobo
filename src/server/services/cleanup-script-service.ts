import fs from 'node:fs'
import { getDb } from '../db/index.js'
import { worktreeHasChanges } from '../utils/git-ops.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { runScript, SCRIPT_TIMEOUT_MS, type ScriptEnv } from '../utils/script-runner.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import {
  type CleanupScriptMode,
  getEffectiveSettings,
  getGlobalSettings,
  getProjectSettings,
} from './settings-service.js'

interface CleanupWorkspaceRow {
  id: string
  name: string
  project_path: string
  working_branch: string
  source_branch: string
  worktree_path: string | null
  archived_at: string | null
}

function getRow(workspaceId: string): CleanupWorkspaceRow | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, name, project_path, working_branch, source_branch, worktree_path, archived_at
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as CleanupWorkspaceRow | undefined
  return row ?? null
}

function countPendingTasks(workspaceId: string): number {
  const db = getDb()
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status != 'done'")
    .get(workspaceId) as { c: number }
  return row.c
}

/** Inputs for the pure cleanup-trigger decision. */
export interface CleanupDecisionInput {
  /** Session end reason from the agent engine. */
  reason: 'completed' | 'error' | 'killed'
  /** Whether the workspace was an active auto-loop target when the session ended. */
  wasAutoLoop: boolean
  /** True only on the auto-loop completion path (all tasks done) — bypasses the mode check. */
  autoLoopCompleted: boolean
  /** Resolved effective cleanup script — empty/whitespace means disabled. */
  script: string
  /** Resolved effective trigger mode. */
  mode: CleanupScriptMode
  /** Number of non-done Kōbō tasks left in the workspace. */
  pendingTasks: number
}

/**
 * Pure decision: should the cleanup script run? Encodes the full matrix so it
 * is unit-testable without a DB.
 *
 * - No script → never.
 * - Auto-loop completion → always (every task is done by definition).
 * - Otherwise the agent must have finished cleanly (`completed`).
 * - A mid-loop `session:ended` (`wasAutoLoop`) never triggers — only the loop's
 *   completion does.
 * - `no-tasks` mode additionally requires zero pending tasks; `idle` does not.
 */
export function shouldRunCleanup(input: CleanupDecisionInput): boolean {
  if (!input.script.trim()) return false
  if (input.autoLoopCompleted) return true
  if (input.reason !== 'completed') return false
  if (input.wasAutoLoop) return false
  if (input.mode === 'no-tasks' && input.pendingTasks > 0) return false
  return true
}

/** Execute the cleanup script in a worktree, streaming `cleanup:*` WS events. */
export function runCleanupScript(
  workspaceId: string,
  worktreePath: string,
  script: string,
  env?: ScriptEnv,
): Promise<{ exitCode: number }> {
  return runScript({
    workspaceId,
    worktreePath,
    script,
    eventPrefix: 'cleanup',
    tmpFileName: '.cleanup-script.tmp',
    env,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  })
}

function trigger(
  workspaceId: string,
  decision: { reason: 'completed' | 'error' | 'killed'; wasAutoLoop: boolean; autoLoopCompleted: boolean },
): void {
  try {
    const row = getRow(workspaceId)
    if (!row || row.archived_at) return

    const effective = getEffectiveSettings(row.project_path)
    if (
      !shouldRunCleanup({
        reason: decision.reason,
        wasAutoLoop: decision.wasAutoLoop,
        autoLoopCompleted: decision.autoLoopCompleted,
        script: effective.cleanupScript,
        mode: effective.cleanupScriptMode,
        pendingTasks: countPendingTasks(workspaceId),
      })
    ) {
      return
    }

    const global = getGlobalSettings()
    const projectSettings = getProjectSettings(row.project_path)
    const projectSlug = global.worktreesPrefixByProject
      ? slugifyProjectName(projectSettings?.displayName ?? '', row.project_path)
      : undefined
    const worktreePath =
      row.worktree_path ??
      resolveWorkspaceWorktreePath(row.project_path, row.working_branch, global.worktreesPath, projectSlug)

    if (!fs.existsSync(worktreePath)) {
      console.warn(`[cleanup-script-service] worktree missing, skipping cleanup: ${worktreePath}`)
      return
    }

    // Optional gate: only run when the worktree has uncommitted changes.
    if (effective.cleanupScriptOnlyOnChanges && !worktreeHasChanges(worktreePath)) {
      return
    }

    // Best-effort: never let a cleanup failure break the calling flow.
    void runCleanupScript(workspaceId, worktreePath, effective.cleanupScript, {
      workspaceName: row.name,
      branchName: row.working_branch,
      sourceBranch: row.source_branch,
      projectPath: row.project_path,
    }).catch((err) => {
      console.error('[cleanup-script-service] runCleanupScript failed:', err)
    })
  } catch (err) {
    console.error('[cleanup-script-service] trigger failed:', err)
  }
}

/**
 * Hook for orchestrator's `session:ended` handler. `wasAutoLoop` MUST be
 * captured before `auto-loop-service.onSessionEnded` runs, since `disable()`
 * clears the `auto_loop` flag.
 */
export function onSessionEnded(
  workspaceId: string,
  reason: 'completed' | 'error' | 'killed',
  opts: { wasAutoLoop: boolean },
): void {
  trigger(workspaceId, { reason, wasAutoLoop: opts.wasAutoLoop, autoLoopCompleted: false })
}

/**
 * Hook for `auto-loop-service.disable()` with `reason='completed'` — the loop
 * finished every task. Runs the cleanup regardless of trigger mode.
 */
export function onAutoLoopCompleted(workspaceId: string): void {
  trigger(workspaceId, { reason: 'completed', wasAutoLoop: false, autoLoopCompleted: true })
}
