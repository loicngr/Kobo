import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock collaborators BEFORE importing the service.
vi.mock('../server/utils/git-ops.js', () => ({ getPrStatusAsync: vi.fn() }))
vi.mock('../server/services/dev-server-service.js', () => ({ stopDevServer: vi.fn() }))
vi.mock('../server/services/terminal-service.js', () => ({ destroyTerminal: vi.fn() }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))
vi.mock('../server/services/workspace-service.js', () => ({
  archiveWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspaceSourceBranch: vi.fn(),
}))

import { _resetForTest, checkPrStatuses } from '../server/services/pr-watcher-service.js'
import * as wsSvc from '../server/services/websocket-service.js'
import * as wsService from '../server/services/workspace-service.js'
import * as gitOps from '../server/utils/git-ops.js'

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
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'OPEN',
      url: 'https://github.com/x/y/pull/1',
      base: 'main',
    })

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
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'OPEN',
      url: 'https://github.com/x/y/pull/1',
      base: 'develop',
    })

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalled()
  })

  it('transition: lastKnownPr base differs from new PR base → emits + updates', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    // First check: silent populate (sourceBranch === base)
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'OPEN',
      url: 'https://github.com/x/y/pull/1',
      base: 'develop',
    })
    await checkPrStatuses()
    vi.clearAllMocks()
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    // Second check: base flipped to main
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'OPEN',
      url: 'https://github.com/x/y/pull/1',
      base: 'main',
    })

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
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'CLOSED',
      url: 'https://github.com/x/y/pull/1',
      base: 'main', // would have triggered if state were OPEN
    })

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalledWith('ws-1', 'pr:base-changed', expect.anything())
  })

  it('PR without base field (defensive) — no event, populates lastKnownPr', async () => {
    const ws = makeWorkspace({ sourceBranch: 'develop' })
    vi.mocked(wsService.listWorkspaces).mockReturnValue([ws as never])
    vi.mocked(gitOps.getPrStatusAsync).mockResolvedValue({
      state: 'OPEN',
      url: 'https://github.com/x/y/pull/1',
      // no base
    })

    await checkPrStatuses()

    expect(wsService.updateWorkspaceSourceBranch).not.toHaveBeenCalled()
    expect(wsSvc.emitEphemeral).not.toHaveBeenCalled()
  })
})
