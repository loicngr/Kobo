import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/utils/git-ops.js', () => ({
  listBranches: vi.fn(),
  listRemoteBranches: vi.fn(),
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import router from '../server/routes/git.js'
import * as gitOps from '../server/utils/git-ops.js'

// ── App setup ────────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/git', router)

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/git/branches', () => {
  it('returns local and remote branches for valid path', async () => {
    vi.mocked(gitOps.listBranches).mockReturnValue(['main', 'develop', 'feature/test'])
    vi.mocked(gitOps.listRemoteBranches).mockReturnValue(['origin/main', 'origin/develop'])

    const res = await app.request('/api/git/branches?path=/valid/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.local).toEqual(['main', 'develop', 'feature/test'])
    expect(data.remote).toEqual(['origin/main', 'origin/develop'])
    expect(gitOps.listBranches).toHaveBeenCalledWith('/valid/repo')
    expect(gitOps.listRemoteBranches).toHaveBeenCalledWith('/valid/repo')
  })

  it('returns 400 when path query parameter is missing', async () => {
    const res = await app.request('/api/git/branches')
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Missing required query parameter: path')
  })

  it('returns 500 when git operation fails', async () => {
    vi.mocked(gitOps.listBranches).mockImplementation(() => {
      throw new Error('Not a git repository')
    })

    const res = await app.request('/api/git/branches?path=/not/a/repo')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Not a git repository')
  })

  it('returns empty arrays for repo with no branches', async () => {
    vi.mocked(gitOps.listBranches).mockReturnValue([])
    vi.mocked(gitOps.listRemoteBranches).mockReturnValue([])

    const res = await app.request('/api/git/branches?path=/empty/repo')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.local).toEqual([])
    expect(data.remote).toEqual([])
  })
})
