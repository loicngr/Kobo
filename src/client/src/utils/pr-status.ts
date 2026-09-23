import type { PrSnapshot } from 'src/stores/workspace'

/**
 * True when an open PR is genuinely blocked by an active CHANGES_REQUESTED
 * reviewer.
 *
 * Why not just `reviewDecision === 'CHANGES_REQUESTED'`: GitHub keeps that
 * field sticky even after a review is dismissed and a re-review is requested
 * (`latestReviews` empties, the reviewer's state flips to PENDING, but
 * `reviewDecision` stays CHANGES_REQUESTED until someone re-reviews). Trusting
 * `reviewDecision` alone leaves the card stuck in "Needs Attention" forever.
 * Combining it with `reviewers.some(state === 'CHANGES_REQUESTED')` — the
 * mapped projection of `latestReviews` from the GitHub provider — clears the
 * card as soon as the offending review is dismissed.
 *
 * We deliberately do NOT use `unresolvedReviewThreadsCount`: the `gh` CLI
 * cannot fetch review threads, so that counter is always 0.
 */
export function isChangesRequestedBlocking(snapshot: PrSnapshot): boolean {
  return (
    snapshot.state === 'OPEN' &&
    snapshot.reviewDecision === 'CHANGES_REQUESTED' &&
    snapshot.reviewers.some((r) => r.state === 'CHANGES_REQUESTED')
  )
}

/** True when the PR's last CI run failed. Open PRs only. */
export function isCiFailed(snapshot: PrSnapshot): boolean {
  return snapshot.state === 'OPEN' && snapshot.ci.rollup === 'FAILURE'
}

/**
 * True when a PR snapshot warrants pulling its workspace into the
 * "Needs Attention" group — failing CI or blocking changes-requested.
 */
export function hasPrAttention(snapshot: PrSnapshot | undefined): boolean {
  if (!snapshot) return false
  return isCiFailed(snapshot) || isChangesRequestedBlocking(snapshot)
}
