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
  listArchivedWorkspaces: vi.fn(() => []),
  listWorkspaces: vi.fn(),
  markWorkspaceUnread: vi.fn(),
  restoreWorktreeFromDisk: vi.fn(),
  updateWorkspaceSourceBranch: vi.fn(),
}))
vi.mock('../server/services/git-stats-service.js', () => ({ computeGitStats: vi.fn() }))
vi.mock('../server/services/lifecycle-hook-service.js', () => ({ onPrMerged: vi.fn(async () => {}) }))
vi.mock('../server/services/worktree-purge-service.js', () => ({
  purgeWorktree: vi.fn(async () => ({ outcome: 'purged', warnings: [] })),
}))
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(() => ({ autoPurgeOnPrMerged: false })),
}))
// The watcher asks whether a session is still live before archiving; default to
// "no controller" so the existing status-driven tests keep their meaning.
vi.mock('../server/services/agent/orchestrator.js', () => ({ hasController: vi.fn(() => false) }))
const gitTrace: string[] = []
vi.mock('../server/utils/git-ops.js', () => ({
  fetchSourceBranchAsync: vi.fn(async () => {
    gitTrace.push('fetch:start')
    await new Promise((resolve) => setTimeout(resolve, 10))
    gitTrace.push('fetch:end')
  }),
  isGitWorktree: vi.fn(() => false),
}))
vi.mock('../server/services/worktree-service.js', () => ({ isMatchingWorkspaceWorktree: vi.fn(() => false) }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => true), default: { ...actual, existsSync: vi.fn(() => true) } }
})

import * as orchestrator from '../server/services/agent/orchestrator.js'
import { computeGitStats } from '../server/services/git-stats-service.js'
import {
  _resetForTest,
  checkPrStatuses,
  clearPrSnapshotCache,
  getAllGitStats,
  getAllPrSnapshots,
  invalidateWorkspacePrCaches,
  refreshPrSnapshot,
} from '../server/services/pr-watcher-service.js'
import * as wsSvc from '../server/services/websocket-service.js'
import * as wsService from '../server/services/workspace-service.js'
import { isMatchingWorkspaceWorktree } from '../server/services/worktree-service.js'
import * as gitOps from '../server/utils/git-ops.js'
import { withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

function makeWorkspace(
  overrides: Partial<{
    id: string
    name: string
    sourceBranch: string
    status: string
    prWatchDisabledAt?: string | null
  }> = {},
) {
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
    prWatchDisabledAt: null,
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
    mergeable: null,
    readyToMerge: false,
    ...overrides,
  }
}

async function runPrTransition(
  before: Partial<import('../server/services/forge/types.js').PrSnapshot>,
  after: Partial<import('../server/services/forge/types.js').PrSnapshot>,
  workspace = makeWorkspace({ sourceBranch: 'main', status: 'idle' }),
): Promise<void> {
  vi.mocked(wsService.listWorkspaces).mockReturnValue([workspace] as never)
  vi.mocked(computeGitStats).mockResolvedValue({} as never)
  getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ...before }))
  await checkPrStatuses()
  getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ...after }))
  await checkPrStatuses()
}

beforeEach(() => {
  vi.mocked(wsService.getWorkspace).mockImplementation(
    (id) => [...wsService.listWorkspaces(), ...wsService.listArchivedWorkspaces()].find((ws) => ws.id === id) ?? null,
  )
  vi.mocked(wsService.archiveWorkspace).mockImplementation((id) => {
    const archived = { ...wsService.getWorkspace(id), archivedAt: '2026-09-09T01:00:00.000Z' }
    vi.mocked(wsService.getWorkspace).mockReturnValue(archived as never)
    return archived as never
  })
})

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

describe('checkPrStatuses — git stats fetch ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('waits for the fetch before computing git stats, so counters are not one tick late', async () => {
    gitTrace.length = 0
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace()] as never)
    vi.mocked(computeGitStats).mockImplementation(async () => {
      gitTrace.push('stats')
      return {} as never
    })
    getPrStatusMock.mockResolvedValue(null)

    await checkPrStatuses()

    expect(gitTrace).toEqual(['fetch:start', 'fetch:end', 'stats'])
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
    // clearAllMocks keeps implementations, so restate the default: no live
    // controller, which is what the status-driven cases below assume.
    vi.mocked(orchestrator.hasController).mockReturnValue(false)
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

  it('does NOT auto-archive while an agent controller is still alive', async () => {
    // `awaiting-user` is not in the status guard, yet the controller is very
    // much alive: it is parked on a tool approval. Archiving there orphans the
    // pending question and leaves the agent writing to the worktree.
    const ws = makeWorkspace({ status: 'awaiting-user', sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    vi.mocked(orchestrator.hasController).mockReturnValue(true)

    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'OPEN', base: 'main' }))
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'MERGED', base: 'main' }))
    await checkPrStatuses()

    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('runs the pr-merged hook and waits for it before auto-purging the worktree', async () => {
    const hooks = await import('../server/services/lifecycle-hook-service.js')
    const purge = await import('../server/services/worktree-purge-service.js')
    const settings = await import('../server/services/settings-service.js')
    vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: true } as never)
    const ws = makeWorkspace({ status: 'idle', sourceBranch: 'main' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])

    // A hook that takes a while — the purge must not start before it ends,
    // or a deploy script loses its worktree mid-run.
    let releaseHook: () => void = () => {}
    const trace: string[] = []
    vi.mocked(hooks.onPrMerged).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          trace.push('hook:start')
          releaseHook = () => {
            trace.push('hook:end')
            resolve()
          }
        }),
    )
    vi.mocked(purge.purgeWorktree).mockImplementation(async () => {
      trace.push('purge')
      return { outcome: 'purged', warnings: [] } as never
    })

    try {
      getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'OPEN', base: 'main' }))
      await checkPrStatuses()
      getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ state: 'MERGED', base: 'main', number: 42 }))
      const tick = checkPrStatuses()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(hooks.onPrMerged).toHaveBeenCalledWith('ws-1', expect.objectContaining({ prNumber: 42 }))
      expect(trace).toEqual(['hook:start'])
      releaseHook()
      await tick
      expect(trace).toEqual(['hook:start', 'hook:end', 'purge'])
      expect(purge.purgeWorktree).toHaveBeenCalledWith('ws-1', '2026-09-09T01:00:00.000Z')
    } finally {
      // `clearAllMocks` in beforeEach keeps implementations: a pending hook
      // left behind would hang the next test's tick.
      vi.mocked(hooks.onPrMerged).mockImplementation(async () => {})
      vi.mocked(purge.purgeWorktree).mockImplementation(async () => ({ outcome: 'purged', warnings: [] }) as never)
      vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: false } as never)
    }
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

describe('checkPrStatuses — configurable notification transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
  })

  it('emits and marks unread when CI first fails', async () => {
    await runPrTransition({ ci: { rollup: 'PENDING', checks: [] } }, { ci: { rollup: 'FAILURE', checks: [] } })
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:ci-failed', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
    expect(wsService.markWorkspaceUnread).toHaveBeenCalledWith('ws-1')
  })

  it('emits without marking unread when CI recovers', async () => {
    await runPrTransition({ ci: { rollup: 'FAILURE', checks: [] } }, { ci: { rollup: 'SUCCESS', checks: [] } })
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:ci-recovered', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
    expect(wsService.markWorkspaceUnread).not.toHaveBeenCalled()
  })

  it('emits approval from REVIEW_REQUIRED', async () => {
    await runPrTransition({ reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'APPROVED' })
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:approved', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
  })

  it('emits and marks unread when a merge conflict appears', async () => {
    await runPrTransition({ mergeable: 'MERGEABLE' }, { mergeable: 'CONFLICTING' })
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:merge-conflict', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
    expect(wsService.markWorkspaceUnread).toHaveBeenCalledWith('ws-1')
  })

  it('emits every simultaneous transition', async () => {
    await runPrTransition(
      {
        reviewDecision: 'REVIEW_REQUIRED',
        ci: { rollup: 'FAILURE', checks: [] },
        mergeable: 'MERGEABLE',
        readyToMerge: false,
      },
      {
        reviewDecision: 'APPROVED',
        ci: { rollup: 'SUCCESS', checks: [] },
        mergeable: 'MERGEABLE',
        readyToMerge: true,
      },
    )
    const emittedTypes = vi.mocked(wsSvc.emitEphemeral).mock.calls.map((call) => call[1])
    expect(emittedTypes).toEqual(expect.arrayContaining(['pr:ci-recovered', 'pr:approved', 'pr:ready-to-merge']))
  })

  it('emits merged even when the workspace is busy and skips archive', async () => {
    await runPrTransition(
      { state: 'OPEN' },
      { state: 'MERGED' },
      makeWorkspace({ sourceBranch: 'main', status: 'executing' }),
    )
    expect(wsSvc.emitEphemeral).toHaveBeenCalledWith('ws-1', 'pr:merged', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('does not repeat events when the snapshot remains unchanged', async () => {
    await runPrTransition({ ci: { rollup: 'PENDING', checks: [] } }, { ci: { rollup: 'FAILURE', checks: [] } })
    vi.mocked(wsSvc.emitEphemeral).mockClear()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', ci: { rollup: 'FAILURE', checks: [] } }))
    await checkPrStatuses()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:ci-failed', expect.anything())
  })

  it('keeps first sight silent for all notification states', async () => {
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace({ sourceBranch: 'main' })] as never)
    vi.mocked(computeGitStats).mockResolvedValue({} as never)
    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({
        base: 'main',
        reviewDecision: 'APPROVED',
        ci: { rollup: 'FAILURE', checks: [] },
        mergeable: 'CONFLICTING',
        readyToMerge: true,
      }),
    )

    await checkPrStatuses()

    const emittedTypes = vi.mocked(wsSvc.emitEphemeral).mock.calls.map((call) => call[1])
    expect(emittedTypes).not.toContain('pr:ci-failed')
    expect(emittedTypes).not.toContain('pr:approved')
    expect(emittedTypes).not.toContain('pr:merge-conflict')
    expect(emittedTypes).not.toContain('pr:ready-to-merge')

    _resetForTest()
    vi.mocked(wsSvc.emitEphemeral).mockClear()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ base: 'main', state: 'MERGED' }))
    await checkPrStatuses()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:merged', expect.anything())
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

describe('checkPrStatuses — PR-watch opt-out', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
  })

  it('skips the forge call for a disabled workspace, but still computes git stats', async () => {
    const ws = makeWorkspace({ id: 'ws-disabled', prWatchDisabledAt: '2026-01-01T00:00:00.000Z' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws] as never)
    vi.mocked(computeGitStats).mockResolvedValue({ commitCount: 3 } as never)

    await checkPrStatuses()

    expect(getPrStatusMock).not.toHaveBeenCalled()
    expect(computeGitStats).toHaveBeenCalledWith(ws, null)
    expect(getAllGitStats()['ws-disabled']).toEqual({ commitCount: 3 })
  })

  it('still calls the forge for a workspace where PR-watch is not disabled', async () => {
    const ws = makeWorkspace({ id: 'ws-enabled' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws] as never)
    getPrStatusMock.mockResolvedValue(null)
    vi.mocked(computeGitStats).mockResolvedValue({ commitCount: 1 } as never)

    await checkPrStatuses()

    expect(getPrStatusMock).toHaveBeenCalledWith(ws.worktreePath, ws.workingBranch)
  })
})

describe('clearPrSnapshotCache', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
  })

  it('removes only the targeted workspace from getAllPrSnapshots, leaving others untouched', async () => {
    const wsA = makeWorkspace({ id: 'ws-a' })
    const wsB = makeWorkspace({ id: 'ws-b' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([wsA, wsB] as never)
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ number: 1 }))

    await checkPrStatuses()

    const { getAllPrSnapshots } = await import('../server/services/pr-watcher-service.js')
    expect(getAllPrSnapshots()['ws-a']).toBeDefined()
    expect(getAllPrSnapshots()['ws-b']).toBeDefined()

    clearPrSnapshotCache('ws-a')

    expect(getAllPrSnapshots()['ws-a']).toBeUndefined()
    expect(getAllPrSnapshots()['ws-b']).toBeDefined()
  })
})

describe('checkPrStatuses — ready-to-merge transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    vi.mocked(computeGitStats).mockResolvedValue({} as never)
  })

  it('emits pr:ready-to-merge and marks unread on a non-busy false->true transition', async () => {
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace({ status: 'idle' })] as never)
    // Tick 1: pending CI — establishes prev, no emit.
    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ ci: { rollup: 'PENDING', checks: [] }, readyToMerge: false }),
    )
    await checkPrStatuses()
    // Tick 2: CI green -> ready.
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true }))
    await checkPrStatuses()

    expect(vi.mocked(wsSvc.emitEphemeral)).toHaveBeenCalledWith('ws-1', 'pr:ready-to-merge', {
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
    })
    expect(vi.mocked(wsService.markWorkspaceUnread)).toHaveBeenCalledWith('ws-1')
  })

  it('does not emit on first sight (no prev)', async () => {
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace({ status: 'idle' })] as never)
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true }))
    await checkPrStatuses()
    expect(vi.mocked(wsSvc.emitEphemeral)).not.toHaveBeenCalledWith('ws-1', 'pr:ready-to-merge', expect.anything())
  })

  it('does not emit when the workspace is busy', async () => {
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace({ status: 'executing' })] as never)
    getPrStatusMock.mockResolvedValueOnce(
      makePrSnapshot({ ci: { rollup: 'PENDING', checks: [] }, readyToMerge: false }),
    )
    await checkPrStatuses()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true }))
    await checkPrStatuses()
    expect(vi.mocked(wsSvc.emitEphemeral)).not.toHaveBeenCalledWith('ws-1', 'pr:ready-to-merge', expect.anything())
  })

  it('does not emit when already ready (no transition)', async () => {
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace({ status: 'idle' })] as never)
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true }))
    await checkPrStatuses()
    vi.mocked(wsSvc.emitEphemeral).mockClear()
    getPrStatusMock.mockResolvedValueOnce(makePrSnapshot({ ci: { rollup: 'SUCCESS', checks: [] }, readyToMerge: true }))
    await checkPrStatuses()
    expect(vi.mocked(wsSvc.emitEphemeral)).not.toHaveBeenCalledWith('ws-1', 'pr:ready-to-merge', expect.anything())
  })
})

describe('checkPrStatuses — auto-restore guards against purge leftovers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    vi.mocked(wsService.listWorkspaces).mockReturnValue([])
  })
  afterEach(() => {
    _resetForTest()
  })

  function makePurged() {
    return {
      ...makeWorkspace({ id: 'ws-purged', name: 'purged ws' }),
      archivedAt: '2026-06-08T00:00:00Z',
      worktreePurgedAt: '2026-06-08T00:00:00Z',
    }
  }

  it('does NOT restore an unrelated Git checkout at the recorded path', async () => {
    vi.mocked(wsService.listArchivedWorkspaces).mockReturnValue([makePurged() as never])
    vi.mocked(isMatchingWorkspaceWorktree).mockReturnValue(false)
    vi.mocked(gitOps.isGitWorktree).mockReturnValue(true) // A Git checkout alone is insufficient.

    await checkPrStatuses()

    expect(wsService.restoreWorktreeFromDisk).not.toHaveBeenCalled()
  })

  it('DOES restore when the worktree path is a valid git worktree (manual recreation)', async () => {
    const purged = makePurged()
    vi.mocked(wsService.listArchivedWorkspaces).mockReturnValue([purged as never])
    vi.mocked(isMatchingWorkspaceWorktree).mockReturnValue(true)
    vi.mocked(wsService.restoreWorktreeFromDisk).mockReturnValue(purged as never)

    await checkPrStatuses()

    expect(wsService.restoreWorktreeFromDisk).toHaveBeenCalledWith('ws-purged')
  })
})

describe('watcher restoration lifecycle races', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    vi.mocked(wsService.listArchivedWorkspaces).mockReturnValue([])
    vi.mocked(wsService.listWorkspaces).mockReturnValue([makeWorkspace()] as never)
    vi.mocked(wsService.getWorkspace).mockImplementation(
      (id) => [...wsService.listWorkspaces(), ...wsService.listArchivedWorkspaces()].find((ws) => ws.id === id) ?? null,
    )
    vi.mocked(wsService.archiveWorkspace).mockImplementation(
      (id) => ({ ...wsService.getWorkspace(id), archivedAt: '2026-09-09T01:00:00.000Z' }) as never,
    )
    vi.mocked(computeGitStats).mockResolvedValue({ commitCount: 3 } as never)
    getPrStatusMock.mockResolvedValue(makePrSnapshot())
  })

  it('skips both polling and manual restoration while a lifecycle operation is busy', async () => {
    vi.mocked(wsService.listArchivedWorkspaces).mockReturnValue([
      { ...makeWorkspace(), worktreePurgedAt: 'purged' },
    ] as never)
    vi.mocked(isMatchingWorkspaceWorktree).mockReturnValue(true)
    await withWorkspaceLifecycleGuard('ws-1', async () => {
      await checkPrStatuses()
      expect(wsService.restoreWorktreeFromDisk).not.toHaveBeenCalled()
      expect(getPrStatusMock).not.toHaveBeenCalled()
    })
  })

  it('does not recreate invalidated snapshots or archive after a restoration during the PR lookup', async () => {
    await checkPrStatuses()
    let finish!: (pr: ReturnType<typeof makePrSnapshot>) => void
    getPrStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = checkPrStatuses()
    invalidateWorkspacePrCaches('ws-1')
    finish(makePrSnapshot({ state: 'MERGED' }))
    await pending
    expect(getAllPrSnapshots()).toEqual({})
    expect(getAllGitStats()).toEqual({})
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('discards a manual refresh that completes after restoration', async () => {
    let finish!: (pr: ReturnType<typeof makePrSnapshot>) => void
    getPrStatusMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = refreshPrSnapshot('ws-1')
    invalidateWorkspacePrCaches('ws-1')
    finish(makePrSnapshot())
    await pending
    expect(getAllPrSnapshots()).toEqual({})
    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
  })

  it('does not rearchive after restoration while stopping a dev server', async () => {
    const dev = await import('../server/services/dev-server-service.js')
    await checkPrStatuses()
    let finish!: () => void
    let started!: () => void
    const stopping = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(dev.stopDevServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ status: 'stopped', instanceName: '', projectName: '', httpPort: '', url: '', containers: [] })
          started()
        }),
    )
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ state: 'MERGED' }))
    const pending = checkPrStatuses()
    await stopping
    invalidateWorkspacePrCaches('ws-1')
    finish()
    await pending
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('does not auto-purge a restored merged PR on later ticks or after cache reset', async () => {
    const purge = await import('../server/services/worktree-purge-service.js')
    const settings = await import('../server/services/settings-service.js')
    vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: true } as never)
    await checkPrStatuses()
    invalidateWorkspacePrCaches('ws-1')
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ state: 'MERGED' }))
    await checkPrStatuses()
    await checkPrStatuses()
    _resetForTest()
    await checkPrStatuses()
    expect(wsService.archiveWorkspace).not.toHaveBeenCalled()
    expect(purge.purgeWorktree).not.toHaveBeenCalled()
    vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: false } as never)
  })

  it('cancels delayed automatic purge when the archive timestamp changed during the merge hook', async () => {
    const hooks = await import('../server/services/lifecycle-hook-service.js')
    const settings = await import('../server/services/settings-service.js')
    const purge = await import('../server/services/worktree-purge-service.js')
    vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: true } as never)
    await checkPrStatuses()
    let finish!: () => void
    vi.mocked(hooks.onPrMerged).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    getPrStatusMock.mockResolvedValue(makePrSnapshot({ state: 'MERGED' }))
    let archived!: () => void
    const archiveReached = new Promise<void>((resolve) => {
      archived = resolve
    })
    vi.mocked(wsService.archiveWorkspace).mockImplementationOnce((id) => {
      archived()
      return { ...wsService.getWorkspace(id), archivedAt: '2026-09-09T01:00:00.000Z' } as never
    })
    const pending = checkPrStatuses()
    await archiveReached
    // The current row is unarchived again while the hook still runs.
    finish()
    await pending
    expect(purge.purgeWorktree).not.toHaveBeenCalled()
    vi.mocked(settings.getGlobalSettings).mockReturnValue({ autoPurgeOnPrMerged: false } as never)
  })
})
