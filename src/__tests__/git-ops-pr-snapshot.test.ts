import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFileSync: vi.fn(), execFile: vi.fn() }
})

describe('getPrStatus → PrSnapshot mapping', () => {
  beforeEach(() => vi.clearAllMocks())

  function mockGhJson(payload: unknown) {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(payload) as never)
  }

  it('maps a fully populated gh response into a PrSnapshot', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    mockGhJson({
      number: 42,
      title: 'fix(auth): handle expired tokens',
      url: 'https://github.com/x/y/pull/42',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: 'CHANGES_REQUESTED',
      author: { login: 'loicngr' },
      assignees: [{ login: 'loicngr' }],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'priority:high', color: 'b60205' },
      ],
      latestReviews: [
        { author: { login: 'alice' }, state: 'CHANGES_REQUESTED' },
        { author: { login: 'bob' }, state: 'APPROVED' },
      ],
      reviewRequests: [{ login: 'charlie' }],
      reviewThreads: [{ isResolved: false }, { isResolved: true }],
      statusCheckRollup: [
        { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: 'https://ci/build' },
        { name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://ci/test' },
        { name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: 'https://ci/lint' },
      ],
      updatedAt: '2026-05-12T10:00:00Z',
    })

    const snap = getPrStatus('/repo', 'feature/x')

    expect(snap).toMatchObject({
      number: 42,
      title: 'fix(auth): handle expired tokens',
      url: 'https://github.com/x/y/pull/42',
      state: 'OPEN',
      base: 'main',
      reviewDecision: 'CHANGES_REQUESTED',
      author: { login: 'loicngr' },
      assignees: [{ login: 'loicngr' }],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'priority:high', color: 'b60205' },
      ],
      ci: { rollup: 'FAILURE' },
      updatedAt: '2026-05-12T10:00:00Z',
    })
    expect(snap!.reviewers).toEqual(
      expect.arrayContaining([
        { login: 'alice', state: 'CHANGES_REQUESTED' },
        { login: 'bob', state: 'APPROVED' },
        { login: 'charlie', state: 'PENDING' },
      ]),
    )
    expect(snap!.reviewers).toHaveLength(3)
    expect(snap!.ci.checks).toHaveLength(3)
    expect(snap!.unresolvedReviewThreadsCount).toBe(1)
  })

  it('returns null when gh fails', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no pr')
    })
    expect(getPrStatus('/repo', 'feature/x')).toBeNull()
  })

  it('derives ci.rollup=null when statusCheckRollup is empty', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    mockGhJson({
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: null,
      author: { login: 'a' },
      assignees: [],
      labels: [],
      latestReviews: [],
      reviewRequests: [],
      reviewThreads: [],
      statusCheckRollup: [],
      updatedAt: '2026-05-12T10:00:00Z',
    })
    const snap = getPrStatus('/repo', 'feature/x')!
    expect(snap.ci.rollup).toBeNull()
    expect(snap.unresolvedReviewThreadsCount).toBe(0)
  })

  it('derives ci.rollup=PENDING when at least one check is not COMPLETED and none FAILURE', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    mockGhJson({
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: null,
      author: { login: 'a' },
      assignees: [],
      labels: [],
      latestReviews: [],
      reviewRequests: [],
      reviewThreads: [],
      statusCheckRollup: [
        { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null },
        { name: 'test', conclusion: null, status: 'IN_PROGRESS', detailsUrl: null },
      ],
      updatedAt: '2026-05-12T10:00:00Z',
    })
    expect(getPrStatus('/repo', 'feature/x')!.ci.rollup).toBe('PENDING')
  })

  it('dedupes overlapping login between latestReviews and reviewRequests (latest wins)', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    mockGhJson({
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: null,
      author: { login: 'a' },
      assignees: [],
      labels: [],
      latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
      reviewRequests: [{ login: 'alice' }],
      reviewThreads: [],
      statusCheckRollup: [],
      updatedAt: '2026-05-12T10:00:00Z',
    })
    const snap = getPrStatus('/repo', 'feature/x')!
    expect(snap.reviewers).toEqual([{ login: 'alice', state: 'APPROVED' }])
  })

  it('defaults unresolvedReviewThreadsCount to 0 when reviewThreads is omitted (old gh versions)', async () => {
    const { getPrStatus } = await import('../server/utils/git-ops.js')
    mockGhJson({
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: 'CHANGES_REQUESTED',
      author: { login: 'a' },
      assignees: [],
      labels: [],
      latestReviews: [],
      reviewRequests: [],
      statusCheckRollup: [],
      updatedAt: '2026-05-12T10:00:00Z',
    })
    expect(getPrStatus('/repo', 'feature/x')!.unresolvedReviewThreadsCount).toBe(0)
  })
})
