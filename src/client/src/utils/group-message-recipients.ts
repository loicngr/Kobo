/** A workspace can receive a group message unless it is archived or its worktree was purged. */
export function canReceiveGroupMessage(workspace: { archivedAt?: string | null; worktreePurgedAt?: string | null }) {
  return !workspace.archivedAt && !workspace.worktreePurgedAt
}
