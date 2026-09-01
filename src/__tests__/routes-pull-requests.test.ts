import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn() }))
vi.mock('../server/services/forge/registry.js', () => ({ getForgeProvider: vi.fn() }))
vi.mock('../server/services/pr-checkout-service.js', () => ({
  diagnoseLocalState: vi.fn(),
  computeFingerprint: vi.fn(() => 'FP'),
  resolvePrCheckout: vi.fn(),
  StaleDiagnosisError: class extends Error {
    report = { stub: true }
  },
}))
vi.mock('../server/services/workspace-service.js', () => ({ listWorkspaces: vi.fn(() => []) }))

import app from '../server/routes/pull-requests.js'
import { getForgeProvider } from '../server/services/forge/registry.js'
import { resolveForge } from '../server/services/forge/resolve.js'
import * as prCheckout from '../server/services/pr-checkout-service.js'

beforeEach(() => vi.clearAllMocks())

describe('GET /', () => {
  it('returns the provider page', async () => {
    vi.mocked(resolveForge).mockReturnValue('github')
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: true },
      listPullRequests: vi.fn(async () => ({ items: [{ number: 1 }], nextCursor: 'C' })),
    } as never)
    const res = await app.request('/?projectPath=/repo&filter=all')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ number: 1 }], nextCursor: 'C' })
  })

  it('rejects a missing projectPath with 400', async () => {
    expect((await app.request('/')).status).toBe(400)
  })

  it('returns 403 when the forge cannot list', async () => {
    vi.mocked(resolveForge).mockReturnValue('none')
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: false },
      listPullRequests: vi.fn(),
    } as never)
    expect((await app.request('/?projectPath=/repo')).status).toBe(403)
  })

  it('forwards cursor, search, and perPage to the provider', async () => {
    vi.mocked(resolveForge).mockReturnValue('github')
    const listPullRequests = vi.fn(async () => ({ items: [], nextCursor: null }))
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: true },
      listPullRequests,
    } as never)
    await app.request('/?projectPath=/repo&filter=mine&search=login&cursor=abc&perPage=10')
    expect(listPullRequests).toHaveBeenCalledWith('/repo', {
      filter: 'mine',
      search: 'login',
      cursor: 'abc',
      perPage: 10,
    })
  })
})

describe('POST /diagnose', () => {
  it('adds a fork blocker rather than failing', async () => {
    vi.mocked(resolveForge).mockReturnValue('github')
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: true },
      isAvailable: vi.fn(async () => ({ available: true })),
      listPullRequests: vi.fn(async () => ({
        items: [{ number: 3, headBranch: 'x', baseBranch: 'main', isFork: true }],
        nextCursor: null,
      })),
    } as never)
    vi.mocked(prCheckout.diagnoseLocalState).mockReturnValue({ blockers: [] } as never)
    const res = await app.request('/diagnose', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/repo', prNumber: 3 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).report.blockers).toContainEqual({ kind: 'fork-pr' })
  })

  it('returns a minimal report when the forge is unavailable', async () => {
    vi.mocked(resolveForge).mockReturnValue('github')
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: true },
      isAvailable: vi.fn(async () => ({ available: false, reason: 'not_authenticated' })),
      listPullRequests: vi.fn(),
    } as never)
    const res = await app.request('/diagnose', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/repo', prNumber: 1 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.report.blockers).toContainEqual({ kind: 'forge-unavailable', reason: 'not_authenticated' })
    expect(body.pr).toBeNull()
    // diagnoseLocalState must NEVER be called on the fake-empty-branch path.
    expect(prCheckout.diagnoseLocalState).not.toHaveBeenCalled()
  })

  it('returns 404 when the forge is available but the PR is not found', async () => {
    vi.mocked(resolveForge).mockReturnValue('github')
    vi.mocked(getForgeProvider).mockReturnValue({
      capabilities: { canListPullRequests: true },
      isAvailable: vi.fn(async () => ({ available: true })),
      listPullRequests: vi.fn(async () => ({ items: [], nextCursor: null })),
    } as never)
    const res = await app.request('/diagnose', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/repo', prNumber: 99 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /resolve', () => {
  it('maps a stale diagnosis to 409', async () => {
    vi.mocked(prCheckout.resolvePrCheckout).mockRejectedValue(new (prCheckout.StaleDiagnosisError as never)('stale'))
    const res = await app.request('/resolve', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/repo', prNumber: 1, decisions: {}, fingerprint: 'OLD' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(409)
  })

  it('maps any other failure to 422', async () => {
    vi.mocked(prCheckout.resolvePrCheckout).mockRejectedValue(new Error('cherry-pick failed'))
    const res = await app.request('/resolve', {
      method: 'POST',
      body: JSON.stringify({ projectPath: '/repo', prNumber: 1, decisions: {}, fingerprint: 'FP' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(422)
  })

  it('returns the resolved worktree on success', async () => {
    vi.mocked(prCheckout.resolvePrCheckout).mockResolvedValue({
      worktreePath: '/repo/.worktrees/feat-x',
      workingBranch: 'feat/x',
      sourceBranch: 'main',
      applied: [],
    } as never)
    const res = await app.request('/resolve', {
      method: 'POST',
      body: JSON.stringify({
        projectPath: '/repo',
        prNumber: 1,
        headBranch: 'feat/x',
        baseBranch: 'main',
        decisions: {},
        fingerprint: 'FP',
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      worktreePath: '/repo/.worktrees/feat-x',
      workingBranch: 'feat/x',
      sourceBranch: 'main',
      applied: [],
    })
  })
})
