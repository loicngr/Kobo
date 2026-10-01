import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/utils/git-ops.js', () => ({
  listBranchesAsync: vi.fn(),
  listRemoteBranchesAsync: vi.fn(),
  listWorktreeFilesAsync: vi.fn(),
}))

vi.mock('../server/services/worktree-service.js', () => ({
  listOrphanWorktrees: vi.fn(),
}))

const mockAll = vi.fn()
const mockPrepare = vi.fn(() => ({ all: mockAll }))

vi.mock('../server/db/index.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import router from '../server/routes/git.js'
import * as worktreeService from '../server/services/worktree-service.js'
import * as gitOps from '../server/utils/git-ops.js'

// ── App setup ────────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/git', router)

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockAll.mockReturnValue([])
  mockPrepare.mockReturnValue({ all: mockAll })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/git/branches', () => {
  it('returns local and remote branches for valid path', async () => {
    vi.mocked(gitOps.listBranchesAsync).mockResolvedValue(['main', 'develop', 'feature/test'])
    vi.mocked(gitOps.listRemoteBranchesAsync).mockResolvedValue(['origin/main', 'origin/develop'])

    const res = await app.request('/api/git/branches?path=/valid/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.local).toEqual(['main', 'develop', 'feature/test'])
    expect(data.remote).toEqual(['origin/main', 'origin/develop'])
    expect(gitOps.listBranchesAsync).toHaveBeenCalledWith('/valid/repo')
    expect(gitOps.listRemoteBranchesAsync).toHaveBeenCalledWith('/valid/repo')
  })

  it('returns 400 when path query parameter is missing', async () => {
    const res = await app.request('/api/git/branches')
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing required query parameter: path')
  })

  it('returns 500 when git operation fails', async () => {
    vi.mocked(gitOps.listBranchesAsync).mockImplementation(() => {
      throw new Error('Not a git repository')
    })

    const res = await app.request('/api/git/branches?path=/not/a/repo')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Not a git repository')
  })

  it('returns empty arrays for repo with no branches', async () => {
    vi.mocked(gitOps.listBranchesAsync).mockResolvedValue([])
    vi.mocked(gitOps.listRemoteBranchesAsync).mockResolvedValue([])

    const res = await app.request('/api/git/branches?path=/empty/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.local).toEqual([])
    expect(data.remote).toEqual([])
  })
})

describe('GET /api/git/files', () => {
  it('caps the listing at the server maximum when no limit is asked for', async () => {
    vi.mocked(gitOps.listWorktreeFilesAsync).mockResolvedValue(['a.ts', 'b.ts'])
    const res = await app.request('/api/git/files?path=/tmp/wt')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: ['a.ts', 'b.ts'] })
    expect(gitOps.listWorktreeFilesAsync).toHaveBeenCalledWith('/tmp/wt', 5000)
  })

  it('honours a smaller explicit limit', async () => {
    vi.mocked(gitOps.listWorktreeFilesAsync).mockResolvedValue([])
    await app.request('/api/git/files?path=/tmp/wt&limit=100')
    expect(gitOps.listWorktreeFilesAsync).toHaveBeenCalledWith('/tmp/wt', 100)
  })

  it('never lets a caller ask for more than the server maximum', async () => {
    vi.mocked(gitOps.listWorktreeFilesAsync).mockResolvedValue([])
    await app.request('/api/git/files?path=/tmp/wt&limit=999999')
    expect(gitOps.listWorktreeFilesAsync).toHaveBeenCalledWith('/tmp/wt', 5000)
  })

  it('falls back to the maximum on a nonsense limit', async () => {
    vi.mocked(gitOps.listWorktreeFilesAsync).mockResolvedValue([])
    await app.request('/api/git/files?path=/tmp/wt&limit=-3')
    expect(gitOps.listWorktreeFilesAsync).toHaveBeenCalledWith('/tmp/wt', 5000)
    await app.request('/api/git/files?path=/tmp/wt&limit=abc')
    expect(gitOps.listWorktreeFilesAsync).toHaveBeenLastCalledWith('/tmp/wt', 5000)
  })

  it('rejects a missing path', async () => {
    const res = await app.request('/api/git/files')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/git/orphan-worktrees', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when projectPath is missing', async () => {
    const res = await app.request('/api/git/orphan-worktrees')
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing required query parameter: projectPath')
  })

  it('returns the orphan worktrees of a project, excluding attached ones', async () => {
    mockAll.mockReturnValue([
      { worktree_path: '/repo/.worktrees/attached-a' },
      { worktree_path: '/repo/.worktrees/attached-b' },
      { worktree_path: null }, // legacy row without worktree_path — should be filtered out
    ])
    mockPrepare.mockReturnValue({ all: mockAll })

    const orphans = [
      {
        path: '/repo/.worktrees/orphan-1',
        branch: 'feature/orphan-1',
        head: 'abc123',
        suggestedSourceBranch: 'develop',
      },
      {
        path: '/repo/.worktrees/orphan-2',
        branch: 'feature/orphan-2',
        head: 'def456',
        suggestedSourceBranch: 'main',
      },
    ]
    vi.mocked(worktreeService.listOrphanWorktrees).mockResolvedValue(orphans)

    const res = await app.request('/api/git/orphan-worktrees?projectPath=/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(orphans)

    expect(mockPrepare).toHaveBeenCalledWith('SELECT worktree_path FROM workspaces WHERE project_path = ?')
    expect(mockAll).toHaveBeenCalledWith('/repo')

    expect(worktreeService.listOrphanWorktrees).toHaveBeenCalledWith(
      '/repo',
      new Set(['/repo/.worktrees/attached-a', '/repo/.worktrees/attached-b']),
    )
  })

  it('returns an empty array when there are no orphan worktrees', async () => {
    mockAll.mockReturnValue([])
    mockPrepare.mockReturnValue({ all: mockAll })
    vi.mocked(worktreeService.listOrphanWorktrees).mockResolvedValue([])

    const res = await app.request('/api/git/orphan-worktrees?projectPath=/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([])
  })

  it('returns 500 when worktree listing throws', async () => {
    mockAll.mockReturnValue([])
    mockPrepare.mockReturnValue({ all: mockAll })
    vi.mocked(worktreeService.listOrphanWorktrees).mockImplementation(() => {
      throw new Error('Not a git repository')
    })

    const res = await app.request('/api/git/orphan-worktrees?projectPath=/not/a/repo')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Not a git repository')
  })
})
