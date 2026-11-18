import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import * as workspaces from '../server/services/workspace-service.js'
import { resetDb } from './helpers/reset-db.js'

vi.mock('../server/services/worktree-service.js', () => ({
  restoreWorktreeCheckoutUnlocked: vi.fn(async () => ({ source: 'local-branch', headCommitSha: 'a'.repeat(40) })),
  isMatchingWorkspaceWorktree: vi.fn(() => true),
}))
vi.mock('../server/utils/git-repo-lock.js', () => ({ withGitRepoLock: vi.fn(async (_path, action) => action()) }))
vi.mock('../server/services/pr-watcher-service.js', () => ({ invalidateWorkspacePrCaches: vi.fn() }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn(), broadcastAll: vi.fn() }))
vi.mock('../server/services/kept-ai-service.js', () => ({ putBackKeptAiFor: vi.fn(async () => [] as string[]) }))

import { putBackKeptAiFor } from '../server/services/kept-ai-service.js'
import { broadcastAll, emitEphemeral } from '../server/services/websocket-service.js'
import { restorePurgedWorktree } from '../server/services/worktree-restore-service.js'
import { isMatchingWorkspaceWorktree, restoreWorktreeCheckoutUnlocked } from '../server/services/worktree-service.js'
import { withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

let tmpDir: string
let id: string
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(putBackKeptAiFor).mockResolvedValue([])
  vi.mocked(isMatchingWorkspaceWorktree).mockResolvedValue(true)
  vi.mocked(restoreWorktreeCheckoutUnlocked).mockResolvedValue({
    source: 'local-branch',
    headCommitSha: 'a'.repeat(40),
  })
  ;({ tmpDir } = await resetDb())
  id = workspaces.createWorkspace({
    name: 'restore',
    projectPath: tmpDir,
    sourceBranch: 'main',
    workingBranch: 'feature/restore',
  }).id
  workspaces.createTask(id, { title: 'keep this task' })
  getDb()
    .prepare('UPDATE workspaces SET archived_at = ?, worktree_purged_at = ? WHERE id = ?')
    .run('2026-09-09', '2026-09-09', id)
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('restorePurgedWorktree', () => {
  it('restores old records without JSON and retains tasks and lifecycle status', async () => {
    const before = workspaces.getWorkspace(id)!
    const tasks = workspaces.listTasks(id)
    const result = await restorePurgedWorktree(id)
    expect(result.outcome).toBe('restored')
    expect(result.workspace).toMatchObject({
      id,
      worktreePurgedAt: null,
      archivedAt: null,
      status: before.status,
      worktreePath: before.worktreePath,
    })
    expect(workspaces.listTasks(id)).toEqual(tasks)
    expect(emitEphemeral).toHaveBeenCalledWith(id, 'workspace:worktree-restored', { workspace: result.workspace })
    expect((await restorePurgedWorktree(id)).outcome).toBe('already-restored')
    expect(restoreWorktreeCheckoutUnlocked).toHaveBeenCalledTimes(1)
  })

  it('retains purge metadata and does not announce success when Git fails', async () => {
    vi.mocked(restoreWorktreeCheckoutUnlocked).mockRejectedValueOnce(
      Object.assign(new Error('branch missing'), { code: 'recovery-source-unavailable' }),
    )
    await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'recovery-source-unavailable' })
    expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeTruthy()
    expect(emitEphemeral).not.toHaveBeenCalled()
  })

  it('does not finalize an invalid checkout', async () => {
    vi.mocked(isMatchingWorkspaceWorktree).mockResolvedValue(false)
    await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'path-conflict' })
    expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeTruthy()
  })

  it('leaves a completed checkout retryable when metadata finalization fails', async () => {
    vi.spyOn(workspaces, 'restoreWorktreeFromDisk').mockImplementationOnce(() => {
      throw new Error('database unavailable')
    })
    await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'git-failed' })
    expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeTruthy()
    expect(emitEphemeral).not.toHaveBeenCalled()
    await expect(restorePurgedWorktree(id)).resolves.toMatchObject({ outcome: 'restored' })
  })

  it.each(['{bad json', 'null', '42'])('ignores legacy malformed restore JSON %s', async (json) => {
    getDb().prepare('UPDATE workspaces SET worktree_purge_restore_data = ? WHERE id = ?').run(json, id)
    await expect(restorePurgedWorktree(id)).resolves.toMatchObject({ outcome: 'restored' })
  })

  it('rejects missing and unmanaged workspaces before touching Git', async () => {
    await expect(restorePurgedWorktree('missing')).rejects.toMatchObject({ code: 'not-found' })
    getDb().prepare('UPDATE workspaces SET worktree_owned = 0 WHERE id = ?').run(id)
    await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'worktree-not-owned' })
    expect(restoreWorktreeCheckoutUnlocked).not.toHaveBeenCalled()
  })

  describe('kept .ai folder', () => {
    it('puts it back after the checkout is verified and before the metadata is cleared, from the purged row', async () => {
      const order: string[] = []
      vi.mocked(isMatchingWorkspaceWorktree).mockImplementation(async () => {
        order.push('verify')
        return true
      })
      let seen: { worktreePurgedAt: string | null } | undefined
      vi.mocked(putBackKeptAiFor).mockImplementation(async (ws) => {
        order.push('put-back')
        seen = { worktreePurgedAt: ws.worktreePurgedAt }
        expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeTruthy()
        return []
      })
      const result = await restorePurgedWorktree(id)
      expect(order).toEqual(['verify', 'put-back'])
      expect(seen?.worktreePurgedAt).toBeTruthy()
      expect(vi.mocked(putBackKeptAiFor).mock.calls[0]![0]).toMatchObject({ id })
      expect(result.workspace.worktreePurgedAt).toBeNull()
    })

    it('returns its warnings', async () => {
      vi.mocked(putBackKeptAiFor).mockResolvedValue(['one file could not be placed'])
      await expect(restorePurgedWorktree(id)).resolves.toMatchObject({
        outcome: 'restored',
        warnings: ['one file could not be placed'],
      })
    })

    it('broadcasts the warnings globally after the restored event, and keeps them out of that event', async () => {
      vi.mocked(putBackKeptAiFor).mockResolvedValue(['one file could not be placed'])
      const order: string[] = []
      vi.mocked(emitEphemeral).mockImplementation(() => {
        order.push('restored')
      })
      vi.mocked(broadcastAll).mockImplementation(() => {
        order.push('warnings')
      })
      const result = await restorePurgedWorktree(id)
      expect(order).toEqual(['restored', 'warnings'])
      expect(emitEphemeral).toHaveBeenCalledWith(id, 'workspace:worktree-restored', { workspace: result.workspace })
      expect(vi.mocked(emitEphemeral).mock.calls[0]![2]).not.toHaveProperty('warnings')
      expect(broadcastAll).toHaveBeenCalledExactlyOnceWith('workspace:restore-warnings', {
        workspaceId: id,
        workspaceName: result.workspace.name,
        warnings: ['one file could not be placed'],
      })
    })

    it('does not broadcast without warnings', async () => {
      await restorePurgedWorktree(id)
      expect(broadcastAll).not.toHaveBeenCalled()
    })

    it('does not fail the restore when the broadcast throws', async () => {
      vi.mocked(putBackKeptAiFor).mockResolvedValue(['one file could not be placed'])
      vi.mocked(broadcastAll).mockImplementationOnce(() => {
        throw new Error('socket down')
      })
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(restorePurgedWorktree(id)).resolves.toMatchObject({
        outcome: 'restored',
        warnings: ['one file could not be placed'],
      })
      err.mockRestore()
    })

    it('returns an empty warnings list when nothing was reported', async () => {
      await expect(restorePurgedWorktree(id)).resolves.toMatchObject({ outcome: 'restored', warnings: [] })
    })

    it('does not call it for an already restored workspace and returns no warnings', async () => {
      getDb().prepare('UPDATE workspaces SET archived_at = NULL, worktree_purged_at = NULL WHERE id = ?').run(id)
      await expect(restorePurgedWorktree(id)).resolves.toMatchObject({ outcome: 'already-restored', warnings: [] })
      expect(putBackKeptAiFor).not.toHaveBeenCalled()
    })

    it('still rejects when the metadata update fails after a successful put-back, and a retry succeeds', async () => {
      vi.spyOn(workspaces, 'restoreWorktreeFromDisk').mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })
      await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'git-failed' })
      expect(putBackKeptAiFor).toHaveBeenCalledTimes(1)
      expect(workspaces.getWorkspace(id)!.worktreePurgedAt).toBeTruthy()
      await expect(restorePurgedWorktree(id)).resolves.toMatchObject({ outcome: 'restored' })
      expect(putBackKeptAiFor).toHaveBeenCalledTimes(2)
    })

    it('does not put it back when the recreated checkout is invalid', async () => {
      vi.mocked(isMatchingWorkspaceWorktree).mockResolvedValue(false)
      await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'path-conflict' })
      expect(putBackKeptAiFor).not.toHaveBeenCalled()
    })
  })

  it('rejects restoration during another lifecycle operation', async () => {
    await withWorkspaceLifecycleGuard(id, async () => {
      await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'workspace-busy' })
      expect(restoreWorktreeCheckoutUnlocked).not.toHaveBeenCalled()
    })
  })
})
