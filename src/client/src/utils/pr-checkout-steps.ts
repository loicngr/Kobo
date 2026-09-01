export interface PrCheckoutReport {
  projectPath: string
  headBranch: string
  targetWorktreePath: string
  blockers: Array<{ kind: string; [k: string]: unknown }>
  workspace:
    | { state: 'none' }
    | { state: 'active'; id: string; name: string }
    | { state: 'archived'; id: string; name: string }
    | { state: 'purged'; id: string; name: string }
  worktree:
    | { state: 'none' }
    | { state: 'orphan'; path: string }
    | { state: 'attached'; path: string; workspaceId: string }
    | { state: 'stale-metadata'; path: string }
  localChanges: { present: boolean; modified: number; staged: number; untracked: number }
  ongoingOperation: 'merge' | 'rebase' | 'cherry-pick' | null
  branch:
    | { state: 'absent' }
    | { state: 'in-sync' }
    | { state: 'behind'; behind: number }
    | { state: 'ahead'; ahead: number }
    | { state: 'diverged'; ahead: number; behind: number }
}

export type StepId = 'blocked' | 'path' | 'workspace' | 'worktree' | 'operation' | 'changes' | 'divergence'

export interface CheckoutStep {
  id: StepId
  /** When true nothing can proceed: render the reason and offer only Cancel. */
  blocking: boolean
  titleKey: string
}

export interface PrCheckoutDecisions {
  existingWorkspace?: 'open' | 'continue'
  archivedWorkspace?: 'unarchive' | 'continue'
  purgedWorktree?: 'restore'
  orphanWorktree?: 'attach' | 'create-elsewhere'
  pathCollision?: { worktreePath: string }
  localChanges?: 'stash' | 'commit' | 'discard' | 'keep'
  ongoingOperation?: 'abort' | 'cancel'
  divergence?: 'fast-forward' | 'rebase' | 'reset-hard' | 'keep'
}

/** Blockers the user CAN resolve, by picking another worktree path. Everything
 *  else (missing CLI, fork PR, deleted remote branch, index.lock, unrelated
 *  history) leaves nothing to choose and ends the flow. */
const RESOLVABLE_BLOCKERS = new Set(['path-occupied', 'worktree-other-branch'])

/**
 * Derive the ordered steps for a report. A blocker short-circuits everything:
 * there is no point asking about a stash when the forge CLI is missing.
 * `operation` precedes `changes` because aborting a rebase changes what is dirty.
 */
export function deriveSteps(report: PrCheckoutReport): CheckoutStep[] {
  const fatal = report.blockers.filter((b) => !RESOLVABLE_BLOCKERS.has(b.kind))
  if (fatal.length > 0) {
    return [{ id: 'blocked', blocking: true, titleKey: 'prCheckout.step.blocked' }]
  }

  const steps: CheckoutStep[] = []
  if (report.blockers.some((b) => RESOLVABLE_BLOCKERS.has(b.kind))) {
    steps.push({ id: 'path', blocking: false, titleKey: 'prCheckout.step.path' })
  }
  if (report.workspace.state !== 'none') {
    steps.push({ id: 'workspace', blocking: false, titleKey: 'prCheckout.step.workspace' })
  }
  // A purged workspace's worktree can reappear as an 'orphan' on disk during the
  // pr-watcher's restore window (see AGENTS.md § Worktree purge) — restoring the
  // workspace (via the 'workspace' step above) already handles reattaching it, so
  // this must not also surface as a separate worktree step.
  if (
    report.workspace.state !== 'purged' &&
    (report.worktree.state === 'orphan' || report.worktree.state === 'attached')
  ) {
    steps.push({ id: 'worktree', blocking: false, titleKey: 'prCheckout.step.worktree' })
  }
  if (report.ongoingOperation) {
    steps.push({ id: 'operation', blocking: false, titleKey: 'prCheckout.step.operation' })
  }
  if (report.localChanges.present) {
    steps.push({ id: 'changes', blocking: false, titleKey: 'prCheckout.step.changes' })
  }
  if (report.branch.state === 'behind' || report.branch.state === 'ahead' || report.branch.state === 'diverged') {
    steps.push({ id: 'divergence', blocking: false, titleKey: 'prCheckout.step.divergence' })
  }
  return steps
}

/**
 * The pre-selected choice for each step. The rule that matters: wherever local
 * commits or local edits exist, the default is the one that loses nothing.
 */
export function defaultDecisions(report: PrCheckoutReport): PrCheckoutDecisions {
  const decisions: PrCheckoutDecisions = {}

  if (report.workspace.state === 'active') decisions.existingWorkspace = 'open'
  if (report.workspace.state === 'archived') decisions.archivedWorkspace = 'unarchive'
  if (report.workspace.state === 'purged') decisions.purgedWorktree = 'restore'
  // A purged workspace's worktree can reappear as an 'orphan' on disk during the
  // pr-watcher's restore window (see AGENTS.md § Worktree purge) — restoring the
  // workspace already handles reattaching it, so this must not also surface as a
  // separate 'attach' decision.
  if (report.workspace.state !== 'purged' && report.worktree.state === 'orphan') decisions.orphanWorktree = 'attach'
  // 'cancel' — not 'abort' — is the loses-nothing default: aborting a rebase
  // or merge discards any conflict-resolution work already staged, exactly
  // the kind of destructive default this function otherwise avoids.
  if (report.ongoingOperation) decisions.ongoingOperation = 'cancel'
  if (report.localChanges.present) decisions.localChanges = 'keep'

  if (report.branch.state === 'behind') decisions.divergence = 'fast-forward'
  else if (report.branch.state === 'ahead' || report.branch.state === 'diverged') decisions.divergence = 'keep'

  return decisions
}
