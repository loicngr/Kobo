// src/server/services/git-stats-service.ts
import * as gitOps from '../utils/git-ops.js'
import { getForgeProvider } from './forge/registry.js'
import { resolveForge } from './forge/resolve.js'
import type { ForgeAvailability, ForgeCapabilities, ForgeId, PrSnapshot } from './forge/types.js'

/** The git + forge summary for one workspace branch. Matches the legacy
 *  `GET /:id/git-stats` response shape exactly. */
export interface GitStatsResult {
  commitCount: number
  behindCount: number
  filesChanged: number
  insertions: number
  deletions: number
  prUrl: string | null
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | null
  unpushedCount: number
  workingTree: { staged: number; modified: number; untracked: number }
  forge: { id: ForgeId; capabilities: ForgeCapabilities; availability: ForgeAvailability }
}

/** Minimal workspace shape `computeGitStats` needs. */
interface GitStatsWorkspace {
  worktreePath: string
  sourceBranch: string
  workingBranch: string
  projectPath: string
}

/**
 * Compute the git + forge stats for a workspace branch. Pure read — does NOT
 * run `fetchSourceBranchAsync`; the caller decides whether to refresh the
 * local source ref first. `prUrl`/`prState` come from the supplied PR snapshot
 * so this never issues its own `getPrStatus` call.
 */
export async function computeGitStats(
  workspace: GitStatsWorkspace,
  prSnapshot: Pick<PrSnapshot, 'url' | 'state'> | null,
): Promise<GitStatsResult> {
  const { worktreePath, sourceBranch, workingBranch, projectPath } = workspace
  const commitCount = gitOps.getCommitCount(worktreePath, sourceBranch, workingBranch)
  const behindCount = gitOps.getCommitsBehind(worktreePath, sourceBranch, workingBranch)
  const diffStats = gitOps.getStructuredDiffStatsBetween(worktreePath, sourceBranch, workingBranch)
  const unpushedCount = await gitOps.getUnpushedCountAsync(worktreePath, workingBranch)
  const workingTree = gitOps.getWorkingTreeStatus(worktreePath)
  const forgeProvider = getForgeProvider(resolveForge(projectPath))
  const availability = await forgeProvider.isAvailable(worktreePath)
  return {
    commitCount,
    behindCount,
    filesChanged: diffStats.filesChanged,
    insertions: diffStats.insertions,
    deletions: diffStats.deletions,
    prUrl: prSnapshot?.url ?? null,
    prState: prSnapshot?.state ?? null,
    unpushedCount,
    workingTree,
    forge: { id: forgeProvider.id, capabilities: forgeProvider.capabilities, availability },
  }
}
