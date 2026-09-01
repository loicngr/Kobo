import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as gitOps from '../utils/git-ops.js'
import { GitConflictError } from '../utils/git-ops.js'
import { withGitRepoLock } from '../utils/git-repo-lock.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import { createWorktree, listWorktrees, removeWorktreeUnlocked } from './worktree-service.js'

/**
 * A `pathCollision.worktreePath` decision is untrusted input reaching
 * `git worktree add` directly — including from a network-access client that
 * only holds the shared token, not full local trust. Reject anything that
 * isn't a clean, absolute, non-existent path so `createWorktree`'s explicit
 * path override can never be used to write outside a location the user
 * genuinely typed (no `..`/`.` traversal tricks, no relative paths resolved
 * against an unexpected cwd, no silently overwriting something already there).
 */
function assertSafeExplicitWorktreePath(candidate: string): void {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`The worktree path must be absolute: '${candidate}'`)
  }
  const trimmed = candidate.replace(/[/\\]+$/, '') || path.sep
  if (path.resolve(trimmed) !== trimmed) {
    throw new Error(`The worktree path is not a clean absolute path (no '.' or '..' segments): '${candidate}'`)
  }
  if (fs.existsSync(trimmed)) {
    throw new Error(`'${trimmed}' already exists; choose a location that does not exist yet`)
  }
}

/** Something Kōbō cannot resolve on the user's behalf. */
export type PrCheckoutBlocker =
  | { kind: 'forge-unavailable'; reason: 'cli_missing' | 'not_authenticated' }
  | { kind: 'fork-pr' }
  | { kind: 'head-branch-deleted'; hasLocalBranch: boolean }
  | { kind: 'index-lock'; lockPath: string }
  | { kind: 'path-occupied'; path: string }
  | { kind: 'worktree-other-branch'; path: string; branch: string }
  | { kind: 'no-common-ancestor'; branch: string }

export type WorkspaceState =
  | { state: 'none' }
  | { state: 'active'; id: string; name: string }
  | { state: 'archived'; id: string; name: string }
  | { state: 'purged'; id: string; name: string }

export type WorktreeState =
  | { state: 'none' }
  | { state: 'orphan'; path: string }
  | { state: 'attached'; path: string; workspaceId: string }
  | { state: 'stale-metadata'; path: string }

export type BranchState =
  | { state: 'absent' }
  | { state: 'in-sync' }
  | { state: 'behind'; behind: number }
  | { state: 'ahead'; ahead: number }
  | { state: 'diverged'; ahead: number; behind: number }

export interface LocalChanges {
  present: boolean
  modified: number
  staged: number
  untracked: number
}

export interface PrCheckoutReport {
  projectPath: string
  headBranch: string
  targetWorktreePath: string
  blockers: PrCheckoutBlocker[]
  workspace: WorkspaceState
  worktree: WorktreeState
  localChanges: LocalChanges
  ongoingOperation: 'merge' | 'rebase' | 'cherry-pick' | null
  branch: BranchState
}

const EMPTY_CHANGES: LocalChanges = { present: false, modified: 0, staged: 0, untracked: 0 }

/** Run a git command in a repo and return trimmed stdout. Forces LC_ALL=C so
 *  error-message matching elsewhere in this service stays locale-independent. */
// Every call here runs inside `withGitRepoLock` (see `resolvePrCheckout`), so
// a hang blocks every other lock-guarded operation in the app (worktree
// purge, change-source-branch) with no recovery. `GIT_TERMINAL_PROMPT: '0'`
// makes a missing credential fail immediately instead of prompting
// interactively over a pipe nobody can answer; the timeout is a backstop for
// anything else that could still stall (a slow filesystem, a stuck lock).
const GIT_TIMEOUT_MS = 60_000

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** Compare the local branch against `origin/<branch>`. */
function diagnoseBranch(projectPath: string, branch: string): BranchState {
  if (!gitOps.localBranchExists(projectPath, branch)) return { state: 'absent' }
  if (!gitOps.listRemoteBranches(projectPath).includes(`origin/${branch}`)) return { state: 'in-sync' }
  const ahead = gitOps.getCommitCount(projectPath, branch, branch)
  const behind = gitOps.getCommitsBehind(projectPath, branch, branch)
  if (ahead > 0 && behind > 0) return { state: 'diverged', ahead, behind }
  // Note: `hasCommonAncestor` below is what produces the `no-common-ancestor`
  // blocker; a same-named branch with unrelated history reads as "diverged"
  // otherwise, and every strategy offered for it would be wrong.
  if (ahead > 0) return { state: 'ahead', ahead }
  if (behind > 0) return { state: 'behind', behind }
  return { state: 'in-sync' }
}

/** False when the local branch and its remote share no history at all — a name
 *  collision, not a divergence. Every realignment strategy is wrong for it. */
function hasCommonAncestor(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['merge-base', branch, `origin/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Locate any worktree already sitting on `branch`, or at the target path. */
function diagnoseWorktree(
  projectPath: string,
  branch: string,
  targetPath: string,
  attachedPaths: Map<string, string>,
): { worktree: WorktreeState; blockers: PrCheckoutBlocker[] } {
  const blockers: PrCheckoutBlocker[] = []
  const worktrees = listWorktrees(projectPath)

  const onBranch = worktrees.find((wt) => wt.branch === branch)
  if (onBranch) {
    if (!fs.existsSync(onBranch.path)) {
      return { worktree: { state: 'stale-metadata', path: onBranch.path }, blockers }
    }
    const workspaceId = attachedPaths.get(onBranch.path)
    return {
      worktree: workspaceId
        ? { state: 'attached', path: onBranch.path, workspaceId }
        : { state: 'orphan', path: onBranch.path },
      blockers,
    }
  }

  const atTarget = worktrees.find((wt) => wt.path === targetPath)
  if (atTarget) {
    blockers.push({ kind: 'worktree-other-branch', path: targetPath, branch: atTarget.branch })
  } else if (fs.existsSync(targetPath)) {
    blockers.push({ kind: 'path-occupied', path: targetPath })
  }

  return { worktree: { state: 'none' }, blockers }
}

/** Count working-tree changes by category. */
function diagnoseChanges(worktreePath: string): LocalChanges {
  const status = gitOps.getWorkingTreeStatus(worktreePath)
  const modified = status.modified ?? 0
  const staged = status.staged ?? 0
  const untracked = status.untracked ?? 0
  return { present: modified + staged + untracked > 0, modified, staged, untracked }
}

/** The subset of a workspace row this service needs. Keeps the DB out. */
export interface WorkspaceLike {
  id: string
  name: string
  workingBranch: string
  archivedAt: string | null
  worktreePurgedAt: string | null
}

/** Classify the workspace, if any, that already tracks this branch.
 *  A purged worktree outranks the archived flag: purging always archives, and
 *  "recreate the worktree" is the useful offer, not "unarchive". */
export function resolveWorkspaceState(workspaces: WorkspaceLike[], branch: string): WorkspaceState {
  const match = workspaces.find((w) => w.workingBranch === branch)
  if (!match) return { state: 'none' }
  if (match.worktreePurgedAt) return { state: 'purged', id: match.id, name: match.name }
  if (match.archivedAt) return { state: 'archived', id: match.id, name: match.name }
  return { state: 'active', id: match.id, name: match.name }
}

/** `git rev-parse <ref>`, or null when the ref does not resolve. */
function safeRevParse(repoPath: string, ref: string): string | null {
  try {
    return git(repoPath, ['rev-parse', ref])
  } catch {
    return null
  }
}

/** Hash the observed state so `/resolve` can refuse a plan built on stale facts. */
export function computeFingerprint(report: PrCheckoutReport): string {
  const localHead = safeRevParse(report.projectPath, report.headBranch)
  const remoteHead = safeRevParse(report.projectPath, `origin/${report.headBranch}`)
  const payload = JSON.stringify({
    localHead,
    remoteHead,
    worktree: report.worktree,
    branch: report.branch,
    workspace: report.workspace,
    changes: report.localChanges,
    ongoing: report.ongoingOperation,
    blockers: report.blockers.map((b) => b.kind).sort(),
  })
  // 128 bits is far more than enough entropy for a staleness check, not a security boundary.
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/**
 * Diagnose everything Kōbō can see locally for a PR head branch.
 * `attachedPaths` maps worktree path -> workspace id; the route supplies it so
 * this function stays free of database access and easy to test.
 */
export function diagnoseLocalState(
  projectPath: string,
  headBranch: string,
  worktreesPath: string | null,
  attachedPaths: Map<string, string> = new Map(),
  workspaces: WorkspaceLike[] = [],
): PrCheckoutReport {
  const targetWorktreePath = resolveWorkspaceWorktreePath(projectPath, headBranch, worktreesPath)
  const blockers: PrCheckoutBlocker[] = []

  const lockPath = gitOps.getIndexLockPath(projectPath)
  if (lockPath) blockers.push({ kind: 'index-lock', lockPath })

  if (
    gitOps.localBranchExists(projectPath, headBranch) &&
    gitOps.listRemoteBranches(projectPath).includes(`origin/${headBranch}`) &&
    !hasCommonAncestor(projectPath, headBranch)
  ) {
    blockers.push({ kind: 'no-common-ancestor', branch: headBranch })
  }

  const { worktree, blockers: worktreeBlockers } = diagnoseWorktree(
    projectPath,
    headBranch,
    targetWorktreePath,
    attachedPaths,
  )
  blockers.push(...worktreeBlockers)

  const inspectPath = worktree.state === 'orphan' || worktree.state === 'attached' ? worktree.path : null

  return {
    projectPath,
    headBranch,
    targetWorktreePath,
    blockers,
    workspace: resolveWorkspaceState(workspaces, headBranch),
    worktree,
    localChanges: inspectPath ? diagnoseChanges(inspectPath) : EMPTY_CHANGES,
    ongoingOperation: inspectPath ? gitOps.getOngoingGitOperation(inspectPath) : null,
    branch: diagnoseBranch(projectPath, headBranch),
  }
}

export type BranchStrategy = 'fast-forward' | 'rebase' | 'reset-hard' | 'keep'

export interface BranchStrategyResult {
  strategy: BranchStrategy
  backupBranch: string | null
}

/**
 * Bring the local branch in line with `origin/<branch>` according to `strategy`.
 * The destructive strategy always leaves a `kobo-backup/<branch>-<unix-ts>` behind
 * first — the same safety net `change-source-branch-service` uses, so nothing the
 * user had locally becomes unrecoverable.
 *
 * Operates on the repository's branch ref, so the caller must hold the repo lock
 * AND the branch must not be checked out anywhere (see the ordering note below).
 */
export function applyBranchStrategy(repoPath: string, branch: string, strategy: BranchStrategy): BranchStrategyResult {
  const remoteRef = `origin/${branch}`
  if (strategy === 'keep') return { strategy, backupBranch: null }

  if (strategy === 'fast-forward') {
    git(repoPath, ['branch', '--force', branch, remoteRef])
    return { strategy, backupBranch: null }
  }

  if (strategy === 'reset-hard') {
    const backupBranch = `kobo-backup/${branch}-${Date.now()}`
    git(repoPath, ['branch', backupBranch, branch])
    git(repoPath, ['branch', '--force', branch, remoteRef])
    return { strategy, backupBranch }
  }

  // strategy === 'rebase': `git rebase <upstream> <branch>` is shorthand for
  // `git checkout <branch> && git rebase <upstream>` — it checks out `branch`
  // as a side effect, unlike the other strategies above which only move the
  // ref via `git branch --force`. Record what's currently checked out so we
  // can restore it once the rebase completes cleanly. If HEAD is detached,
  // `--abbrev-ref` returns the literal string "HEAD", which isn't a valid ref
  // to check back out — fall back to the SHA in that case.
  const currentRef = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const originalCheckout = currentRef === 'HEAD' ? git(repoPath, ['rev-parse', 'HEAD']) : currentRef

  try {
    git(repoPath, ['rebase', remoteRef, branch])
  } catch (err) {
    const conflicted = gitOps.getConflictedFiles(repoPath)
    if (conflicted.length > 0 || gitOps.getOngoingGitOperation(repoPath) === 'rebase') {
      // Leave the rebase in progress on `branch` so the caller can abort or
      // request agent-assisted resolution — do NOT restore the original checkout.
      throw new GitConflictError('rebase', conflicted)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Rebase of '${branch}' onto '${remoteRef}' failed: ${message}`)
  }

  // Clean rebase: restore the working copy to exactly what was checked out before.
  git(repoPath, ['checkout', originalCheckout])
  return { strategy, backupBranch: null }
}

/**
 * The user's choices for resolving a PR checkout. Three of these never reach
 * `resolvePrCheckout` at all — the caller (the create-page stepper) resolves
 * them BEFORE calling `/resolve`:
 *   - `existingWorkspace: 'open'` navigates to that workspace instead.
 *   - `archivedWorkspace: 'unarchive'` unarchives and opens it instead.
 *   - `ongoingOperation: 'cancel'` closes the stepper, touching nothing.
 * `purgedWorktree: 'restore'` is also the caller's responsibility (it needs
 * to clear the workspace row's purge flags, not just create a worktree) —
 * `resolvePrCheckout` only ever sees `orphanWorktree`, `pathCollision`,
 * `localChanges`, `ongoingOperation: 'abort'`, and `divergence`.
 */
export interface PrCheckoutDecisions {
  existingWorkspace?: 'open' | 'continue'
  archivedWorkspace?: 'unarchive' | 'continue'
  purgedWorktree?: 'restore'
  orphanWorktree?: 'attach' | 'create-elsewhere'
  pathCollision?: { worktreePath: string }
  localChanges?: 'stash' | 'commit' | 'discard' | 'keep'
  ongoingOperation?: 'abort' | 'cancel'
  divergence?: BranchStrategy
}

/** One thing the resolution actually did, for the UI's summary. */
export interface AppliedAction {
  kind:
    | 'fetch'
    | 'prune-stale-worktree'
    | 'attach-worktree'
    | 'create-worktree'
    | 'stash-changes'
    | 'commit-changes'
    | 'discard-changes'
    | 'abort-operation'
    | 'align-branch'
  detail?: string
}

export interface ResolvePrCheckoutInput {
  projectPath: string
  headBranch: string
  baseBranch: string
  worktreesPath: string | null
  decisions: PrCheckoutDecisions
  fingerprint: string
  workspaces?: WorkspaceLike[]
  attachedPaths?: Map<string, string>
  /** Test seam: runs right after the worktree exists, to exercise rollback. */
  afterWorktreeHook?: () => void
}

export interface ResolvePrCheckoutResult {
  worktreePath: string
  workingBranch: string
  sourceBranch: string
  applied: AppliedAction[]
}

/** The repository moved between diagnosis and resolution. */
export class StaleDiagnosisError extends Error {
  readonly code = 'stale_diagnosis'
  constructor(readonly report: PrCheckoutReport) {
    super('The repository changed since the diagnosis was taken')
    this.name = 'StaleDiagnosisError'
  }
}

/**
 * Apply a resolution plan and leave a worktree ready on the PR head branch.
 * Never creates a workspace — that stays `POST /api/workspaces`'s job.
 *
 * Holds the repository lock throughout, like `removeWorktree` and
 * `change-source-branch-service`, so it cannot interleave with a worktree purge
 * or a source-branch change.
 */
export function resolvePrCheckout(input: ResolvePrCheckoutInput): Promise<ResolvePrCheckoutResult> {
  return withGitRepoLock(input.projectPath, async () => {
    const applied: AppliedAction[] = []

    // 1. Refresh, then refuse a plan built on facts that no longer hold.
    gitOps.fetchSourceBranch(input.projectPath, input.headBranch)
    applied.push({ kind: 'fetch', detail: `origin/${input.headBranch}` })

    const fresh = diagnoseLocalState(
      input.projectPath,
      input.headBranch,
      input.worktreesPath,
      input.attachedPaths ?? new Map(),
      input.workspaces ?? [],
    )
    if (computeFingerprint(fresh) !== input.fingerprint) throw new StaleDiagnosisError(fresh)

    // 2. Clear stale worktree metadata before anything needs the path.
    if (fresh.worktree.state === 'stale-metadata') {
      git(input.projectPath, ['worktree', 'prune'])
      applied.push({ kind: 'prune-stale-worktree', detail: fresh.worktree.path })
    }

    const reuse =
      (fresh.worktree.state === 'orphan' || fresh.worktree.state === 'attached') &&
      input.decisions.orphanWorktree !== 'create-elsewhere'
    const existingPath = reuse && 'path' in fresh.worktree ? fresh.worktree.path : null

    // 3. In a reused worktree, settle the working tree before touching history.
    if (existingPath) {
      if (fresh.ongoingOperation && input.decisions.ongoingOperation === 'abort') {
        gitOps.abortOngoingGitOperation(existingPath)
        applied.push({ kind: 'abort-operation', detail: fresh.ongoingOperation })
      }
      if (fresh.ongoingOperation && input.decisions.ongoingOperation !== 'abort') {
        throw new Error(
          `A ${fresh.ongoingOperation} is in progress in '${existingPath}' and the resolution plan did not choose to abort it`,
        )
      }
      if (fresh.localChanges.present) {
        const choice = input.decisions.localChanges ?? 'keep'
        if (choice === 'stash') {
          gitOps.stashPush(existingPath, `kobo-pr-checkout-${input.headBranch}`)
          applied.push({ kind: 'stash-changes' })
        } else if (choice === 'commit') {
          gitOps.commitAllChanges(existingPath, `chore: save work before checking out ${input.headBranch}`)
          applied.push({ kind: 'commit-changes' })
        } else if (choice === 'discard') {
          // Deliberately a labelled stash, not `checkout -- .`: recoverable.
          gitOps.stashPush(existingPath, `kobo-pr-checkout-discard-${input.headBranch}`)
          applied.push({ kind: 'discard-changes', detail: 'kept as a labelled stash' })
        }
      }
    }

    // 4. Align the branch. Ref surgery only works when the branch is NOT checked
    //    out, so an existing worktree gets the in-worktree equivalent instead.
    const strategy = input.decisions.divergence ?? 'keep'
    if (strategy !== 'keep') {
      if (existingPath) {
        alignInsideWorktree(input.projectPath, existingPath, input.headBranch, strategy, applied)
      } else {
        const outcome = applyBranchStrategy(input.projectPath, input.headBranch, strategy)
        applied.push({ kind: 'align-branch', detail: outcome.backupBranch ?? strategy })
      }
    }

    // 5. Reuse or create the worktree.
    let worktreePath: string
    let created = false
    if (existingPath) {
      worktreePath = existingPath
      applied.push({ kind: 'attach-worktree', detail: existingPath })
    } else {
      const explicitPath = input.decisions.pathCollision?.worktreePath ?? null
      if (explicitPath) assertSafeExplicitWorktreePath(explicitPath)

      const baseRef = gitOps.localBranchExists(input.projectPath, input.headBranch)
        ? input.headBranch
        : `origin/${input.headBranch}`
      const target = createWorktree(
        input.projectPath,
        input.headBranch,
        baseRef,
        input.worktreesPath,
        undefined,
        explicitPath,
      )
      worktreePath = target.worktreePath
      created = true
      applied.push({ kind: 'create-worktree', detail: worktreePath })
    }

    // 6. Roll back only the worktree WE created if a later step throws. Branch
    //    realignment from step 4 (if any) is NOT undone here — a `reset-hard`
    //    strategy already left its own `kobo-backup/<branch>-<ts>` safety net,
    //    and fast-forward/rebase are non-destructive by construction.
    try {
      input.afterWorktreeHook?.()
    } catch (err) {
      if (created) {
        try {
          removeWorktreeUnlocked(input.projectPath, worktreePath)
        } catch (cleanupErr) {
          console.error('[pr-checkout] rollback failed to remove the worktree:', cleanupErr)
          const original = err instanceof Error ? err.message : String(err)
          const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          throw new Error(
            `${original} (additionally, rollback failed to remove the worktree at '${worktreePath}': ${cleanup})`,
          )
        }
      }
      throw err
    }

    return { worktreePath, workingBranch: input.headBranch, sourceBranch: input.baseBranch, applied }
  })
}

/** Realign a branch from inside its own worktree, where ref surgery is refused. */
function alignInsideWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  strategy: BranchStrategy,
  applied: AppliedAction[],
): void {
  const remoteRef = `origin/${branch}`
  if (strategy === 'fast-forward') {
    git(worktreePath, ['merge', '--ff-only', remoteRef])
    applied.push({ kind: 'align-branch', detail: 'fast-forward' })
    return
  }
  if (strategy === 'rebase') {
    try {
      git(worktreePath, ['rebase', remoteRef])
    } catch (err) {
      const conflicted = gitOps.getConflictedFiles(worktreePath)
      if (conflicted.length > 0 || gitOps.getOngoingGitOperation(worktreePath) === 'rebase') {
        // Leave the rebase in progress so the caller can abort or request
        // agent-assisted resolution — mirrors applyBranchStrategy's own rebase
        // conflict handling and git-ops.ts's rebaseBranch.
        throw new GitConflictError('rebase', conflicted)
      }
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Rebase of '${branch}' onto '${remoteRef}' failed: ${message}`)
    }
    applied.push({ kind: 'align-branch', detail: 'rebase' })
    return
  }
  // reset-hard
  const backupBranch = `kobo-backup/${branch}-${Date.now()}`
  git(repoPath, ['branch', backupBranch, branch])
  git(worktreePath, ['reset', '--hard', remoteRef])
  applied.push({ kind: 'align-branch', detail: backupBranch })
}
