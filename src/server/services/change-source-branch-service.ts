// src/server/services/change-source-branch-service.ts

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as gitOps from '../utils/git-ops.js'
import { getAgentStatus } from './agent/orchestrator.js'
import { getForgeProvider } from './forge/registry.js'
import { resolveForge } from './forge/resolve.js'
import { getEffectiveSettings } from './settings-service.js'
import { getWorkspace, updateWorkspaceSourceBranch } from './workspace-service.js'

/** Above this many proper commits, refuse and ask for a manual rebase. */
export const MAX_PROPER_COMMITS = 50

/** Wall-clock limit on the custom change-source-branch script. */
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000

export interface ChangeSourceBranchResult {
  status: 'done' | 'aligned' | 'conflict' | 'too-many' | 'dirty'
  /** True when the working branch has a remote upstream — its history was rewritten. */
  forcePushNeeded: boolean
  /** Number of proper commits replayed (0 for the aligned path). */
  commitCount: number
}

/**
 * Re-target a workspace onto `newBase`: reconstruct its working branch via
 * cherry-pick of its proper commits, update the `source_branch` metadata, and
 * change the PR base if a PR exists. Throws on validation failures (agent
 * running, unknown base). Returns a status discriminating the outcome.
 */
export async function changeSourceBranch(workspaceId: string, newBase: string): Promise<ChangeSourceBranchResult> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`)

  if (getAgentStatus(workspaceId) !== null) {
    throw new Error('Cannot change the source branch while the agent is running — stop it first')
  }

  const oldBase = workspace.sourceBranch
  const trimmedNew = newBase.trim()
  if (!trimmedNew) throw new Error('New source branch is required')
  if (trimmedNew === oldBase) throw new Error(`The source branch is already '${oldBase}'`)

  const effective = getEffectiveSettings(workspace.projectPath)
  if (effective.changeSourceBranchScript && effective.changeSourceBranchScript.trim().length > 0) {
    return runCustomScript(workspace, oldBase, trimmedNew, effective.changeSourceBranchScript)
  }

  const worktreePath = workspace.worktreePath
  const workingBranch = workspace.workingBranch

  // Fetch every branch so all `origin/*` refs are current: the proper-commit
  // computation and the `reset --hard` target both depend on fresh refs.
  // Best-effort — offline still lets us proceed with whatever is local, and
  // the branchExists check below is the authoritative gate for the new base
  // (it throws a clean error, mapped to a 400, rather than a raw fetch error).
  try {
    gitOps.fetchAllBranches(worktreePath)
  } catch {
    // offline / no remote — proceed with local refs
  }
  if (!gitOps.branchExists(worktreePath, trimmedNew, 'origin')) {
    throw new Error(`Source branch 'origin/${trimmedNew}' does not exist`)
  }

  const commits = gitOps.listProperCommits(worktreePath, workingBranch, trimmedNew, oldBase)
  const forcePushNeeded = gitOps.branchExists(worktreePath, workingBranch, 'origin')

  if (commits.length > MAX_PROPER_COMMITS) {
    return { status: 'too-many', forcePushNeeded, commitCount: commits.length }
  }

  const isAligned = commits.length === 0
  const dirty = gitOps.worktreeHasChanges(worktreePath)

  if (!isAligned && dirty) {
    return { status: 'dirty', forcePushNeeded, commitCount: commits.length }
  }

  const stashed = isAligned && dirty
  if (stashed) gitOps.stashPush(worktreePath, 'kobo-change-source-branch')

  try {
    gitOps.reconstructBranchOnto(worktreePath, workingBranch, trimmedNew, commits)
  } catch (err) {
    if (err instanceof gitOps.GitConflictError) {
      // Record the new base even when conflicted: the cherry-pick is left in
      // progress for the agent (or the cancel-source-change route) to resolve
      // or abort. `stashed` is always false here — a conflict needs commits,
      // the stash path is aligned-only — so no stash is stranded.
      updateWorkspaceSourceBranch(workspaceId, trimmedNew)
      return { status: 'conflict', forcePushNeeded, commitCount: commits.length }
    }
    throw err
  } finally {
    if (stashed) gitOps.stashPop(worktreePath)
  }

  updateWorkspaceSourceBranch(workspaceId, trimmedNew)

  try {
    const provider = getForgeProvider(resolveForge(workspace.projectPath))
    if (provider.capabilities.canChangePrBase) {
      const pr = await provider.getPrStatus(worktreePath, workingBranch)
      if (pr) await provider.changePrBase(worktreePath, trimmedNew)
    }
  } catch (err) {
    console.error('[change-source-branch] PR base update failed (non-fatal):', err)
  }

  return { status: isAligned ? 'aligned' : 'done', forcePushNeeded, commitCount: commits.length }
}

/** Spawn the script with `bash -c`, return the standard result on exit 0, throw on non-zero. */
async function runCustomScript(
  workspace: { id: string; name: string; worktreePath: string; projectPath: string; workingBranch: string },
  oldBase: string,
  newBase: string,
  script: string,
): Promise<ChangeSourceBranchResult> {
  const forgeId = resolveForge(workspace.projectPath)
  const projectName = path.basename(workspace.projectPath)
  // Best-effort PR/MR lookup — '' on no PR / missing CLI / forge='none'.
  let prNumber = ''
  try {
    const provider = getForgeProvider(forgeId)
    const snapshot = await provider.getPrStatus(workspace.worktreePath, workspace.workingBranch)
    if (snapshot?.number) prNumber = String(snapshot.number)
  } catch (err) {
    console.warn('[change-source-branch] PR lookup failed, KOBO_PR_NUMBER will be empty:', err)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      cwd: workspace.worktreePath,
      env: {
        ...process.env,
        KOBO_NEW_BASE: newBase,
        KOBO_OLD_BASE: oldBase,
        KOBO_WORKING_BRANCH: workspace.workingBranch,
        KOBO_WORKTREE_PATH: workspace.worktreePath,
        KOBO_PROJECT_PATH: workspace.projectPath,
        KOBO_PROJECT_NAME: projectName,
        KOBO_WORKSPACE_ID: workspace.id,
        KOBO_WORKSPACE_NAME: workspace.name,
        KOBO_FORGE: forgeId,
        KOBO_PR_NUMBER: prNumber,
      },
      timeout: SCRIPT_TIMEOUT_MS,
    })

    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      if (stderrBuf.length > 8 * 1024) stderrBuf = stderrBuf.slice(-8 * 1024)
    })

    child.on('error', (err) => {
      reject(new Error(`Custom change-source-branch script failed to spawn: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      if (code === 0) {
        updateWorkspaceSourceBranch(workspace.id, newBase)
        resolve({ status: 'done', forcePushNeeded: false, commitCount: 0 })
        return
      }
      const detail = stderrBuf.trim().slice(-500) || `exit code ${code ?? signal ?? 'unknown'}`
      reject(new Error(`Custom change-source-branch script failed: ${detail}`))
    })
  })
}
