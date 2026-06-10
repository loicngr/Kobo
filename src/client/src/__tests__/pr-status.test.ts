import { describe, expect, it } from 'vitest'
import type { PrSnapshot } from '../stores/workspace'
import { hasPrAttention, isChangesRequestedBlocking, isCiFailed } from '../utils/pr-status'

function snap(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 1,
    title: 't',
    url: 'u',
    state: 'OPEN',
    base: 'main',
    reviewDecision: null,
    author: { login: 'a' },
    assignees: [],
    reviewers: [],
    labels: [],
    ci: { rollup: null, checks: [] },
    updatedAt: '',
    unresolvedReviewThreadsCount: 0,
    readyToMerge: false,
    ...overrides,
  }
}

describe('isCiFailed', () => {
  it('is true for an open PR with a FAILURE rollup', () => {
    expect(isCiFailed(snap({ ci: { rollup: 'FAILURE', checks: [] } }))).toBe(true)
  })
  it('is false for SUCCESS / PENDING / null rollups', () => {
    expect(isCiFailed(snap({ ci: { rollup: 'SUCCESS', checks: [] } }))).toBe(false)
    expect(isCiFailed(snap({ ci: { rollup: 'PENDING', checks: [] } }))).toBe(false)
    expect(isCiFailed(snap())).toBe(false)
  })
  it('is false for a closed/merged PR even with a FAILURE rollup', () => {
    expect(isCiFailed(snap({ state: 'CLOSED', ci: { rollup: 'FAILURE', checks: [] } }))).toBe(false)
    expect(isCiFailed(snap({ state: 'MERGED', ci: { rollup: 'FAILURE', checks: [] } }))).toBe(false)
  })
})

describe('isChangesRequestedBlocking', () => {
  it('is false for a merged PR with changes requested', () => {
    expect(
      isChangesRequestedBlocking(
        snap({ state: 'MERGED', reviewDecision: 'CHANGES_REQUESTED', unresolvedReviewThreadsCount: 2 }),
      ),
    ).toBe(false)
  })
  it('is false for a closed PR with changes requested', () => {
    expect(
      isChangesRequestedBlocking(
        snap({ state: 'CLOSED', reviewDecision: 'CHANGES_REQUESTED', unresolvedReviewThreadsCount: 2 }),
      ),
    ).toBe(false)
  })
  it('is true when an active reviewer has CHANGES_REQUESTED', () => {
    expect(
      isChangesRequestedBlocking(
        snap({
          reviewDecision: 'CHANGES_REQUESTED',
          reviewers: [{ login: 'r', state: 'CHANGES_REQUESTED' }],
        }),
      ),
    ).toBe(true)
  })
  it('is false when the review was dismissed even though reviewDecision is still CHANGES_REQUESTED (sticky)', () => {
    // Regression: GitHub keeps reviewDecision=CHANGES_REQUESTED after a review
    // is dismissed and a re-review is requested. `latestReviews` empties out;
    // reviewers carry state PENDING. Card must leave "Needs Attention".
    expect(
      isChangesRequestedBlocking(
        snap({
          reviewDecision: 'CHANGES_REQUESTED',
          reviewers: [{ login: 'r', state: 'PENDING' }],
        }),
      ),
    ).toBe(false)
  })
  it('is false with no reviewers at all (e.g. fresh open PR with stale reviewDecision)', () => {
    expect(isChangesRequestedBlocking(snap({ reviewDecision: 'CHANGES_REQUESTED', reviewers: [] }))).toBe(false)
  })
})

describe('hasPrAttention', () => {
  it('is false for undefined', () => {
    expect(hasPrAttention(undefined)).toBe(false)
  })
  it('is true when CI failed', () => {
    expect(hasPrAttention(snap({ ci: { rollup: 'FAILURE', checks: [] } }))).toBe(true)
  })
  it('is true when changes are requested and blocking', () => {
    expect(
      hasPrAttention(
        snap({
          reviewDecision: 'CHANGES_REQUESTED',
          reviewers: [{ login: 'r', state: 'CHANGES_REQUESTED' }],
        }),
      ),
    ).toBe(true)
  })
  it('is false for a clean open PR', () => {
    expect(hasPrAttention(snap())).toBe(false)
  })
})
