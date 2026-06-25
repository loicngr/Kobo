import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/utils/git-ops.js', () => ({
  getCommitCount: vi.fn(() => 3),
  getCommitsBehind: vi.fn(() => 1),
  getStructuredDiffStatsBetween: vi.fn(() => ({ filesChanged: 5, insertions: 40, deletions: 12 })),
  getUnpushedCountAsync: vi.fn(() => Promise.resolve(2)),
  getWorkingTreeStatus: vi.fn(() => ({ staged: 1, modified: 2, untracked: 0 })),
}))
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn(() => 'github') }))
vi.mock('../server/services/forge/registry.js', () => ({
  getForgeProvider: vi.fn(() => ({
    id: 'github',
    capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },
    isAvailable: vi.fn(() => Promise.resolve({ available: true })),
  })),
}))

import { computeGitStats } from '../server/services/git-stats-service.js'

const ws = { worktreePath: '/wt', sourceBranch: 'main', workingBranch: 'feat/x', projectPath: '/proj' }

describe('computeGitStats', () => {
  it('maps git ops + a PR snapshot into a GitStatsResult', async () => {
    const result = await computeGitStats(ws, { url: 'https://gh/pr/1', state: 'OPEN' })
    expect(result).toEqual({
      commitCount: 3,
      behindCount: 1,
      filesChanged: 5,
      insertions: 40,
      deletions: 12,
      prUrl: 'https://gh/pr/1',
      prState: 'OPEN',
      unpushedCount: 2,
      workingTree: { staged: 1, modified: 2, untracked: 0 },
      forge: {
        id: 'github',
        capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },
        availability: { available: true },
      },
      computedAt: expect.any(Number),
    })
  })

  it('uses null prUrl/prState when the PR snapshot is null', async () => {
    const result = await computeGitStats(ws, null)
    expect(result.prUrl).toBeNull()
    expect(result.prState).toBeNull()
  })
})
