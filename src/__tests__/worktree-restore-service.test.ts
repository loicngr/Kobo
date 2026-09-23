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
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))

import { emitEphemeral } from '../server/services/websocket-service.js'
import { restorePurgedWorktree } from '../server/services/worktree-restore-service.js'
import { isMatchingWorkspaceWorktree, restoreWorktreeCheckoutUnlocked } from '../server/services/worktree-service.js'
import { withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

let tmpDir: string
let id: string
beforeEach(async () => {
  vi.clearAllMocks()
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

  it('rejects restoration during another lifecycle operation', async () => {
    await withWorkspaceLifecycleGuard(id, async () => {
      await expect(restorePurgedWorktree(id)).rejects.toMatchObject({ code: 'workspace-busy' })
      expect(restoreWorktreeCheckoutUnlocked).not.toHaveBeenCalled()
    })
  })
})
