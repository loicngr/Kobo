import { validateWorkspaceLifecycleArguments } from '../../shared/workspace-lifecycle-tools.js'

type Dispatch = (path: string, init: RequestInit) => Promise<Response>

export class WorkspaceLifecycleMcpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: string,
    readonly details: unknown = null,
  ) {
    super(message)
    this.name = 'WorkspaceLifecycleMcpError'
  }
}

async function request(
  dispatch: Dispatch,
  path: string,
  stage: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await dispatch(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const payload = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok)
    throw new WorkspaceLifecycleMcpError(
      payload?.error ?? `Workspace lifecycle request failed (${response.status})`,
      response.status,
      stage,
      payload,
    )
  return payload
}

/** The HTTP lifecycle remains the sole owner of stopping, locks and cleanup. */
export async function executeWorkspaceLifecycleTool(name: string, raw: unknown, dispatch: Dispatch): Promise<unknown> {
  let input: Record<string, unknown>
  try {
    input = validateWorkspaceLifecycleArguments(name, raw)
  } catch (error) {
    throw new WorkspaceLifecycleMcpError(error instanceof Error ? error.message : 'Invalid arguments', 400, 'validate')
  }
  const workspaceId = input.workspace_id as string
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}`
  if (name === 'archive_workspace') return request(dispatch, `${path}/archive`, 'archive', 'POST')
  if (name === 'purge_workspace_worktree') return request(dispatch, `${path}/purge-worktree`, 'purge', 'POST')
  if (name === 'unarchive_workspace') return request(dispatch, `${path}/unarchive`, 'unarchive', 'POST')

  if (name === 'restore_workspace') {
    type WorkspaceState = { archivedAt?: string | null; worktreePurgedAt?: string | null; worktreeOwned?: boolean }
    let workspace = (await request(dispatch, path, 'lookup', 'GET')) as WorkspaceState
    if (!workspace.archivedAt && !workspace.worktreePurgedAt) return { workspace, outcome: 'unchanged' }
    let restoration: { workspace: WorkspaceState; outcome: string; source?: string } = {
      workspace,
      outcome: 'unarchived',
    }
    if (workspace.worktreePurgedAt || workspace.worktreeOwned !== false) {
      // Even without a purge flag, check an owned archived checkout on disk.
      // The existing restore endpoint rejects missing manual deletions rather
      // than silently announcing successful restoration of an absent folder.
      restoration = (await request(dispatch, `${path}/restore-worktree`, 'restore', 'POST')) as typeof restoration
      workspace = restoration.workspace
    }
    if (workspace.archivedAt)
      workspace = (await request(dispatch, `${path}/unarchive`, 'unarchive', 'POST')) as WorkspaceState
    return { ...restoration, workspace }
  }

  const workspace = (await request(dispatch, path, 'lookup', 'GET')) as { workingBranch?: unknown } | null
  const confirmationBranch = (input.confirmation_branch as string).trim()
  if (workspace?.workingBranch !== confirmationBranch)
    throw new WorkspaceLifecycleMcpError(
      'confirmation_branch must match the current workspace working branch',
      409,
      'confirm-delete',
    )
  const result = await request(dispatch, path, 'delete', 'DELETE', {
    deleteLocalBranch: input.delete_local_branch ?? false,
    deleteRemoteBranch: input.delete_remote_branch ?? false,
    // Rechecked by the existing route under its lifecycle guard, so a changed
    // branch between GET and DELETE cannot authorize a different deletion.
    confirmationBranch,
  })
  return result ?? { ok: true, workspaceId, warnings: [] }
}
