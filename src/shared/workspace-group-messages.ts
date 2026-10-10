/** One frozen, explicitly selected set of recipients. Filters are a client preview only. */
export interface GroupMessageInput {
  requestId: string
  workspaceIds: string[]
  content: string
}
export interface GroupMessageRecipient {
  workspaceId: string
  name: string
  delivery: 'immediate' | 'next_iteration'
  state: 'pending' | 'sending' | 'sent' | 'queued' | 'rejected' | 'unknown' | 'not_sent'
  error?: string
}
export interface GroupMessageBatch {
  id: string
  createdAt: string
  complete: boolean
  recipients: GroupMessageRecipient[]
}
export interface GroupMessageFilters {
  tags?: string[]
  statuses?: string[]
  devServerRunning?: boolean
}
export const MAX_GROUP_MESSAGE_RECIPIENTS = 200
export const MAX_GROUP_MESSAGE_LENGTH = 100_000
export const MAX_GROUP_MESSAGE_REQUEST_BYTES = 1024 * 1024
const identifier = /^[A-Za-z0-9_-]{1,200}$/

export function parseGroupMessageInput(value: unknown): GroupMessageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid group message')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['requestId', 'workspaceIds', 'content'].includes(key)))
    throw new Error('Unknown group message field')
  if (typeof input.requestId !== 'string' || !identifier.test(input.requestId)) throw new Error('Invalid requestId')
  if (
    !Array.isArray(input.workspaceIds) ||
    input.workspaceIds.length === 0 ||
    input.workspaceIds.length > MAX_GROUP_MESSAGE_RECIPIENTS ||
    input.workspaceIds.some((id) => typeof id !== 'string' || !identifier.test(id)) ||
    new Set(input.workspaceIds).size !== input.workspaceIds.length
  )
    throw new Error('Select 1 to 200 unique workspace IDs')
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > MAX_GROUP_MESSAGE_LENGTH)
    throw new Error('Message must contain 1 to 100000 characters')
  return { requestId: input.requestId, workspaceIds: [...input.workspaceIds], content: input.content }
}
export function matchesGroupMessageFilters(
  workspace: { tags: string[]; status: string; devServerStatus?: string },
  filters: GroupMessageFilters,
): boolean {
  return (
    (!filters.tags?.length || filters.tags.some((tag) => workspace.tags.includes(tag))) &&
    (!filters.statuses?.length || filters.statuses.includes(workspace.status)) &&
    (!filters.devServerRunning || workspace.devServerStatus === 'running')
  )
}
