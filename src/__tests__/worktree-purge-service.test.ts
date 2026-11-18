// The two irreversible operations of the product had no test at all. This one
// covers worktree purge: an operation that deletes a directory from disk and
// flips a flag driving the "restore" UX and the PR watcher's auto-restore probe.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logWarnMock = vi.hoisted(() => vi.fn())
vi.mock('../server/utils/logger.js', async () => ({
  ...(await vi.importActual<typeof import('../server/utils/logger.js')>('../server/utils/logger.js')),
  logWarn: logWarnMock,
}))

const existsSyncMock = vi.fn((_path: string) => true)
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
const stopAgentAndWaitMock = vi.fn(async (_workspaceId: string): Promise<string> => 'stopped')
vi.mock('../server/services/agent/orchestrator.js', () => ({
  stopAgentAndWait: (id: string) => stopAgentAndWaitMock(id),
}))
const stopDevServerMock = vi.fn(async (_workspaceId: string) => {})
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
const isMatchingWorkspaceWorktreeMock = vi.fn(async (_input: unknown): Promise<boolean> => true)
vi.mock('../server/services/worktree-service.js', () => ({
  isMatchingWorkspaceWorktree: (input: unknown) => isMatchingWorkspaceWorktreeMock(input),
  removeWorktree: (projectPath: string, worktreePath: string) => removeWorktreeMock(projectPath, worktreePath),
  isPermissionError: (message: string) => /EACCES|EPERM|permission denied/i.test(message),
}))

const keepAiFolderMock = vi.fn(async (_workspace: unknown): Promise<string | null> => null)
const putBackKeptRootMock = vi.fn(async (_keptRoot: string, _worktreePath: string): Promise<string | null> => null)
const computeKeptRootMock = vi.fn((_workspace: unknown) => '/kept/ws-1')
// Stand-in for the real helper (tested in kept-ai-service.test.ts): the computed root when it is a real directory.
const computedKeptRootIfExistsMock = vi.fn((w: unknown): string | null => {
  try {
    const target = computeKeptRootMock(w)
    const stat = lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink() ? target : null
  } catch {
    return null
  }
})
vi.mock('../server/services/kept-ai-service.js', () => ({
  keepAiFolder: (w: unknown) => keepAiFolderMock(w),
  putBackKeptRoot: (k: string, w: string) => putBackKeptRootMock(k, w),
  computedKeptRootIfExists: (w: unknown) => computedKeptRootIfExistsMock(w),
}))
let keepAiFolderOnPurge = true
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ keepAiFolderOnPurge }),
}))

import { purgeWorktree } from '../server/services/worktree-purge-service.js'
import { withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

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
  keepAiFolderOnPurge = true
  computeKeptRootMock.mockReturnValue('/kept/ws-1')
  keepAiFolderMock.mockResolvedValue(null)
  putBackKeptRootMock.mockResolvedValue(null)
  isMatchingWorkspaceWorktreeMock.mockResolvedValue(true)
  getPrStatusMock.mockResolvedValue({ number: 42, url: 'https://example.test/pr/42' })
})

describe('purgeWorktree()', () => {
  it('retains the worktree and database state when terminal exit is unconfirmed', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    destroyTerminalMock.mockRejectedValueOnce(new Error('Terminal exit unconfirmed'))
    await expect(purgeWorktree('ws-1')).rejects.toThrow('Terminal exit unconfirmed')
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(archiveWorkspaceMock).not.toHaveBeenCalled()
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'failed'])('refuses removal when agent stop returns %s', async (outcome) => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    stopAgentAndWaitMock.mockResolvedValueOnce(outcome)
    await expect(purgeWorktree('ws-1')).rejects.toThrow(/stop/i)
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
    expect(archiveWorkspaceMock).not.toHaveBeenCalled()
  })

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
      headCommitSha: null,
      originalWorktreePath: '/tmp/project/.worktrees/ws-1',
      originalSourceBranch: 'develop',
      originalWorkingBranch: 'feature/x',
    })
    expect(emitEphemeralMock).toHaveBeenCalledWith('ws-1', 'workspace:worktree-purged', expect.anything())
  })

  it('fails explicitly, without announcing a purge, when the metadata update fails after removal', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)
    markWorktreePurgedMock.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    await expect(purgeWorktree('ws-1')).rejects.toThrow(/removed from disk.*database is locked/s)
    expect(emitEphemeralMock).not.toHaveBeenCalledWith('ws-1', 'workspace:worktree-purged', expect.anything())
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

describe('purge restore metadata and stale automatic requests', () => {
  it('captures the actual HEAD before removal', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'kobo-purge-head-'))
    try {
      execFileSync('git', ['init', '-q', repo])
      execFileSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'saved work'],
        { cwd: repo },
      )
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
      getWorkspaceMock.mockReturnValue(makeWorkspace({ projectPath: repo, worktreePath: repo }))
      removeWorktreeMock.mockImplementation(async () => {})
      existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)
      await purgeWorktree('ws-1')
      expect(markWorktreePurgedMock).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ headCommitSha: head, mergeCommitSha: null }),
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('cancels stale automatic purge before stopping processes', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    await expect(purgeWorktree('ws-1', '2026-09-09T00:00:00.000Z')).resolves.toEqual({
      outcome: 'cancelled',
      warnings: [],
    })
    expect(stopAgentAndWaitMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })
})

describe('purge lifecycle exclusion', () => {
  it('rejects a purge while restoration owns the workspace', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    await withWorkspaceLifecycleGuard('ws-1', async () => {
      await expect(purgeWorktree('ws-1')).rejects.toMatchObject({ code: 'workspace-busy' })
      expect(stopAgentAndWaitMock).not.toHaveBeenCalled()
      expect(removeWorktreeMock).not.toHaveBeenCalled()
    })
  })

  it('holds the guard throughout stopping the agent and releases it after removal', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)
    removeWorktreeMock.mockResolvedValue(undefined)
    let release!: () => void
    stopAgentAndWaitMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('stopped')
        }),
    )
    const pending = purgeWorktree('ws-1')
    await expect(withWorkspaceLifecycleGuard('ws-1', async () => {})).rejects.toMatchObject({ code: 'workspace-busy' })
    release()
    await pending
    await expect(withWorkspaceLifecycleGuard('ws-1', async () => 'free')).resolves.toBe('free')
  })
})

describe('keeping the .ai folder', () => {
  const worktree = '/tmp/project/.worktrees/ws-1'

  it('keeps .ai after the archive and before the removal, and records the kept root', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    const order: string[] = []
    destroyTerminalMock.mockImplementationOnce(() => order.push('stops'))
    getPrStatusMock.mockImplementationOnce(async () => {
      order.push('capture')
      return { number: 42, url: 'https://example.test/pr/42' }
    })
    archiveWorkspaceMock.mockImplementationOnce((id: string) => {
      order.push('archive')
      return { id, archivedAt: 'x' }
    })
    keepAiFolderMock.mockImplementationOnce(async () => {
      order.push('keep')
      return '/kept/ws-1'
    })
    removeWorktreeMock.mockImplementationOnce(() => order.push('remove'))
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    const result = await purgeWorktree('ws-1')

    expect(order).toEqual(['stops', 'capture', 'archive', 'keep', 'remove'])
    expect(result.outcome).toBe('purged')
    expect(markWorktreePurgedMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ keptAiPath: '/kept/ws-1' }))
  })

  it('does not keep anything when the setting is off, and records no kept root', async () => {
    keepAiFolderOnPurge = false
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation((p) => (p === worktree ? removeWorktreeMock.mock.calls.length === 0 : false))

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('purged')
    expect(keepAiFolderMock).not.toHaveBeenCalled()
    expect(markWorktreePurgedMock.mock.calls[0][1]).not.toHaveProperty('keptAiPath')
  })

  it('records a leftover kept root when the setting is off', async () => {
    const leftover = mkdtempSync(path.join(tmpdir(), 'kobo-purge-leftover-'))
    try {
      keepAiFolderOnPurge = false
      computeKeptRootMock.mockReturnValue(leftover)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      existsSyncMock.mockImplementation((p) => (p === worktree ? removeWorktreeMock.mock.calls.length === 0 : true))

      await purgeWorktree('ws-1')

      expect(keepAiFolderMock).not.toHaveBeenCalled()
      expect(markWorktreePurgedMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ keptAiPath: leftover }))
    } finally {
      rmSync(leftover, { recursive: true, force: true })
    }
  })

  it('leaves the worktree in place and reports keep-failed when keeping fails', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('keep-failed')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(worktree)
    expect(result.warnings[0]).toContain('EACCES: permission denied')
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
    expect(emitEphemeralMock).toHaveBeenCalledWith('ws-1', 'workspace:worktree-purge-failed', {
      workspaceId: 'ws-1',
      warnings: result.warnings,
    })
  })

  it('puts .ai back when the removal leaves the folder behind', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce('/kept/ws-1')
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('removal-failed')
    expect(putBackKeptRootMock).toHaveBeenCalledWith('/kept/ws-1', worktree)
    expect(result.warnings.join('\n')).not.toContain('still in')
  })

  it('after a successful put-back into an intact checkout, tells the operator not to delete the folder', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce('/kept/ws-1')
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = await purgeWorktree('ws-1')

    const note = `The .ai folder was put back into '${worktree}'. Do not delete that folder by hand: purge again instead, so the notes are kept.`
    expect(result.outcome).toBe('removal-failed')
    expect(result.warnings).toContain(note)
    const removalIndex = result.warnings.findIndex((w) => w.startsWith('Failed to remove worktree'))
    expect(removalIndex).toBeGreaterThanOrEqual(0)
    expect(result.warnings.indexOf(note)).toBeGreaterThan(removalIndex)
    expect(result.warnings.join('\n')).not.toContain('was kept in')
  })

  it('adds only the put-back warning when the put-back into an intact checkout fails or is partial', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValue('/kept/ws-1')
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('boom')
    })
    putBackKeptRootMock.mockResolvedValueOnce('PUT-BACK WARNING')

    const result = await purgeWorktree('ws-1')

    expect(result.warnings).toContain('PUT-BACK WARNING')
    expect(result.warnings.join('\n')).not.toContain('Do not delete that folder by hand')
  })

  it('reports the warning of a failed or partial put-back', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValue('/kept/ws-1')
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('boom')
    })
    putBackKeptRootMock.mockResolvedValueOnce('PUT-BACK WARNING')
    const result = await purgeWorktree('ws-1')
    expect(result.outcome).toBe('removal-failed')
    expect(result.warnings).toContain('PUT-BACK WARNING')
  })

  it('leaves .ai in the kept root when the removal failed and the checkout is no longer a registered worktree', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce('/kept/ws-1')
    isMatchingWorkspaceWorktreeMock.mockResolvedValue(false)
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('removal-failed')
    expect(putBackKeptRootMock).not.toHaveBeenCalled()
    expect(isMatchingWorkspaceWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/tmp/project', worktreePath: worktree, workingBranch: 'feature/x' }),
    )
    expect(result.warnings).toContain(
      "The .ai folder was kept in '/kept/ws-1'. It will be recorded when you purge again after cleaning the folder up.",
    )
    expect(markWorktreePurgedMock).not.toHaveBeenCalled()
    expect(result.warnings.join('\n')).not.toContain('Do not delete that folder by hand')
  })

  it('treats a throwing checkout check as not a valid checkout', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce('/kept/ws-1')
    isMatchingWorkspaceWorktreeMock.mockRejectedValue(new Error('git exploded'))
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('boom')
    })

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('removal-failed')
    expect(putBackKeptRootMock).not.toHaveBeenCalled()
    expect(result.warnings.join('\n')).toContain("The .ai folder was kept in '/kept/ws-1'")
  })

  it('records the kept root when the second purge finds the cleaned-up folder gone', async () => {
    const kept = mkdtempSync(path.join(tmpdir(), 'kobo-purge-seq-'))
    try {
      mkdirSync(path.join(kept, '.ai'))
      computeKeptRootMock.mockReturnValue(kept)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      keepAiFolderMock.mockResolvedValueOnce(kept)
      isMatchingWorkspaceWorktreeMock.mockResolvedValue(false)
      removeWorktreeMock.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied')
      })

      const first = await purgeWorktree('ws-1')
      expect(first.outcome).toBe('removal-failed')
      expect(markWorktreePurgedMock).not.toHaveBeenCalled()

      existsSyncMock.mockImplementation((p) => p !== worktree) // the operator deleted the folder
      const second = await purgeWorktree('ws-1')
      expect(second.outcome).toBe('purged')
      expect(markWorktreePurgedMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ keptAiPath: kept }))
      expect(lstatSync(path.join(kept, '.ai')).isDirectory()).toBe(true)
    } finally {
      rmSync(kept, { recursive: true, force: true })
    }
  })

  it('records the kept root on a retry when the worktree is already gone', async () => {
    const kept = mkdtempSync(path.join(tmpdir(), 'kobo-purge-retry-'))
    try {
      mkdirSync(path.join(kept, '.ai'))
      computeKeptRootMock.mockReturnValue(kept)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      existsSyncMock.mockImplementation((p) => p !== worktree)

      const result = await purgeWorktree('ws-1')

      expect(result.outcome).toBe('purged')
      expect(removeWorktreeMock).not.toHaveBeenCalled()
      expect(keepAiFolderMock).not.toHaveBeenCalled()
      expect(markWorktreePurgedMock).toHaveBeenCalledWith('ws-1', expect.objectContaining({ keptAiPath: kept }))
    } finally {
      rmSync(kept, { recursive: true, force: true })
    }
  })

  it('records nothing when there was no .ai folder to keep', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce(null)
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('purged')
    expect(markWorktreePurgedMock.mock.calls[0][1]).not.toHaveProperty('keptAiPath')
  })
  it('puts a leftover kept root back when the setting is off and the removal fails', async () => {
    const leftover = mkdtempSync(path.join(tmpdir(), 'kobo-purge-leftover-'))
    try {
      keepAiFolderOnPurge = false
      computeKeptRootMock.mockReturnValue(leftover)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      removeWorktreeMock.mockImplementation(() => {
        throw new Error('boom')
      })

      const result = await purgeWorktree('ws-1')

      expect(result.outcome).toBe('removal-failed')
      expect(keepAiFolderMock).not.toHaveBeenCalled()
      expect(putBackKeptRootMock).toHaveBeenCalledWith(leftover, worktree)
    } finally {
      rmSync(leftover, { recursive: true, force: true })
    }
  })

  it('puts back a root left by an earlier attempt when the setting is on and the removal fails', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockResolvedValueOnce('/kept/ws-1')
    removeWorktreeMock.mockImplementation(() => {
      throw new Error('boom')
    })

    await purgeWorktree('ws-1')

    expect(putBackKeptRootMock).toHaveBeenCalledWith('/kept/ws-1', worktree)
  })

  it('rethrows when the purge cannot be recorded after a keep, and the retry records the kept root', async () => {
    const kept = mkdtempSync(path.join(tmpdir(), 'kobo-purge-retry-'))
    try {
      computeKeptRootMock.mockReturnValue(kept)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      keepAiFolderMock.mockResolvedValueOnce(kept)
      existsSyncMock.mockImplementation((p) => (p === worktree ? removeWorktreeMock.mock.calls.length === 0 : true))
      markWorktreePurgedMock.mockImplementationOnce(() => {
        throw new Error('database is locked')
      })

      await expect(purgeWorktree('ws-1')).rejects.toThrow(/removed from disk.*database is locked/s)

      existsSyncMock.mockImplementation((p) => p !== worktree)
      const retry = await purgeWorktree('ws-1')
      expect(retry.outcome).toBe('purged')
      expect(markWorktreePurgedMock).toHaveBeenLastCalledWith('ws-1', expect.objectContaining({ keptAiPath: kept }))
    } finally {
      rmSync(kept, { recursive: true, force: true })
    }
  })

  it('tries to put a partly moved .ai back when keeping fails, and stays keep-failed', async () => {
    const partial = mkdtempSync(path.join(tmpdir(), 'kobo-purge-partial-'))
    try {
      computeKeptRootMock.mockReturnValue(partial)
      getWorkspaceMock.mockReturnValue(makeWorkspace())
      keepAiFolderMock.mockRejectedValueOnce(new Error('EXDEV'))

      const ok = await purgeWorktree('ws-1')
      expect(ok.outcome).toBe('keep-failed')
      expect(putBackKeptRootMock).toHaveBeenCalledWith(partial, worktree)
      expect(ok.warnings).toHaveLength(1)

      keepAiFolderMock.mockRejectedValueOnce(new Error('EXDEV'))
      putBackKeptRootMock.mockResolvedValueOnce('PUT-BACK WARNING')
      const bad = await purgeWorktree('ws-1')
      expect(bad.outcome).toBe('keep-failed')
      expect(bad.warnings).toContain('PUT-BACK WARNING')
    } finally {
      rmSync(partial, { recursive: true, force: true })
    }
  })

  it('does not mask the keep failure when computeKeptRoot throws', async () => {
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    keepAiFolderMock.mockRejectedValueOnce(new Error('EXDEV'))
    computeKeptRootMock.mockImplementation(() => {
      throw new Error('Cannot resolve a kept folder')
    })

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('keep-failed')
    expect(result.warnings[0]).toContain('EXDEV')
    expect(putBackKeptRootMock).not.toHaveBeenCalled()
  })

  it('still purges, without a kept root, when computeKeptRoot throws and the setting is off', async () => {
    keepAiFolderOnPurge = false
    computeKeptRootMock.mockImplementation(() => {
      throw new Error('Cannot resolve a kept folder')
    })
    getWorkspaceMock.mockReturnValue(makeWorkspace())
    existsSyncMock.mockImplementation(() => removeWorktreeMock.mock.calls.length === 0)

    const result = await purgeWorktree('ws-1')

    expect(result.outcome).toBe('purged')
    expect(markWorktreePurgedMock.mock.calls[0][1]).not.toHaveProperty('keptAiPath')
  })
})
