// src/server/services/forge/types.ts

/** Known forge identifiers. `none` means "no supported forge / PR features off". */
export type ForgeId = 'github' | 'gitlab' | 'none'

/** Per-reviewer state in a PR/MR. Pending = requested but no review yet. */
export interface PrReviewer {
  login: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
}

/** Per-check entry from the PR/MR status check rollup. */
export interface PrCiCheck {
  name: string
  conclusion: string | null
  status: string
  detailsUrl: string | null
}

/** Rich snapshot of a pull/merge request, normalised across forges. */
export interface PrSnapshot {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  base: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  author: { login: string }
  assignees: Array<{ login: string }>
  reviewers: PrReviewer[]
  labels: Array<{ name: string; color: string }>
  ci: {
    rollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'CANCELLED' | 'NEUTRAL' | null
    checks: PrCiCheck[]
  }
  updatedAt: string
  /** Unresolved review threads. Stays 0 on forges that don't expose it. */
  unresolvedReviewThreadsCount: number
  /** Computed: OPEN + CI green or absent + no merge conflict + not blocked by changes-requested. */
  readyToMerge: boolean
  /** Merge conflict state from the forge. `CONFLICTING` and `UNKNOWN` both
   *  block readyToMerge — GitHub reports `UNKNOWN` while it recomputes
   *  mergeability after the base branch advances, which is exactly the
   *  window where a conflicting PR would otherwise show as ready.
   *  `null` = forge didn't report it at all (treated as non-blocking). */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
}

/**
 * True when nothing blocks merging the PR: it is open, CI is not failing or
 * in-flight (green `SUCCESS` or absent `null` — matching GitHub's "Ready to
 * merge"), no reviewer is actively requesting changes, and the forge doesn't
 * report an active or pending merge conflict. `null` covers repos or PRs
 * with no CI configured, or forges that don't report `mergeable` at all.
 * `UNKNOWN` is treated as blocking, not as "no data" — GitHub uses it while
 * asynchronously recomputing mergeability (e.g. right after the base branch
 * advances), so treating it as non-blocking would show a conflicting PR as
 * ready during that window. Pending/failure/cancelled/neutral CI is NOT
 * ready. Mirrors the front-end blocking rule — trust a reviewer still in
 * CHANGES_REQUESTED, not the sticky `reviewDecision` alone.
 */
export function deriveReadyToMerge(
  s: Pick<PrSnapshot, 'state' | 'ci' | 'reviewDecision' | 'reviewers' | 'mergeable'>,
): boolean {
  const blocked = s.reviewDecision === 'CHANGES_REQUESTED' && s.reviewers.some((r) => r.state === 'CHANGES_REQUESTED')
  const ciOk = s.ci.rollup === 'SUCCESS' || s.ci.rollup === null
  const noConflict = s.mergeable === 'MERGEABLE' || s.mergeable === null
  return s.state === 'OPEN' && ciOk && !blocked && noConflict
}

/** Capabilities a provider declares so the UI can adapt without probing. */
export interface ForgeCapabilities {
  canCreatePr: boolean
  canChangePrBase: boolean
  canMergeRequest: boolean
  canDeleteRemoteBranch: boolean
  /** Short request term for UI labels. */
  requestTermShort: 'PR' | 'MR'
}

/** Result of probing whether the forge CLI is usable. */
export interface ForgeAvailability {
  available: boolean
  reason?: 'cli_missing' | 'not_authenticated'
}

/** Options for opening a new pull/merge request. */
export interface CreatePrOptions {
  base: string
  head: string
  title: string
  body: string
}

/** Thrown by write operations when the forge cannot service them. */
export class ForgeUnavailableError extends Error {
  readonly code = 'forge_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'ForgeUnavailableError'
  }
}

/** A forge integration. One implementation per supported forge. */
export interface ForgeProvider {
  readonly id: ForgeId
  readonly capabilities: ForgeCapabilities
  /** Probe whether the underlying CLI is installed and authenticated. */
  isAvailable(repoPath: string): Promise<ForgeAvailability>
  getPrStatus(repoPath: string, branch: string): Promise<PrSnapshot | null>
  createPr(repoPath: string, opts: CreatePrOptions): Promise<{ url: string; number: number }>
  changePrBase(repoPath: string, base: string): Promise<void>
  mergeRequest(repoPath: string, number: number): Promise<void>
  deleteRemoteBranch(repoPath: string, branch: string): Promise<void>
}
