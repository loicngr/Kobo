import fs from 'node:fs'
import * as agentManager from './agent/orchestrator.js'
import * as devServerService from './dev-server-service.js'
import { getForgeProvider } from './forge/registry.js'
import { resolveForge } from './forge/resolve.js'
import { destroyTerminal } from './terminal-service.js'
import { emitEphemeral } from './websocket-service.js'
import {
  archiveWorkspace,
  getWorkspace,
  markWorktreePurged,
  type WorktreePurgeRestoreData,
} from './workspace-service.js'
import { removeWorktree } from './worktree-service.js'

/**
 * Outcome of a purge attempt.
 *
 * - `purged` — the worktree was removed (or already missing) and the DB
 *   metadata was persisted. Success path.
 * - `already-purged` — the workspace was already marked purged; no-op.
 * - `worktree-not-owned` — the workspace attached to an external worktree
 *   (worktreeOwned=false); we refuse to touch it.
 * - `not-found` — unknown workspace id.
 */
export type PurgeOutcome = 'purged' | 'already-purged' | 'worktree-not-owned' | 'not-found'

export interface PurgeResult {
  outcome: PurgeOutcome
  /** Warning strings to surface in the response (best-effort cleanup errors). */
  warnings: string[]
}

/**
 * Purge the worktree of a workspace: stops the agent, the dev server and the
 * terminal (best-effort), removes the worktree dir + git registration, then
 * records the purge timestamp + restore metadata so a future version can
 * recreate the worktree from the merged PR.
 *
 * The workspace is auto-archived on purge — disk-purged is a strict superset
 * of archived (no agent can run on a missing worktree). Archive emits its
 * own event before this function tags the workspace as purged.
 */
export async function purgeWorktree(workspaceId: string): Promise<PurgeResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return { outcome: 'not-found', warnings: [] }
  if (workspace.worktreePurgedAt) return { outcome: 'already-purged', warnings: [] }
  if (!workspace.worktreeOwned) return { outcome: 'worktree-not-owned', warnings: [] }

  const warnings: string[] = []

  // Best-effort cleanup before touching the disk. A failure here is logged
  // but does NOT block the purge — leaving a stranded worktree on disk would
  // defeat the feature's purpose.
  try {
    agentManager.stopAgent(workspaceId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[purge] stopAgent failed for '${workspace.name}':`, msg)
  }
  try {
    devServerService.stopDevServer(workspaceId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[purge] stopDevServer failed for '${workspace.name}':`, msg)
  }
  try {
    destroyTerminal(workspaceId)
  } catch {
    // terminal may not exist — silent
  }

  // Capture restore metadata BEFORE removing the worktree so we still have a
  // chance to query the forge for the latest PR snapshot.
  const restoreData = await captureRestoreData(workspace)

  // Archive first so the workspace:archived event fires while the worktree
  // still technically exists — listeners that snapshot disk state get a
  // consistent picture. Archive is idempotent.
  if (!workspace.archivedAt) {
    try {
      const archived = archiveWorkspace(workspaceId)
      emitEphemeral(workspaceId, 'workspace:archived', { workspace: archived })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Archive failed: ${msg}`)
    }
  }

  // Remove the worktree. fs.existsSync guard handles the case where the user
  // already nuked it externally — the git registration still needs cleaning,
  // which removeWorktree does too.
  if (fs.existsSync(workspace.worktreePath)) {
    try {
      removeWorktree(workspace.projectPath, workspace.worktreePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(buildRemovalFailureMessage(workspace.worktreePath, workspace.projectPath, msg))
    }
  }

  try {
    markWorktreePurged(workspaceId, restoreData)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`DB metadata update failed: ${msg}`)
  }

  emitEphemeral(workspaceId, 'workspace:worktree-purged', {
    workspaceId,
    purgedAt: new Date().toISOString(),
    restoreData,
  })

  return { outcome: 'purged', warnings }
}

/**
 * Pretty failure message for `removeWorktree` errors. Detects permission
 * issues (typical when Docker / docker-compose left root-owned files in
 * `node_modules`, `vendor`, etc.) and surfaces a one-line `sudo` command
 * the user can paste to recover. Other errors get a generic recovery hint.
 */
function buildRemovalFailureMessage(worktreePath: string, projectPath: string, errMsg: string): string {
  const isPermission = /EACCES|EPERM|permission denied|operation not permitted/i.test(errMsg)
  const baseLine = `Failed to remove worktree '${worktreePath}'.`
  const recovery = ['Recovery:', `  sudo rm -rf '${worktreePath}'`, `  cd '${projectPath}' && git worktree prune`].join(
    '\n',
  )
  if (isPermission) {
    return [
      `${baseLine} Permission denied — typically caused by Docker leaving root-owned files inside node_modules / vendor.`,
      recovery,
      'Prevention: configure your container to run as your host user (USER directive in Dockerfile, or `user: "$(id -u):$(id -g)"` in docker-compose), OR pre-seed the worktrees root with a default ACL:',
      `  setfacl -d -m u:$(whoami):rwx '${projectPath}/..'/worktrees`,
      `Reason: ${errMsg}`,
    ].join('\n')
  }
  return [baseLine, recovery, `Reason: ${errMsg}`].join('\n')
}

/**
 * Build the restore-data snapshot stored alongside the purge. Reads the PR
 * snapshot from the watcher cache when available, then tries a fresh forge
 * lookup as a fallback. Never throws — best-effort. Reserved for a future
 * unpurge feature.
 */
async function captureRestoreData(
  workspace: ReturnType<typeof getWorkspace> & object,
): Promise<WorktreePurgeRestoreData> {
  const forge = resolveForge(workspace.projectPath)

  let prNumber: number | null = null
  let prUrl: string | null = null

  // Forge lookup is best-effort — silent on failure since the field is
  // purely advisory for the future unpurge feature. We always go direct to
  // the provider (no pr-watcher cache) to avoid an import cycle between
  // the watcher and the purge service.
  if (forge !== 'none') {
    try {
      const provider = getForgeProvider(forge)
      const fresh = await provider.getPrStatus(workspace.worktreePath, workspace.workingBranch)
      if (fresh) {
        prNumber = fresh.number ?? null
        prUrl = fresh.url ?? null
      }
    } catch (err) {
      console.warn(`[purge] PR lookup for restore data failed:`, err instanceof Error ? err.message : err)
    }
  }

  return {
    prNumber,
    prUrl,
    forge: forge as 'github' | 'gitlab' | 'none',
    mergeCommitSha: null,
    originalWorktreePath: workspace.worktreePath,
    originalSourceBranch: workspace.sourceBranch,
    originalWorkingBranch: workspace.workingBranch,
  }
}
