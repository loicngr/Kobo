import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const workspaceId = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-]+$',
  description: 'Exact workspace ID from list_workspaces. The reserved bulk endpoint name archived is forbidden.',
}
const branch = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description:
    'Current exact working branch name, from get_workspace. Required for every deletion, like the UI confirmation.',
}

export const WORKSPACE_LIFECYCLE_TOOLS: Tool[] = [
  {
    name: 'archive_workspace',
    description:
      'Archive a Kōbō workspace using the same lifecycle as the UI. Stops its agent, development server and terminal, disables auto-loop, and hides the workspace while retaining its checkout and conversation history. May run the configured archive script.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: workspaceId },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'purge_workspace_worktree',
    description:
      'Free disk space by removing a Kōbō-owned workspace checkout, stopping its processes and archiving it, while preserving conversation history and workspace metadata. Uncommitted files in the checkout can be lost. External attached worktrees are protected. Set confirm_purge=true to explicitly request removal. Inspect the returned outcome and warnings; removal-failed is not success.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: workspaceId, confirm_purge: { type: 'boolean', const: true } },
      required: ['workspace_id', 'confirm_purge'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'delete_workspace',
    description:
      'Permanently delete one Kōbō workspace, its tasks and conversation history and its owned checkout, using the UI lifecycle. Stops processes first; external attached worktrees are preserved. Requires confirm_delete=true and confirmation_branch matching the current working branch. Local and remote branch deletion default to false and require explicit flags; remote deletion also requires delete_local_branch=true. Cleanup warnings are returned and must not be treated as complete cleanup. Never deletes all archived workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: workspaceId,
        confirm_delete: { type: 'boolean', const: true },
        confirmation_branch: branch,
        delete_local_branch: { type: 'boolean', default: false },
        delete_remote_branch: { type: 'boolean', default: false },
      },
      required: ['workspace_id', 'confirm_delete', 'confirmation_branch'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'unarchive_workspace',
    description:
      'Unarchive a Kōbō workspace whose checkout is still available, preserving its prior status and conversation history. Does not start agents or setup scripts. A purged checkout is refused: use restore_workspace first.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: workspaceId },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'restore_workspace',
    description:
      'Restore an archived workspace, recreating its Kōbō-owned checkout when marked purged, then unarchiving it. Uses saved Git recovery metadata, preserves history and never starts agents or setup scripts. An already active unpurged workspace is unchanged. Missing checkout without purge metadata is refused (not-purged); a workspace permanently deleted from the database cannot be restored. External worktrees are only unarchived, never recreated. Return includes workspace and outcome, plus checkout source when restoration was needed.',
    inputSchema: {
      type: 'object',
      properties: { workspace_id: workspaceId },
      required: ['workspace_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
]

export function isWorkspaceLifecycleTool(name: string): boolean {
  return WORKSPACE_LIFECYCLE_TOOLS.some((tool) => tool.name === name)
}

/** Reject ambiguous or bulk targets before any dispatch, including a read. */
export function validateWorkspaceLifecycleArguments(name: string, raw: unknown): Record<string, unknown> {
  const tool = WORKSPACE_LIFECYCLE_TOOLS.find((definition) => definition.name === name)
  if (!tool) throw new Error(`Unknown workspace lifecycle tool: ${name}`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tool arguments must be an object')
  const input = raw as Record<string, unknown>
  const properties = tool.inputSchema.properties as Record<
    string,
    { type: string; const?: boolean; maxLength?: number }
  >
  for (const required of tool.inputSchema.required ?? [])
    if (!Object.hasOwn(input, required)) throw new Error(`${required} is required`)
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown field: ${key}`)
    const definition = properties[key]!
    if (definition.type === 'boolean') {
      if (typeof value !== 'boolean' || (definition.const !== undefined && value !== definition.const))
        throw new Error(`${key} must be ${definition.const === true ? 'true' : 'a boolean'}`)
    } else if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > definition.maxLength! ||
      /[\0\r\n]/.test(value)
    )
      throw new Error(`Invalid ${key}`)
  }
  const id = input.workspace_id as string
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id === 'archived')
    throw new Error('Invalid workspace_id: use a single workspace ID, never a path or bulk endpoint')
  if (input.delete_remote_branch === true && input.delete_local_branch !== true)
    throw new Error('delete_remote_branch requires delete_local_branch=true')
  return input
}
