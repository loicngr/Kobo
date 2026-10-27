import { randomBytes } from 'node:crypto'
import { isProgressBarTool } from '../../shared/progress-bar-tools.js'
import { WORKSPACE_CREATION_TOOLS } from '../../shared/workspace-creation-tools.js'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import { WORKSPACE_GROUP_MESSAGE_TOOLS } from '../../shared/workspace-group-message-tools.js'
import { WORKSPACE_LIFECYCLE_TOOLS } from '../../shared/workspace-lifecycle-tools.js'

export interface InternalMcpCapability {
  token: string
  workspaceId: string
  sessionId: string
  readOnly: boolean
  env: Record<string, string | undefined>
}
const capabilities = new Map<string, InternalMcpCapability>()
const readTools = new Set([
  'list_tasks',
  'get_settings',
  'get_dev_server_status',
  'get_workspace_info',
  'cron_list',
  'get_dev_server_logs',
  'list_workspace_images',
  'get_ticket',
  'get_notion_ticket',
  'get_git_info',
  'list_documents',
  'read_document',
  'get_session_usage',
  'read_workspace_events_csv',
  'search_codebase',
  'list_workspaces',
  'list_memory_scopes',
  'list_memories',
  'read_memory',
  'search_memories',
  'list_memory_operations',
  ...EXTERNAL_MCP_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
  ...WORKSPACE_GROUP_MESSAGE_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
  ...WORKSPACE_CREATION_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
])
const writeTools = new Set([
  'mark_task_done',
  'mark_auto_loop_ready',
  'create_task',
  'update_task',
  'delete_task',
  'set_auto_loop',
  'set_workspace_agent_description',
  'set_workspace_name',
  'cron_create',
  'cron_delete',
  'start_dev_server',
  'stop_dev_server',
  'set_workspace_status',
  'log_thought',
  'schedule_wakeup',
  'cancel_wakeup',
  'stop_workspace',
  'remember',
  ...EXTERNAL_MCP_TOOLS.map((t) => t.name),
  ...WORKSPACE_CREATION_TOOLS.map((t) => t.name),
  ...WORKSPACE_LIFECYCLE_TOOLS.map((t) => t.name),
  ...WORKSPACE_GROUP_MESSAGE_TOOLS.map((t) => t.name),
])
const externalTools = new Set([
  ...EXTERNAL_MCP_TOOLS.map((t) => t.name),
  ...WORKSPACE_CREATION_TOOLS.map((t) => t.name),
  ...WORKSPACE_LIFECYCLE_TOOLS.filter((t) => t.name !== 'set_workspace_status').map((t) => t.name),
  ...WORKSPACE_GROUP_MESSAGE_TOOLS.map((t) => t.name),
  'stop_workspace',
])
export function createInternalMcpCapability(
  input: Omit<InternalMcpCapability, 'token' | 'env'> & { env?: Record<string, string | undefined> },
): InternalMcpCapability {
  const capability = { ...input, env: { ...input.env }, token: randomBytes(32).toString('base64url') }
  capabilities.set(capability.token, capability)
  return capability
}
export function revokeInternalMcpCapability(token: string): void {
  capabilities.delete(token)
}
export function resolveInternalMcpCapability(token: string | undefined): InternalMcpCapability {
  const capability = token ? capabilities.get(token) : undefined
  if (!capability) throw new Error('Invalid or revoked managed MCP capability')
  return capability
}
export function authorizeInternalMcpTool(
  token: string | undefined,
  name: string,
  args: Record<string, unknown>,
): InternalMcpCapability {
  const capability = resolveInternalMcpCapability(token)
  const report =
    (name === 'submit_final_review' &&
      capability.env.KOBO_FINAL_REVIEW_TOKEN &&
      capability.env.KOBO_FINAL_REVIEW_SESSION_ID === capability.sessionId) ||
    (name === 'submit_session_handoff' && capability.env.KOBO_HANDOFF_TOKEN && capability.env.KOBO_HANDOFF_ID)
  const progress = isProgressBarTool(name) && capability.env.KOBO_PROGRESS_SESSION_TOKEN
  if (!report && !progress && !readTools.has(name) && !writeTools.has(name))
    throw new Error(`Unknown or unavailable tool: ${name}`)
  if (capability.readOnly && !readTools.has(name) && !report && !progress)
    throw new Error('This managed MCP launch is read-only')
  if (!externalTools.has(name) && args.workspace_id !== undefined && args.workspace_id !== capability.workspaceId)
    throw new Error('Tool is bound to its launch workspace')
  if (
    (name === 'send_workspace_message' && args.workspace_id === capability.workspaceId) ||
    (name === 'send_workspace_group_message' &&
      Array.isArray(args.workspace_ids) &&
      args.workspace_ids.includes(capability.workspaceId))
  )
    throw new Error('Use the normal conversation in your own workspace')
  return capability
}
