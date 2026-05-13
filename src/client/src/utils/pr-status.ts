import type { PrSnapshot } from 'src/stores/workspace'

/**
 * GitHub keeps `reviewDecision` at CHANGES_REQUESTED even after the author
 * resolves every comment thread. From the user's perspective the PR is no
 * longer blocked. This helper returns `true` only when changes are actually
 * outstanding (review threads still open).
 *
 * The defensive `?? 0` covers snapshots cached before the field was added to
 * the contract — they'll appear with `unresolvedReviewThreadsCount=undefined`
 * for a single poll cycle, after which the watcher populates the value.
 */
export function isChangesRequestedBlocking(snapshot: PrSnapshot): boolean {
  return snapshot.reviewDecision === 'CHANGES_REQUESTED' && (snapshot.unresolvedReviewThreadsCount ?? 0) > 0
}
