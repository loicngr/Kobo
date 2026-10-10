import { describe, expect, it, vi } from 'vitest'
import { executeWorkspaceLifecycleTool } from '../server/services/workspace-lifecycle-mcp-service.js'
import { validateWorkspaceLifecycleArguments, WORKSPACE_LIFECYCLE_TOOLS } from '../shared/workspace-lifecycle-tools.js'

const workspaceId = 'my_workspace-123'
const deletion = { workspace_id: workspaceId, confirm_delete: true, confirmation_branch: 'feature/current' }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('MCP workspace lifecycle', () => {
  it('unarchives through the existing route without starting an agent', async () => {
    const payload = { id: workspaceId, archivedAt: null }
    const dispatch = vi.fn().mockResolvedValue(response(payload))
    expect(await executeWorkspaceLifecycleTool('unarchive_workspace', { workspace_id: workspaceId }, dispatch)).toEqual(
      payload,
    )
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(`/api/workspaces/${workspaceId}/unarchive`, { method: 'POST' })
  })
  it('restores the purged checkout before unarchiving and preserves restoration details', async () => {
    const archived = { id: workspaceId, archivedAt: '2026-10-10', worktreePurgedAt: '2026-10-10', worktreeOwned: true }
    const restored = { ...archived, worktreePurgedAt: null }
    const active = { ...restored, archivedAt: null }
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response(archived))
      .mockResolvedValueOnce(
        response({ workspace: restored, outcome: 'restored', source: 'saved-commit', warnings: ['Example warning'] }),
      )
      .mockResolvedValueOnce(response(active))
    expect(await executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch)).toEqual({
      workspace: active,
      outcome: 'restored',
      source: 'saved-commit',
      warnings: ['Example warning'],
    })
    expect(dispatch.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      [`/api/workspaces/${workspaceId}`, 'GET'],
      [`/api/workspaces/${workspaceId}/restore-worktree`, 'POST'],
      [`/api/workspaces/${workspaceId}/unarchive`, 'POST'],
    ])
  })
  it('checks an owned archived checkout even when it is not marked purged', async () => {
    const archived = { id: workspaceId, archivedAt: '2026-10-10', worktreePurgedAt: null, worktreeOwned: true }
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response(archived))
      .mockResolvedValueOnce(
        response({ workspace: archived, outcome: 'already-restored', source: 'existing-worktree' }),
      )
      .mockResolvedValueOnce(response({ ...archived, archivedAt: null }))
    expect(
      await executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch),
    ).toMatchObject({ outcome: 'already-restored', workspace: { archivedAt: null } })
    expect(dispatch.mock.calls[1]![0]).toBe(`/api/workspaces/${workspaceId}/restore-worktree`)
  })
  it.each(['recovery-source-unavailable', 'not-purged', 'path-conflict'])(
    'does not unarchive if restore refuses with %s',
    async (code) => {
      const dispatch = vi
        .fn()
        .mockResolvedValueOnce(response({ id: workspaceId, archivedAt: '2026-10-10', worktreeOwned: true }))
        .mockResolvedValueOnce(response({ error: 'Cannot restore', code }, 422))
      await expect(
        executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch),
      ).rejects.toMatchObject({ status: 422, stage: 'restore', details: { code } })
      expect(dispatch).toHaveBeenCalledTimes(2)
    },
  )
  it('returns unchanged for an already active unpurged workspace', async () => {
    const workspace = { id: workspaceId, archivedAt: null, worktreePurgedAt: null, worktreeOwned: true }
    const dispatch = vi.fn().mockResolvedValue(response(workspace))
    expect(await executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch)).toEqual({
      workspace,
      outcome: 'unchanged',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('unarchives an external checkout without trying to restore or modify it', async () => {
    const workspace = { id: workspaceId, archivedAt: '2026-10-10', worktreePurgedAt: null, worktreeOwned: false }
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(response({ ...workspace, archivedAt: null }))
    expect(
      await executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch),
    ).toMatchObject({ outcome: 'unarchived', workspace: { archivedAt: null } })
    expect(dispatch.mock.calls.map(([path]) => path)).toEqual([
      `/api/workspaces/${workspaceId}`,
      `/api/workspaces/${workspaceId}/unarchive`,
    ])
  })
  it('never recreates a workspace deleted from the database', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ error: 'Not found' }, 404))
    await expect(
      executeWorkspaceLifecycleTool('restore_workspace', { workspace_id: workspaceId }, dispatch),
    ).rejects.toMatchObject({ status: 404, stage: 'lookup' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('keeps the archive tool stable and routes through existing archive lifecycle', async () => {
    const archived = { id: workspaceId, archivedAt: '2026-10-10T12:00:00Z' }
    const dispatch = vi.fn().mockResolvedValue(response(archived))
    expect(await executeWorkspaceLifecycleTool('archive_workspace', { workspace_id: workspaceId }, dispatch)).toEqual(
      archived,
    )
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      `/api/workspaces/${workspaceId}/archive`,
      expect.objectContaining({ method: 'POST' }),
    )
  })
  it('preserves purge outcome and warnings without claiming disk removal succeeded', async () => {
    const payload = { workspace: { id: workspaceId }, outcome: 'removal-failed', warnings: ['Directory still exists'] }
    const dispatch = vi.fn().mockResolvedValue(response(payload))
    expect(
      await executeWorkspaceLifecycleTool(
        'purge_workspace_worktree',
        { workspace_id: workspaceId, confirm_purge: true },
        dispatch,
      ),
    ).toEqual(payload)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      `/api/workspaces/${workspaceId}/purge-worktree`,
      expect.objectContaining({ method: 'POST' }),
    )
  })
  it.each(['../archived', 'archived', 'id/../archived', 'id?x=1', 'id#x', 'id%2Fother', '', 'a\\b'])(
    'rejects unsafe workspace identifier %j before requests',
    async (workspace_id) => {
      const dispatch = vi.fn()
      await expect(
        executeWorkspaceLifecycleTool('delete_workspace', { ...deletion, workspace_id }, dispatch),
      ).rejects.toMatchObject({ status: 400, stage: 'validate' })
      expect(dispatch).not.toHaveBeenCalled()
    },
  )
  it.each([
    ['delete_workspace', { workspace_id: workspaceId, confirmation_branch: 'feature/current' }],
    ['delete_workspace', { ...deletion, confirm_delete: false }],
    ['delete_workspace', { ...deletion, confirmation_branch: '' }],
    ['delete_workspace', { ...deletion, delete_local_branch: 'true' }],
    ['delete_workspace', { ...deletion, delete_remote_branch: true }],
    ['purge_workspace_worktree', { workspace_id: workspaceId }],
    ['purge_workspace_worktree', { workspace_id: workspaceId, confirm_purge: false }],
    ['archive_workspace', { workspace_id: workspaceId, unexpected: true }],
  ])('rejects invalid or unconfirmed %s before requests', async (name, input) => {
    const dispatch = vi.fn()
    await expect(executeWorkspaceLifecycleTool(name as string, input, dispatch)).rejects.toMatchObject({
      status: 400,
      stage: 'validate',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('deletes with explicit false branch defaults and forwards branch confirmation to guarded endpoint', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response({ id: workspaceId, workingBranch: 'feature/current' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await executeWorkspaceLifecycleTool('delete_workspace', deletion, dispatch)).toMatchObject({
      ok: true,
      workspaceId,
      warnings: [],
    })
    expect(dispatch.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      [`/api/workspaces/${workspaceId}`, 'GET'],
      [`/api/workspaces/${workspaceId}`, 'DELETE'],
    ])
    expect(JSON.parse(dispatch.mock.calls[1]![1].body)).toEqual({
      deleteLocalBranch: false,
      deleteRemoteBranch: false,
      confirmationBranch: 'feature/current',
    })
  })
  it('refuses mismatched branch confirmation before destructive dispatch', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ id: workspaceId, workingBranch: 'feature/changed' }))
    await expect(executeWorkspaceLifecycleTool('delete_workspace', deletion, dispatch)).rejects.toMatchObject({
      status: 409,
      stage: 'confirm-delete',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('passes explicit branch deletion flags and retains cleanup warnings', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response({ id: workspaceId, workingBranch: 'feature/current' }))
      .mockResolvedValueOnce(response({ ok: true, warnings: ['Remote branch could not be removed'] }))
    expect(
      await executeWorkspaceLifecycleTool(
        'delete_workspace',
        { ...deletion, delete_local_branch: true, delete_remote_branch: true },
        dispatch,
      ),
    ).toMatchObject({ ok: true, warnings: ['Remote branch could not be removed'] })
    expect(JSON.parse(dispatch.mock.calls[1]![1].body)).toMatchObject({
      deleteLocalBranch: true,
      deleteRemoteBranch: true,
    })
  })
  it('preserves server refusal status and details from lifecycle guards', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ error: 'Busy', code: 'workspace-lifecycle-busy' }, 409))
    await expect(
      executeWorkspaceLifecycleTool(
        'purge_workspace_worktree',
        { workspace_id: workspaceId, confirm_purge: true },
        dispatch,
      ),
    ).rejects.toMatchObject({
      status: 409,
      stage: 'purge',
      details: { error: 'Busy', code: 'workspace-lifecycle-busy' },
    })
  })
  it('stops at a missing workspace without sending delete', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ error: 'Missing workspace' }, 404))
    await expect(executeWorkspaceLifecycleTool('delete_workspace', deletion, dispatch)).rejects.toMatchObject({
      status: 404,
      stage: 'lookup',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('publishes strict schemas for all lifecycle tools and rejects unknown names', () => {
    expect(WORKSPACE_LIFECYCLE_TOOLS.map(({ name }) => name)).toEqual([
      'archive_workspace',
      'purge_workspace_worktree',
      'delete_workspace',
      'unarchive_workspace',
      'restore_workspace',
    ])
    expect(WORKSPACE_LIFECYCLE_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true)
    expect(() => validateWorkspaceLifecycleArguments('delete_all_workspaces', {})).toThrow('Unknown')
  })
})
