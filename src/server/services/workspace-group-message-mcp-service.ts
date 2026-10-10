import { validateWorkspaceGroupMessageArguments } from '../../shared/workspace-group-message-tools.js'
import { MAX_GROUP_MESSAGE_RECIPIENTS, matchesGroupMessageFilters } from '../../shared/workspace-group-messages.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { GroupMessageError, getGroupMessageBatch, startGroupMessageBatch } from './workspace-group-message-service.js'
import { listWorkspaces } from './workspace-service.js'

export class WorkspaceGroupMessageMcpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export function executeWorkspaceGroupMessageTool(name: string, raw: unknown, source?: MessageSource): unknown {
  let input: Record<string, unknown>
  try {
    input = validateWorkspaceGroupMessageArguments(name, raw)
  } catch (error) {
    throw new WorkspaceGroupMessageMcpError(error instanceof Error ? error.message : 'Invalid arguments', 400)
  }
  if (name === 'preview_workspace_group_message') {
    const filters = {
      tags: input.tags as string[] | undefined,
      statuses: input.statuses as string[] | undefined,
      devServerRunning: input.dev_server_running as boolean | undefined,
    }
    const candidates = listWorkspaces()
      .filter(
        (workspace) =>
          !workspace.archivedAt && !workspace.worktreePurgedAt && matchesGroupMessageFilters(workspace, filters),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const offset = (input.offset as number | undefined) ?? 0
    const limit = (input.limit as number | undefined) ?? MAX_GROUP_MESSAGE_RECIPIENTS
    return {
      total: candidates.length,
      offset,
      limit,
      recipients: candidates.slice(offset, offset + limit).map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        tags: workspace.tags,
        status: workspace.status,
        delivery: workspace.autoLoop ? 'next_iteration' : 'immediate',
      })),
    }
  }
  if (name === 'get_workspace_group_message') {
    const batch = getGroupMessageBatch(input.request_id as string)
    if (!batch) throw new WorkspaceGroupMessageMcpError('Group message request not found', 404)
    return batch
  }
  try {
    return startGroupMessageBatch(
      { requestId: input.request_id, workspaceIds: input.workspace_ids, content: input.content },
      source,
    )
  } catch (error) {
    if (error instanceof GroupMessageError) throw new WorkspaceGroupMessageMcpError(error.message, error.status)
    throw error
  }
}
