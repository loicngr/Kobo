// The two irreversible operations of the product had no test at all. This one
// covers worktree purge: an operation that deletes a directory from disk and
// flips a flag driving the "restore" UX and the PR watcher's auto-restore probe.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const existsSyncMock = vi.fn(() => true)
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
    default: { ...actual, existsSync: (p: string) => existsSyncMock(p) },
  }
})

// The real service calls `agentManager.stopAgentAndWait` (not `stopAgent`) so
// that `removeWorktree`, which runs later in the same function, never races a
// still-dying agent process.
const stopAgentAndWaitMock = vi.fn(async () => {})
vi.mock('../server/services/agent/orchestrator.js', () => ({
  stopAgentAndWait: (id: string) => stopAgentAndWaitMock(id),
}))
const stopDevServerMock = vi.fn(async () => {})
vi.mock('../server/services/dev-server-service.js', () => ({ stopDevServer: (id: string) => stopDevServerMock(id) }))
const destroyTerminalMock = vi.fn()
vi.mock('../server/services/terminal-service.js', () => ({ destroyTerminal: (id: string) => destroyTerminalMock(id) }))

const getPrStatusMock = vi.fn(async () => ({ number: 42, url: 'https://example.test/pr/42' }))
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn(() => 'github') }))
vi.mock('../server/services/forge/registry.js', () => ({
  getForgeProvider: vi.fn(() => ({ id: 'github', getPrStatus: getPrStatusMock })),
}))

const emitEphemeralMock = vi.fn()
vi.mock('../server/services/websocket-service.js', () => ({
  emitEphemeral: (id: string, type: string, payload: unknown) => emitEphemeralMock(id, type, payload),
}))

const getWorkspaceMock = vi.fn()
const archiveWorkspaceMock = vi.fn((id: string) => ({ id, archivedAt: '2026-08-29T00:00:00.000Z' }))
const markWorktreePurgedMock = vi.fn()
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: (id: string) => getWorkspaceMock(id),
  archiveWorkspace: (id: string) => archiveWorkspaceMock(id),
  markWorktreePurged: (id: string, data: unknown) => markWorktreePurgedMock(id, data),
}))

const removeWorktreeMock = vi.fn()
vi.mock('../server/services/worktree-service.js', () => ({
  removeWorktree: (projectPath: string, worktreePath: string) => removeWorktreeMock(projectPath, worktreePath),
  isPermissionError: (message: string) => /EACCES|EPERM|permission denied/i.test(message),
}))

import { purgeWorktree } from '../server/services/worktree-purge-service.js'

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'my workspace',
    projectPath: '/tmp/project',
    worktreePath: '/tmp/project/.worktrees/ws-1',
    workingBranch: 'feature/x',
    sourceBranch: 'develop',
    worktreeOwned: true,
    worktreePurgedAt: null,
    archivedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  existsSyncMock.mockReturnValue(true)
  getPrStatusMock.mockResolvedValue({ number: 42, url: 'https://example.test/pr/42' })
})

describe('purgeWorktree()', () => {
  it('reports not-found for an unknown workspace, touching nothing', async () => {
    getWorkspaceMock.mockReturnValue(undefined)
    await expect(purgeWorktree('nope')).resolves.toEqual({ outcome: 'not-found', warnings: [] })
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
  })

  it('is idempotent on an already purged workspace', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace({ worktreePurgedAt: '2026-08-01T00:00:00.000Z' }))
    await expect(purgeWorktree('ws-1')).resolves.toEqual({ outcome: 'already-purged', warnings: [] })
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses to delete a worktree Kōbō did not create', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace({ worktreeOwned: false }))
    await expect(purgeWorktree('ws-1')).resolves.toEqual({ outcome: 'worktree-not-owned', warnings: [] })
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('stops the agent, the dev server and the terminal before removing anything', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('purged')
    expect(stopAgentAndWaitMock).toHaveBeenCalledWith('ws-1')
    expect(stopDevServerMock).toHaveBeenCalledWith('ws-1')
    expect(destroyTerminalMock).toHaveBeenCalledWith('ws-1')
    expect(removeWorktreeMock).toHaveBeenCalledWith('/tmp/project', '/tmp/project/.worktrees/ws-1')
  })

  it('archives, marks purged and captures the PR snapshot on the happy path', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    const result = await purgeWorktree('ws-1')

    expect(result).toEqual({ outcome: 'purged', warnings: [] })
    expect(archiveWorkspaceMock).toHaveBeenCalledWith('ws-1')
    expect(markWorktreePurgedMock).toHaveBeenCalledWith('ws-1', {
      prNumber: 42,
      prUrl: 'https://example.test/pr/42',
      forge: 'github',
      mergeCommitSha: null,
      originalWorktreePath: '/tmp/project/.worktrees/ws-1',
      originalSourceBranch: 'develop',
      originalWorkingBranch: 'feature/x',
    })
    expect(emitEphemeralMock).toHaveBeenCalledWith('ws-1', 'workspace:worktree-purged', expect.anything())
  })

  it('never marks purged when the directory survived the removal', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    removeWorktreeMock.mockImplementation(() => {
      throw new Error("Failed to remove worktree '/tmp/project/.worktrees/ws-1': EACCES: permission denied")
    })

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('removal-failed')
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
    expect(emitEphemeralMock).not.toHaveBeenCalledWith('ws-1', 'workspace:worktree-purged', expect.anything())
    expect(emitEphemeralMock).toHaveBeenCalledWith('ws-1', 'workspace:worktree-purge-failed', expect.anything())
  })

  it('hands the user a copy-pasteable recovery command on a permission failure', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = await purgeWorktree('ws-1')

    expect(result.warnings.join('\n')).toContain("sudo rm -rf '/tmp/project/.worktrees/ws-1'")
    expect(result.warnings.join('\n')).toContain('git worktree prune')
    expect(result.warnings.join('\n')).toContain('Permission denied')
  })

  it('still purges when the PR lookup fails — the snapshot is best-effort', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)
    getPrStatusMock.mockRejectedValue(new Error('gh: not authenticated'))

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('purged')
    expect(markWorktreePurgedMock).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ prNumber: null, prUrl: null }),
    )
  })

  it('does not re-archive a workspace that is already archived', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace({ archivedAt: '2026-08-01T00:00:00.000Z' }))
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    await purgeWorktree('ws-1')

    expect(archiveWorkspaceMock).not.toHaveBeenCalled()
  })
})
