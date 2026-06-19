import { describe, expect, it } from 'vitest'
import type { PrSnapshot } from '../../server/services/forge/types.js'
import { deriveReadyToMerge } from '../../server/services/forge/types.js'

type Args = Pick<PrSnapshot, 'state' | 'ci' | 'reviewDecision' | 'reviewers' | 'mergeable'>
function args(o: Partial<Args> = {}): Args {
  return {
    state: 'OPEN',
    ci: { rollup: 'SUCCESS', checks: [] },
    reviewDecision: null,
    reviewers: [],
    mergeable: 'MERGEABLE',
    ...o,
  }
}

describe('deriveReadyToMerge', () => {
  it('is true for OPEN + SUCCESS + no blocking review', () => {
    expect(deriveReadyToMerge(args())).toBe(true)
  })

  it('is false when CI failed, is pending, cancelled, or neutral', () => {
    expect(deriveReadyToMerge(args({ ci: { rollup: 'PENDING', checks: [] } }))).toBe(false)
    expect(deriveReadyToMerge(args({ ci: { rollup: 'FAILURE', checks: [] } }))).toBe(false)
    expect(deriveReadyToMerge(args({ ci: { rollup: 'CANCELLED', checks: [] } }))).toBe(false)
    expect(deriveReadyToMerge(args({ ci: { rollup: 'NEUTRAL', checks: [] } }))).toBe(false)
  })

  it('is true when there is no CI at all (rollup null) — mergeable like GitHub', () => {
    expect(deriveReadyToMerge(args({ ci: { rollup: null, checks: [] } }))).toBe(true)
  })

  it('is false when there is no CI but a reviewer blocks', () => {
    expect(
      deriveReadyToMerge(
        args({
          ci: { rollup: null, checks: [] },
          reviewDecision: 'CHANGES_REQUESTED',
          reviewers: [{ login: 'r', state: 'CHANGES_REQUESTED' }],
        }),
      ),
    ).toBe(false)
  })

  it('is true when REVIEW_REQUIRED with no blocking reviewer (no review submitted yet)', () => {
    expect(deriveReadyToMerge(args({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(true)
  })

  it('is false when the PR is not OPEN', () => {
    expect(deriveReadyToMerge(args({ state: 'MERGED' }))).toBe(false)
    expect(deriveReadyToMerge(args({ state: 'CLOSED' }))).toBe(false)
  })

  it('is false when a reviewer is actively requesting changes', () => {
    expect(
      deriveReadyToMerge(
        args({ reviewDecision: 'CHANGES_REQUESTED', reviewers: [{ login: 'r', state: 'CHANGES_REQUESTED' }] }),
      ),
    ).toBe(false)
  })

  it('is true when reviewDecision is sticky CHANGES_REQUESTED but no reviewer still blocks', () => {
    expect(
      deriveReadyToMerge(args({ reviewDecision: 'CHANGES_REQUESTED', reviewers: [{ login: 'r', state: 'PENDING' }] })),
    ).toBe(true)
  })

  it('is NOT ready when the branch has merge conflicts even with no CI', () => {
    expect(
      deriveReadyToMerge({
        state: 'OPEN',
        ci: { rollup: null, checks: [] },
        reviewDecision: null,
        reviewers: [],
        mergeable: 'CONFLICTING',
      }),
    ).toBe(false)
  })

  it('is ready when explicitly mergeable with no CI', () => {
    expect(
      deriveReadyToMerge({
        state: 'OPEN',
        ci: { rollup: null, checks: [] },
        reviewDecision: null,
        reviewers: [],
        mergeable: 'MERGEABLE',
      }),
    ).toBe(true)
  })

  it('treats null/unknown mergeable as non-blocking (preserves the no-CI case)', () => {
    for (const mergeable of [null, 'UNKNOWN'] as const) {
      expect(
        deriveReadyToMerge({
          state: 'OPEN',
          ci: { rollup: null, checks: [] },
          reviewDecision: null,
          reviewers: [],
          mergeable,
        }),
      ).toBe(true)
    }
  })
})
