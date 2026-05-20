import { describe, expect, it } from 'vitest'
import type { PrSnapshot, Workspace } from '../stores/workspace'
import { getAttentionReasons } from '../utils/workspace-attention'

function ws(status: string): Workspace {
  return { id: 'w1', status } as unknown as Workspace
}

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
    ...overrides,
  }
}

describe('getAttentionReasons', () => {
  it('returns no reason for an idle workspace with no PR', () => {
    expect(getAttentionReasons(ws('idle'), undefined)).toEqual([])
  })

  it('returns the awaiting-user reason for an awaiting-user workspace', () => {
    const reasons = getAttentionReasons(ws('awaiting-user'), undefined)
    expect(reasons).toEqual([{ kind: 'awaiting-user', icon: 'help', color: 'amber-5' }])
  })

  it('returns the error reason for an error workspace', () => {
    expect(getAttentionReasons(ws('error'), undefined)).toEqual([{ kind: 'error', icon: 'warning', color: 'red-5' }])
  })

  it('returns the quota reason for a quota workspace', () => {
    expect(getAttentionReasons(ws('quota'), undefined)).toEqual([{ kind: 'quota', icon: 'warning', color: 'red-5' }])
  })

  it('returns the ci-failed reason for an executing workspace with failing CI', () => {
    const reasons = getAttentionReasons(ws('executing'), snap({ ci: { rollup: 'FAILURE', checks: [] } }))
    expect(reasons).toEqual([{ kind: 'ci-failed', icon: 'cancel', color: 'red-5' }])
  })

  it('stacks all three reasons in order: status, ci-failed, changes-requested', () => {
    const reasons = getAttentionReasons(
      ws('awaiting-user'),
      snap({
        ci: { rollup: 'FAILURE', checks: [] },
        reviewDecision: 'CHANGES_REQUESTED',
        reviewers: [{ login: 'r', state: 'CHANGES_REQUESTED' }],
      }),
    )
    expect(reasons.map((r) => r.kind)).toEqual(['awaiting-user', 'ci-failed', 'changes-requested'])
  })

  it('ignores PR attention for a closed PR', () => {
    expect(getAttentionReasons(ws('idle'), snap({ state: 'CLOSED', ci: { rollup: 'FAILURE', checks: [] } }))).toEqual(
      [],
    )
  })
})
