import { withGitRepoLock } from '../utils/git-repo-lock.js'
import { withWorkspaceLifecycleGuard } from '../utils/workspace-lifecycle-guard.js'
import { invalidateWorkspacePrCaches } from './pr-watcher-service.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace, restoreWorktreeFromDisk, type Workspace } from './workspace-service.js'
import {
  isMatchingWorkspaceWorktree,
  type RestoreCheckoutSource,
  restoreWorktreeCheckoutUnlocked,
} from './worktree-service.js'

export type RestoreErrorCode =
  | 'not-found'
  | 'not-purged'
  | 'workspace-busy'
  | 'worktree-not-owned'
  | 'project-unavailable'
  | 'path-conflict'
  | 'branch-in-use'
  | 'recovery-source-unavailable'
  | 'git-failed'

export class WorktreeRestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface RestoreWorktreeResult {
  workspace: Workspace
  outcome: 'restored' | 'already-restored'
  source: RestoreCheckoutSource
}

function savedHead(json: string | null): string | null {
  try {
    const data: unknown = JSON.parse(json ?? 'null')
    if (data && typeof data === 'object' && 'headCommitSha' in data && typeof data.headCommitSha === 'string') {
      return /^[a-f0-9]{40,64}$/i.test(data.headCommitSha) ? data.headCommitSha : null
    }
  } catch {
    // Older/hand-edited metadata does not prevent restoring a surviving branch.
  }
  return null
}

export async function restorePurgedWorktree(id: string): Promise<RestoreWorktreeResult> {
  try {
    return await withWorkspaceLifecycleGuard(id, async () => {
      const initial = getWorkspace(id)
      if (!initial) throw new WorktreeRestoreError('not-found', 'Workspace not found.')
      return withGitRepoLock(initial.projectPath, async () => {
        const workspace = getWorkspace(id)
        if (!workspace) throw new WorktreeRestoreError('not-found', 'Workspace not found.')
        if (!workspace.worktreeOwned) {
          throw new WorktreeRestoreError('worktree-not-owned', 'This workspace uses an externally managed worktree.')
        }
        const input = {
          projectPath: workspace.projectPath,
          worktreePath: workspace.worktreePath,
          workingBranch: workspace.workingBranch,
          headCommitSha: savedHead(workspace.worktreePurgeRestoreData),
        }
        if (!workspace.worktreePurgedAt) {
          if (!(await isMatchingWorkspaceWorktree(input))) {
            throw new WorktreeRestoreError(
              'not-purged',
              'Workspace is not marked as purged and its checkout is missing or different.',
            )
          }
          return { workspace, outcome: 'already-restored', source: 'existing-worktree' }
        }

        const checkout = await restoreWorktreeCheckoutUnlocked(input)
        if (!(await isMatchingWorkspaceWorktree(input))) {
          throw new WorktreeRestoreError('path-conflict', 'The recreated checkout does not match this workspace.')
        }
        // Preserve a valid checkout on DB failure. A retry or manual detection can
        // safely complete the metadata update without deleting any Git history.
        const restored = restoreWorktreeFromDisk(id)
        invalidateWorkspacePrCaches(id)
        emitEphemeral(id, 'workspace:worktree-restored', { workspace: restored })
        return { workspace: restored, outcome: 'restored', source: checkout.source }
      })
    })
  } catch (err) {
    if (err instanceof WorktreeRestoreError) throw err
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null
    const known = [
      'workspace-busy',
      'project-unavailable',
      'path-conflict',
      'branch-in-use',
      'recovery-source-unavailable',
    ] as const
    const matched = known.find((candidate) => candidate === code)
    // Don't expose Git stderr: remote URLs can contain credentials.
    throw new WorktreeRestoreError(
      matched ?? 'git-failed',
      'Unable to restore the worktree. Check the project and Git recovery source, then retry.',
    )
  }
}
