import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { assertAgentStopped } from '../utils/agent-stop-result.js'
import { logError, logWarn } from '../utils/logger.js'
import { withWorkspaceLifecycleGuard } from '../utils/workspace-lifecycle-guard.js'
import * as agentManager from './agent/orchestrator.js'
import * as devServerService from './dev-server-service.js'
import { getForgeProvider } from './forge/registry.js'
import { resolveForge } from './forge/resolve.js'
import { computedKeptRootIfExists, keepAiFolder, putBackKeptRoot } from './kept-ai-service.js'
import { getGlobalSettings } from './settings-service.js'
import { destroyTerminal } from './terminal-service.js'
import { emitEphemeral } from './websocket-service.js'
import {
  archiveWorkspace,
  getWorkspace,
  markWorktreePurged,
  type WorktreePurgeRestoreData,
} from './workspace-service.js'
import { isMatchingWorkspaceWorktree, isPermissionError, removeWorktree } from './worktree-service.js'

const execFileAsync = promisify(execFile)

export type PurgeOutcome =
  | 'cancelled'
  | 'purged'
  | 'already-purged'
  | 'worktree-not-owned'
  | 'not-found'
  | 'removal-failed'
  | 'keep-failed'

export interface PurgeResult {
  outcome: PurgeOutcome
  warnings: string[]
}

export async function purgeWorktree(workspaceId: string, expectedArchivedAt?: string): Promise<PurgeResult> {
  return withWorkspaceLifecycleGuard(workspaceId, () => purgeWorktreeGuarded(workspaceId, expectedArchivedAt))
}

async function purgeWorktreeGuarded(workspaceId: string, expectedArchivedAt?: string): Promise<PurgeResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return { outcome: 'not-found', warnings: [] }
  if (expectedArchivedAt !== undefined && workspace.archivedAt !== expectedArchivedAt) {
    return { outcome: 'cancelled', warnings: [] }
  }
  if (workspace.worktreePurgedAt) return { outcome: 'already-purged', warnings: [] }
  if (!workspace.worktreeOwned) return { outcome: 'worktree-not-owned', warnings: [] }

  const warnings: string[] = []

  // `removeWorktree` runs later in this same function — the agent must be dead
  // by then, not merely asked to stop.
  assertAgentStopped(await agentManager.stopAgentAndWait(workspaceId, undefined, 'purge'))
  try {
    await devServerService.stopDevServer(workspaceId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('purge', `stopDevServer failed for '${workspace.name}'`, { workspaceId: workspace.id, error: msg })
    throw err
  }
  await destroyTerminal(workspaceId)

  // Snapshot the forge BEFORE removing the worktree — the PR lookup uses
  // `worktreePath` as cwd.
  const restoreData = await captureRestoreData(workspace)

  if (!workspace.archivedAt) {
    try {
      const archived = archiveWorkspace(workspaceId)
      emitEphemeral(workspaceId, 'workspace:archived', { workspace: archived })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Archive failed: ${msg}`)
    }
  }

  // Keep `.ai` out of the removal: a failure here leaves the worktree untouched.
  const worktreeExists = fs.existsSync(workspace.worktreePath)
  let keptRoot: string | null = null
  if (worktreeExists && getGlobalSettings().keepAiFolderOnPurge) {
    try {
      keptRoot = await keepAiFolder(workspace)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // A merge that failed midway may have left part of `.ai` in the kept root.
      const partial = computedKeptRootIfExists(workspace)
      const leftWarning = partial ? await putBackKeptRoot(partial, workspace.worktreePath) : null
      warnings.push(
        `Could not keep the .ai folder of '${workspace.worktreePath}': ${reason}. The worktree was left in place. Fix the folder's permissions, or turn off "Keep the .ai folder when purging a worktree" in Settings, then purge again.`,
      )
      if (leftWarning) warnings.push(leftWarning)
      emitEphemeral(workspaceId, 'workspace:worktree-purge-failed', { workspaceId, warnings })
      return { outcome: 'keep-failed', warnings }
    }
  } else {
    // Setting off, or a retry after the worktree is gone: still record a kept root an earlier attempt left.
    keptRoot = computedKeptRootIfExists(workspace)
  }

  if (worktreeExists) {
    try {
      await removeWorktree(workspace.projectPath, workspace.worktreePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(buildRemovalFailureMessage(workspace.worktreePath, workspace.projectPath, msg))
    }
  }

  // `worktree_purged_at` is not cosmetic: it drives the "restore" UI and the
  // PR watcher's auto-restore probe, which tests whether the folder reappeared.
  // Setting it on a directory that never left puts both in contradiction with
  // the disk — and told the user the space was reclaimed when it wasn't.
  if (fs.existsSync(workspace.worktreePath)) {
    if (keptRoot) {
      // Put `.ai` back only while the checkout is still a registered worktree of this workspace (the removal did not
      // really start). Otherwise the folder is a half-deleted leftover the operator is told to delete: keep the notes aside.
      let intact = false
      try {
        intact = await isMatchingWorkspaceWorktree({
          projectPath: workspace.projectPath,
          worktreePath: workspace.worktreePath,
          workingBranch: workspace.workingBranch,
        })
      } catch {
        intact = false
      }
      if (intact) {
        const warning = await putBackKeptRoot(keptRoot, workspace.worktreePath)
        // The removal message above tells the operator to delete the folder by hand: say what that would cost.
        warnings.push(
          warning ??
            `The .ai folder was put back into '${workspace.worktreePath}'. Do not delete that folder by hand: purge again instead, so the notes are kept.`,
        )
      } else {
        warnings.push(
          `The .ai folder was kept in '${keptRoot}'. It will be recorded when you purge again after cleaning the folder up.`,
        )
      }
    }
    emitEphemeral(workspaceId, 'workspace:worktree-purge-failed', { workspaceId, warnings })
    return { outcome: 'removal-failed', warnings }
  }

  try {
    if (keptRoot) restoreData.keptAiPath = keptRoot
    markWorktreePurged(workspaceId, restoreData)
  } catch (err) {
    // The folder is gone but nothing records it: announcing "purged" would lie
    // to the UI and to the watcher's auto-restore probe. Retrying the purge is
    // safe, it skips the removal and only records the metadata.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Worktree '${workspace.worktreePath}' was removed from disk but the purge could not be recorded: ${msg}. Retry the purge.`,
    )
  }

  emitEphemeral(workspaceId, 'workspace:worktree-purged', {
    workspaceId,
    purgedAt: new Date().toISOString(),
    restoreData,
  })

  return { outcome: 'purged', warnings }
}

function buildRemovalFailureMessage(worktreePath: string, projectPath: string, errMsg: string): string {
  const isPermission = isPermissionError(errMsg)
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

async function captureRestoreData(
  workspace: ReturnType<typeof getWorkspace> & object,
): Promise<WorktreePurgeRestoreData> {
  const forge = resolveForge(workspace.projectPath)

  let headCommitSha: string | null = null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspace.worktreePath,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    headCommitSha = stdout.trim() || null
  } catch {
    // A missing or broken checkout must not prevent a best-effort purge.
  }

  let prNumber: number | null = null
  let prUrl: string | null = null

  // Direct provider call (not the pr-watcher cache) avoids an import cycle
  // between the watcher and this service.
  if (forge !== 'none') {
    try {
      const provider = getForgeProvider(forge)
      const fresh = await provider.getPrStatus(workspace.worktreePath, workspace.workingBranch)
      if (fresh) {
        prNumber = fresh.number ?? null
        prUrl = fresh.url ?? null
      }
    } catch (err) {
      logWarn('purge', 'PR lookup for restore data failed', {
        workspaceId: workspace.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    prNumber,
    prUrl,
    forge: forge as 'github' | 'gitlab' | 'bitbucket-community' | 'none',
    mergeCommitSha: null,
    headCommitSha,
    originalWorktreePath: workspace.worktreePath,
    originalSourceBranch: workspace.sourceBranch,
    originalWorkingBranch: workspace.workingBranch,
  }
}
