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
import { isPermissionError, removeWorktree } from './worktree-service.js'

export type PurgeOutcome = 'purged' | 'already-purged' | 'worktree-not-owned' | 'not-found'

export interface PurgeResult {
  outcome: PurgeOutcome
  warnings: string[]
}

export async function purgeWorktree(workspaceId: string): Promise<PurgeResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return { outcome: 'not-found', warnings: [] }
  if (workspace.worktreePurgedAt) return { outcome: 'already-purged', warnings: [] }
  if (!workspace.worktreeOwned) return { outcome: 'worktree-not-owned', warnings: [] }

  const warnings: string[] = []

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
  } catch {}

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
