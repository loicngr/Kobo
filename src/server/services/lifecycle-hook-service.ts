import fs from 'node:fs'
import { getDb } from '../db/index.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { runScript } from '../utils/script-runner.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import { getEffectiveSettings, getGlobalSettings, getProjectSettings } from './settings-service.js'

/**
 * Lifecycle moments a user script can be attached to.
 *
 * Kōbō already ran user scripts on setup, cleanup, archive and
 * change-source-branch. These are the three moments that had no hook and that
 * the machine cannot act on by itself: a session ending, a PR being merged,
 * auto-loop giving up.
 */
export type LifecycleHookEvent = 'session-ended' | 'pr-merged' | 'autoloop-disabled'

/** Which effective-settings key holds the script for each event. */
const SCRIPT_KEY: Record<LifecycleHookEvent, 'sessionEndedScript' | 'prMergedScript' | 'autoLoopDisabledScript'> = {
  'session-ended': 'sessionEndedScript',
  'pr-merged': 'prMergedScript',
  'autoloop-disabled': 'autoLoopDisabledScript',
}

interface HookWorkspaceRow {
  id: string
  name: string
  project_path: string
  working_branch: string
  source_branch: string
  worktree_path: string | null
}

function getRow(workspaceId: string): HookWorkspaceRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, project_path, working_branch, source_branch, worktree_path
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as HookWorkspaceRow | undefined
  return row ?? null
}

/**
 * Run the user's hook for `event`, if they configured one.
 *
 * Resolves to `null` when there is nothing to run — no script, unknown
 * workspace, or a worktree that is no longer on disk — and to the script's exit
 * code otherwise. Never rejects: the caller is always in the middle of a
 * lifecycle transition that must complete regardless.
 */
export async function runLifecycleHook(
  event: LifecycleHookEvent,
  workspaceId: string,
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number } | null> {
  try {
    const row = getRow(workspaceId)
    if (!row) return null

    const script = getEffectiveSettings(row.project_path)[SCRIPT_KEY[event]]
    // Empty (or blank) means the user never wrote one. Hooks are opt-in: they
    // run arbitrary shell, so absence of configuration is absence of a hook.
    if (!script.trim()) return null

    const global = getGlobalSettings()
    const projectSettings = getProjectSettings(row.project_path)
    const projectSlug = global.worktreesPrefixByProject
      ? slugifyProjectName(projectSettings?.displayName ?? '', row.project_path)
      : undefined
    const worktreePath =
      row.worktree_path ??
      resolveWorkspaceWorktreePath(row.project_path, row.working_branch, global.worktreesPath, projectSlug)

    // A purged or manually deleted worktree has no cwd to spawn in. Routine
    // for `pr-merged` once auto-purge has run; for the other events it means
    // the user's script silently did not run, which deserves a line in the log.
    if (!fs.existsSync(worktreePath)) {
      if (event !== 'pr-merged') {
        console.warn(
          `[lifecycle-hook] '${event}' hook skipped for workspace '${workspaceId}': worktree missing at ${worktreePath}`,
        )
      }
      return null
    }

    return await runScript({
      workspaceId,
      worktreePath,
      script,
      // Namespaced per event: three hooks streaming into one `hook:output` feed
      // would be indistinguishable in the UI.
      eventPrefix: `hook:${event}`,
      tmpFileName: `.hook-${event}.tmp`,
      env: {
        workspaceName: row.name,
        branchName: row.working_branch,
        sourceBranch: row.source_branch,
        projectPath: row.project_path,
      },
      extraEnv: { ...extraEnv, KOBO_HOOK_EVENT: event },
    })
  } catch (err) {
    console.error(`[lifecycle-hook] '${event}' hook failed for workspace '${workspaceId}':`, err)
    return null
  }
}

/**
 * An agent session ended. Fires for every real end — clean finish, error, user
 * stop, watchdog kill — and lets the script tell them apart via
 * `KOBO_SESSION_END_REASON`. Typical use: run the test suite, or notify.
 */
export async function onSessionEnded(
  workspaceId: string,
  outcome: {
    sessionId: string
    reason: string
    exitCode: number | null
    /** Who stopped it (`user`, …); empty when the session ended on its own. */
    stopCause?: string
    /** Whether auto-loop is about to start the next iteration right away. */
    autoLoopActive?: boolean
  },
): Promise<void> {
  await runLifecycleHook('session-ended', workspaceId, {
    KOBO_SESSION_ID: outcome.sessionId,
    KOBO_SESSION_END_REASON: outcome.reason,
    // A missing exit code is an empty variable, not the string 'null': a shell
    // script testing `-z "$KOBO_SESSION_EXIT_CODE"` should see nothing there.
    KOBO_SESSION_EXIT_CODE: outcome.exitCode === null ? '' : String(outcome.exitCode),
    KOBO_SESSION_STOP_CAUSE: outcome.stopCause ?? '',
    // A hook that runs the test suite should know the next iteration may
    // already be editing the same files.
    KOBO_AUTOLOOP_ACTIVE: outcome.autoLoopActive ? '1' : '0',
  })
}

/**
 * A PR was merged. Runs before the workspace is archived or purged, so the
 * worktree is still on disk and the script can act on it (deploy, tag, notify).
 */
export async function onPrMerged(workspaceId: string, pr: { prNumber: number; prUrl: string }): Promise<void> {
  await runLifecycleHook('pr-merged', workspaceId, {
    KOBO_PR_NUMBER: String(pr.prNumber),
    KOBO_PR_URL: pr.prUrl,
  })
}

/**
 * Auto-loop turned itself off. `KOBO_AUTOLOOP_REASON` separates the loop
 * finishing its work from it stalling or erroring out — the difference between
 * a notification worth celebrating and one worth investigating.
 */
export async function onAutoLoopDisabled(
  workspaceId: string,
  info: { reason: string; tasksPending: number },
): Promise<void> {
  await runLifecycleHook('autoloop-disabled', workspaceId, {
    KOBO_AUTOLOOP_REASON: info.reason,
    KOBO_TASKS_PENDING: String(info.tasksPending),
  })
}
