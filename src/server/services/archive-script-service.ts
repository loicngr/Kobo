import fs from 'node:fs'
import { getDb } from '../db/index.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { runScript, SCRIPT_TIMEOUT_MS, type ScriptEnv } from '../utils/script-runner.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import { getEffectiveSettings, getGlobalSettings, getProjectSettings } from './settings-service.js'

interface ArchiveWorkspaceRow {
  id: string
  name: string
  project_path: string
  working_branch: string
  source_branch: string
  worktree_path: string | null
}

function getRow(workspaceId: string): ArchiveWorkspaceRow | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, name, project_path, working_branch, source_branch, worktree_path
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as ArchiveWorkspaceRow | undefined
  return row ?? null
}

/** Execute the archive script in a worktree, streaming `archive:*` WS events. */
export function runArchiveScript(
  workspaceId: string,
  worktreePath: string,
  script: string,
  env?: ScriptEnv,
): Promise<{ exitCode: number }> {
  return runScript({
    workspaceId,
    worktreePath,
    script,
    eventPrefix: 'archive',
    tmpFileName: '.archive-script.tmp',
    env,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  })
}

/**
 * Hook for the `POST /api/workspaces/:id/archive` route — runs the project's
 * archive script (if configured) after a workspace is archived. The worktree is
 * still on disk at archive time (archiving is a soft-delete). Best-effort: never
 * blocks or fails the archive operation.
 */
export function onWorkspaceArchived(workspaceId: string): void {
  try {
    const row = getRow(workspaceId)
    if (!row) return

    const effective = getEffectiveSettings(row.project_path)
    const script = effective.archiveScript
    if (!script.trim()) return // empty = disabled

    const global = getGlobalSettings()
    const projectSettings = getProjectSettings(row.project_path)
    const projectSlug = global.worktreesPrefixByProject
      ? slugifyProjectName(projectSettings?.displayName ?? '', row.project_path)
      : undefined
    const worktreePath =
      row.worktree_path ??
      resolveWorkspaceWorktreePath(row.project_path, row.working_branch, global.worktreesPath, projectSlug)

    if (!fs.existsSync(worktreePath)) {
      console.warn(`[archive-script-service] worktree missing, skipping archive script: ${worktreePath}`)
      return
    }

    void runArchiveScript(workspaceId, worktreePath, script, {
      workspaceName: row.name,
      branchName: row.working_branch,
      sourceBranch: row.source_branch,
      projectPath: row.project_path,
    }).catch((err) => {
      console.error('[archive-script-service] runArchiveScript failed:', err)
    })
  } catch (err) {
    console.error('[archive-script-service] onWorkspaceArchived failed:', err)
  }
}
