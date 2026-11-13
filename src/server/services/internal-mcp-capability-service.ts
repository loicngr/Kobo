import { randomBytes } from 'node:crypto'
import { isProgressBarTool } from '../../shared/progress-bar-tools.js'
import { SLACK_TOOLS } from '../../shared/slack-tools.js'
import { MANAGED_SPRINT_TOOLS } from '../../shared/sprint-tools.js'
import { WORKSPACE_CREATION_TOOLS } from '../../shared/workspace-creation-tools.js'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import { WORKSPACE_GROUP_MESSAGE_TOOLS } from '../../shared/workspace-group-message-tools.js'
import { isWorkspaceTagTool, WORKSPACE_LIFECYCLE_TOOLS } from '../../shared/workspace-lifecycle-tools.js'
import { WORKSPACE_OBSERVATION_TOOLS } from '../../shared/workspace-observation-tools.js'
import { getGlobalSettings } from './settings-service.js'

export interface InternalMcpCapability {
  token: string
  workspaceId: string
  sessionId: string
  readOnly: boolean
  /** Review, parallel review, final review or handoff generation: stricter than Plan. */
  restricted: boolean
  env: Record<string, string | undefined>
}
const capabilities = new Map<string, InternalMcpCapability>()
const readTools = new Set([
  ...MANAGED_SPRINT_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
  ...WORKSPACE_OBSERVATION_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
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
  ...SLACK_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name),
])
const writeTools = new Set([
  ...MANAGED_SPRINT_TOOLS.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name),
  ...WORKSPACE_OBSERVATION_TOOLS.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name),
  'start_code_review',
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
  ...SLACK_TOOLS.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name),
])
const externalTools = new Set([
  ...EXTERNAL_MCP_TOOLS.map((t) => t.name),
  ...WORKSPACE_CREATION_TOOLS.map((t) => t.name),
  ...WORKSPACE_LIFECYCLE_TOOLS.filter(
    (t) => t.name !== 'set_workspace_status' && t.name !== 'run_setup_script' && !isWorkspaceTagTool(t.name),
  ).map((t) => t.name),
  ...WORKSPACE_GROUP_MESSAGE_TOOLS.map((t) => t.name),
  'stop_workspace',
])
/** Tools that create, destroy or restore Kōbō workspaces; gated by `agentWorkspaceLifecycleEnabled`. */
export const AGENT_WORKSPACE_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  'create_workspace',
  'delete_workspace',
  'archive_workspace',
  'unarchive_workspace',
  'purge_workspace_worktree',
  'restore_workspace',
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
/** True while a live launch of this session carries the review-only marker (revoked when it stops). */
export function hasReviewOnlyCapability(workspaceId: string, sessionId: string): boolean {
  for (const c of capabilities.values())
    if (c.workspaceId === workspaceId && c.sessionId === sessionId && c.env.KOBO_REVIEW_ONLY === '1') return true
  return false
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
  // Plan may answer its linked Slack channel; restricted launches never post.
  const planSlackPost = name === 'slack_post_message' && !capability.restricted
  if (!report && !progress && !readTools.has(name) && !writeTools.has(name))
    throw new Error(`Unknown or unavailable tool: ${name}`)
  if (
    (capability.readOnly && !readTools.has(name) && !report && !progress && !planSlackPost) ||
    (capability.restricted && name === 'slack_post_message')
  )
    throw new Error('This managed MCP launch is read-only')
  // Read per call so a settings change reaches running sessions; never widens the rules above.
  if (AGENT_WORKSPACE_LIFECYCLE_TOOLS.has(name) && getGlobalSettings().agentWorkspaceLifecycleEnabled !== true)
    throw new Error('Workspace lifecycle tools are disabled for agents. An operator can enable them in Settings.')
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
