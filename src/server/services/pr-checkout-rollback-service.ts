import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { buildNonInteractiveGitEnv } from '../utils/git-ops.js'
import { withGitRepoLock } from '../utils/git-repo-lock.js'
import type { ResolvePrCheckoutResult } from './pr-checkout-service.js'

/** Undo only our unchanged checkout, never the PR branch or earlier checkout decisions. */
export async function rollbackCreatedPrCheckout(projectPath: string, checkout: ResolvePrCheckoutResult) {
  const retained = (reason: string) => ({ removed: false, worktreePath: checkout.worktreePath, reason })
  if (!checkout.createdWorktree) return retained('The checkout existed before this request')
  try {
    return await withGitRepoLock(projectPath, () => {
      // Workspace adoption uses this same lock. Keep checks and removal synchronous
      // so another request cannot attach this checkout between the ownership read and removal.
      const owners = getDb().prepare('SELECT worktree_path FROM workspaces').all() as Array<{ worktree_path: string }>
      const resolved = fs.realpathSync(checkout.worktreePath)
      if (
        owners.some(({ worktree_path }) => {
          try {
            return fs.realpathSync(worktree_path) === resolved
          } catch {
            return path.resolve(worktree_path) === resolved
          }
        })
      )
        return retained('The checkout is attached to a workspace')
      const stat = fs.lstatSync(checkout.worktreePath)
      const identity = checkout.createdWorktree!
      if (!stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode)
        return retained('The checkout directory was replaced')
      const git = (cwd: string, args: string[]) =>
        execFileSync('git', args, {
          cwd,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: buildNonInteractiveGitEnv(),
        }).trim()
      if (
        git(resolved, ['rev-parse', 'HEAD']) !== identity.head ||
        git(resolved, ['symbolic-ref', '--short', 'HEAD']) !== checkout.workingBranch
      )
        return retained('The checkout branch or HEAD changed')
      if (git(resolved, ['status', '--porcelain', '--untracked-files=all', '--ignored']))
        return retained('The checkout contains local or ignored files')
      // No --force: Git performs its own final dirty/locked-worktree checks.
      git(projectPath, ['worktree', 'remove', '--', resolved])
      return { removed: true, worktreePath: checkout.worktreePath }
    })
  } catch (error) {
    return retained(error instanceof Error ? error.message : String(error))
  }
}
