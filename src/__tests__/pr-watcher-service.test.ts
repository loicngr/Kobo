import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock collaborators BEFORE importing the service.
const getPrStatusMock = vi.fn()
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn(() => 'github') }))
vi.mock('../server/services/forge/registry.js', () => ({
  getForgeProvider: vi.fn(() => ({ id: 'github', getPrStatus: getPrStatusMock })),
}))
vi.mock('../server/services/dev-server-service.js', () => ({ stopDevServer: vi.fn() }))
vi.mock('../server/services/terminal-service.js', () => ({ destroyTerminal: vi.fn() }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))
vi.mock('../server/services/workspace-service.js', () => ({
  archiveWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  markWorkspaceUnread: vi.fn(),
  updateWorkspaceSourceBranch: vi.fn(),
}))
vi.mock('../server/services/git-stats-service.js', () => ({ computeGitStats: vi.fn() }))
vi.mock('../server/utils/git-ops.js', () => ({ fetchSourceBranchAsync: vi.fn(() => Promise.resolve()) }))

import { computeGitStats } from '../server/services/git-stats-service.js'
import { _resetForTest, checkPrStatuses, getAllGitStats } from '../server/services/pr-watcher-service.js'
import * as wsSvc from '../server/services/websocket-service.js'
import * as wsService from '../server/services/workspace-service.js'

function makeWorkspace(overrides: Partial<{ id: string; name: string; sourceBranch: string; status: string }> = {}) {
  return {
    id: 'ws-1',
    name: 'test ws',
    projectPath: '/tmp/proj',
    sourceBranch: 'develop',
    workingBranch: 'feature/x',
    status: 'idle',
    notionUrl: null,
    sentryUrl: null,
    notionPageId: null,
    model: 'claude',
    engine: 'claude-code',
    reasoningEffort: 'auto' as const,
    permissionMode: 'auto-accept' as const,
    devServerStatus: 'stopped' as const,
    hasUnread: false,
    archivedAt: null,
    favoritedAt: null,
    tags: [],
    autoLoop: false,
    autoLoopReady: false,
    noProgressStreak: 0,
    permissionProfile: 'bypass' as const,
    worktreePath: '/tmp/wt',
    worktreeOwned: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  }
}

function makePrSnapshot(
  overrides: Partial<import('../server/services/forge/types.js').PrSnapshot> = {},
): import('../server/services/forge/types.js').PrSnapshot {
  return {
    number: 1,
    title: 't',
    url: 'https://github.com/x/y/pull/1',
    state: 'OPEN',
    base: 'develop',
    reviewDecision: null,
    author: { login: 'loicngr' },
    assignees: [],
    reviewers: [],
    labels: [],
    ci: { rollup: null, checks: [] },
    updatedAt: '2026-05-12T10:00:00Z',
    unresolvedReviewThreadsCount: 0,
    ...overrides,
  }
}

describe('checkPrStatuses — base change detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })
  afterEach(() => {
    _resetForTest()
  })

  it('first-sight: workspace.sourceBranch differs from PR base → emits pr:base-changed and updates DB', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: 'main', url: 'https://github.com/x/y/pull/1' }))

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).toHaveBeenCalledWith('ws-1', 'main')
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:base-changed', {
      oldBase: 'develop',
      newBase: 'main',
      prUrl: 'https://github.com/x/y/pull/1',
    })
  })

  it('first-sight: workspace.sourceBranch matches PR base → silent, no event, no DB write', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: 'develop', url: 'https://github.com/x/y/pull/1' }))

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalled()
  })

  it('transition: lastKnownPr base differs from new PR base → emits + updates', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    // First check: silent populate (sourceBranch === base)
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: 'develop', url: 'https://github.com/x/y/pull/1' }))
    await checkPrStatuses()
    vi.clearAllMocks()
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    // Second check: base flipped to main
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: 'main', url: 'https://github.com/x/y/pull/1' }))

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).toHaveBeenCalledWith('ws-1', 'main')
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:base-changed', {
      oldBase: 'develop',
      newBase: 'main',
      prUrl: 'https://github.com/x/y/pull/1',
    })
  })

  it('closed PR is skipped — no base-change event regardless of baseRefName', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(
      makePrSnapshot({ state: 'CLOSED', base: 'main', url: 'https://github.com/x/y/pull/1' }),
    )

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:base-changed', expect.anything())
  })

  it('PR without base field (defensive) — no event, populates lastKnownPr', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: '', url: 'https://github.com/x/y/pull/1' }))

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalled()
  })
})

describe('getAllPrSnapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('returns the full snapshot per known workspace, keyed by id', async () => {
    const { getAllPrSnapshots } = await import('../server/services/pr-watcher-service.js')
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ number: 99, base: 'main', reviewDecision: 'APPROVED' }))
    await checkPrStatuses()

    expect(getAllPrSnapshots()).toEqual({
      'ws-1': expect.objectContaining({ number: 99, reviewDecision: 'APPROVED' }),
    })
  })
})

describe('checkPrStatuses — active-agent guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('still fetches and caches the snapshot for an executing workspace', async () => {
    const ws = makeWorkspace({ status: 'executing', sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ number: 7, base: 'main' }))

    await checkPrStatuses()

    const { getAllPrSnapshots } = await import('../server/services/pr-watcher-service.js')
    expect(getAllPrSnapshots()['ws-1']).toMatchObject({ number: 7 })
  })

  it('does NOT auto-archive an executing workspace on OPEN → MERGED', async () => {
    const ws = makeWorkspace({ status: 'executing', sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    // First tick: OPEN, baseline.
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'OPEN', base: 'main' }))
    await checkPrStatuses()
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()

    // Second tick: MERGED, agent still executing — must not archive.
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'MERGED', base: 'main' }))
    await checkPrStatuses()
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('DOES auto-archive an idle workspace on OPEN → MERGED (regression)', async () => {
    const ws = makeWorkspace({ status: 'idle', sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'OPEN', base: 'main' }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'MERGED', base: 'main' }))
    await checkPrStatuses()

    expect(wsService.archiveWorkspace).toHaveBeenCalledWith('ws-1')
  })
})

describe('checkPrStatuses — review-decision transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('emits pr:changes-requested on REVIEW_REQUIRED → CHANGES_REQUESTED', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'REVIEW_REQUIRED' }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED' }))
    await checkPrStatuses()

    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:changes-requested', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
  })

  it('emits pr:approved on CHANGES_REQUESTED → APPROVED', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED' }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'APPROVED' }))
    await checkPrStatuses()

    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:approved', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
  })

  it('first-sight CHANGES_REQUESTED does NOT emit pr:changes-requested', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED' }))

    await checkPrStatuses()

    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:changes-requested', expect.anything())
  })

  it('does not emit transitions when PR is not OPEN', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ state: 'OPEN', base: 'main', reviewDecision: 'REVIEW_REQUIRED' }),
    )
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ state: 'CLOSED', base: 'main', reviewDecision: 'CHANGES_REQUESTED' }),
    )
    await checkPrStatuses()

    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:changes-requested', expect.anything())
  })
})

describe('checkPrStatuses — unread on attention transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('marks unread on REVIEW_REQUIRED → CHANGES_REQUESTED', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'REVIEW_REQUIRED' }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED' }))
    await checkPrStatuses()

    expect(wsService.markWorkspaceUnread).toHaveBeenCalledWith('ws-1')
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:unread', { hasUnread: true })
  })

  it('marks unread on CI rollup SUCCESS → FAILURE', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ci: { rollup: 'SUCCESS', checks: [] } }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ci: { rollup: 'FAILURE', checks: [] } }))
    await checkPrStatuses()

    expect(wsService.markWorkspaceUnread).toHaveBeenCalledWith('ws-1')
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'workspace:unread', { hasUnread: true })
  })

  it('does NOT re-mark unread when CI stays FAILURE across ticks', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ci: { rollup: 'FAILURE', checks: [] } }))
    await checkPrStatuses()
    // First sight is silent (no prev).
    expect(wsService.markWorkspaceUnread).not.toHaveBeenCalled()

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ci: { rollup: 'FAILURE', checks: [] } }))
    await checkPrStatuses()
    expect(wsService.markWorkspaceUnread).not.toHaveBeenCalled()
  })

  it('first-sight CHANGES_REQUESTED + FAILURE does NOT mark unread', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    getPrStatusMock.mockResolvedValue(
      makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED', ci: { rollup: 'FAILURE', checks: [] } }),
    )

    await checkPrStatuses()

    expect(wsService.markWorkspaceUnread).not.toHaveBeenCalled()
  })

  it('does not mark unread when PR is not OPEN', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ state: 'OPEN', base: 'main', ci: { rollup: 'SUCCESS', checks: [] } }),
    )
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ state: 'CLOSED', base: 'main', ci: { rollup: 'FAILURE', checks: [] } }),
    )
    await checkPrStatuses()

    expect(wsService.markWorkspaceUnread).not.toHaveBeenCalled()
  })
})

describe('refreshPrSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('returns the fresh snapshot and updates the cache when the PR exists', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    vi.mocked(wsService.getWorkspace).mockReturnValue(ws as never)
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ number: 99, base: 'main' }))

    const { refreshPrSnapshot, getAllPrSnapshots } = await import('../server/services/pr-watcher-service.js')
    const snap = await refreshPrSnapshot('ws-1')

    expect(snap).toMatchObject({ number: 99 })
    expect(getAllPrSnapshots()['ws-1']).toMatchObject({ number: 99 })
  })

  it('returns null and clears the cache entry when the PR is gone', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    vi.mocked(wsService.getWorkspace).mockReturnValue(ws as never)

    // Seed cache via a normal tick.
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main' }))
    await checkPrStatuses()

    // Manual refresh after PR deletion.
    getPrStatusMock.mockResolvedValueOnce(null)
    const { refreshPrSnapshot, getAllPrSnapshots } = await import('../server/services/pr-watcher-service.js')
    const snap = await refreshPrSnapshot('ws-1')

    expect(snap).toBeNull()
    expect(getAllPrSnapshots()['ws-1']).toBeUndefined()
  })

  it('throws when the workspace does not exist', async () => {
    vi.mocked(wsService.getWorkspace).mockReturnValue(null)
    const { refreshPrSnapshot } = await import('../server/services/pr-watcher-service.js')

    await expect(refreshPrSnapshot('ws-missing')).rejects.toThrow(/not found/i)
  })

  it('does NOT emit transitions on manual refresh', async () => {
    const ws = makeWorkspace({ sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    vi.mocked(wsService.getWorkspace).mockReturnValue(ws as never)

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'REVIEW_REQUIRED' }))
    await checkPrStatuses()

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', reviewDecision: 'CHANGES_REQUESTED' }))
    const { refreshPrSnapshot } = await import('../server/services/pr-watcher-service.js')
    await refreshPrSnapshot('ws-1')

    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:changes-requested', expect.anything())
  })
})

describe('checkPrStatuses — git stats caching', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
  })

  it('caches git stats for every non-archived workspace, including PR-less ones', async () => {
    const wsWithPr = makeWorkspace({ id: 'ws-pr' })
    const wsNoPr = makeWorkspace({ id: 'ws-nopr' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([wsWithPr, wsNoPr] as never)
    getPrStatusMock.mockImplementation((_path: string, branch: string) =>
      branch === wsWithPr.workingBranch ? Promise.resolve({ state: 'OPEN', url: 'u' }) : Promise.resolve(null),
    )
    vi.mocked(computeGitStats).mockResolvedValue({ commitCount: 7 } as never)

    await checkPrStatuses()

    const stats = getAllGitStats()
    expect(stats['ws-pr']).toEqual({ commitCount: 7 })
    expect(stats['ws-nopr']).toEqual({ commitCount: 7 })
  })

  it('a git-stats computation failure does not block other workspaces', async () => {
    const wsA = makeWorkspace({ id: 'ws-a' })
    const wsB = makeWorkspace({ id: 'ws-b' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([wsA, wsB] as never)
    getPrStatusMock.mockResolvedValue(null)
    vi.mocked(computeGitStats)
      .mockRejectedValueOnce(new Error('git boom'))
      .mockResolvedValueOnce({ commitCount: 2 } as never)

    await checkPrStatuses()

    const stats = getAllGitStats()
    expect(stats['ws-a']).toBeUndefined()
    expect(stats['ws-b']).toEqual({ commitCount: 2 })
  })
})
