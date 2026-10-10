import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  MAX_GROUP_MESSAGE_LENGTH,
  MAX_GROUP_MESSAGE_RECIPIENTS,
  parseGroupMessageInput,
} from './workspace-group-messages.js'

const identifier = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,200}$', minLength: 1, maxLength: 200 }
const statuses = [
  'created',
  'extracting',
  'brainstorming',
  'executing',
  'compacting',
  'awaiting-user',
  'completed',
  'idle',
  'error',
  'quota',
]
export const WORKSPACE_GROUP_MESSAGE_TOOLS: Tool[] = [
  {
    name: 'preview_workspace_group_message',
    description:
      'Preview eligible non-archived, non-purged workspaces before sending a group message. Tags match ANY selected tag, statuses match ANY selected status, and all enabled filters intersect. Set dev_server_running to true to include only workspaces with a running development server. Empty filters select all eligible workspaces. Paginate with offset and limit (maximum 200); results sort by workspace ID. Delivery is immediate for manual workspaces and next_iteration for auto-loop. This is a live preview, not a reservation; explicitly select recipient IDs for send_workspace_group_message.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          maxItems: 200,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        statuses: {
          type: 'array',
          uniqueItems: true,
          maxItems: statuses.length,
          items: { type: 'string', enum: statuses },
        },
        dev_server_running: {
          type: 'boolean',
          default: false,
          description: 'Only include workspaces whose development server status is running. Intersects other filters.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_GROUP_MESSAGE_RECIPIENTS,
          default: MAX_GROUP_MESSAGE_RECIPIENTS,
        },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_workspace_group_message',
    description:
      'Send one message to an explicit selection of 1–200 unique workspace IDs after previewing recipients. A workspace-bound agent cannot target its own workspace. Supply a unique request_id; retrying the same ID and identical payload observes the existing batch without resending. Different payloads with that ID fail. Returns a durable asynchronous batch receipt: use get_workspace_group_message to inspect per-recipient outcomes. Manual workspaces receive immediately; auto-loop workspaces queue for their next iteration. Ineligible targets are rejected individually. After interruption, not_sent and unknown outcomes are never automatically retried; inspect history before submitting a new request.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: identifier,
        workspace_ids: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_GROUP_MESSAGE_RECIPIENTS,
          uniqueItems: true,
          items: identifier,
        },
        content: { type: 'string', minLength: 1, maxLength: MAX_GROUP_MESSAGE_LENGTH },
      },
      required: ['request_id', 'workspace_ids', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_workspace_group_message',
    description:
      'Read a persisted group-message receipt by request_id, including complete and each recipient state: pending, sending, sent, queued, rejected, unknown, or not_sent. This read never sends or retries messages. Queued means accepted for a future auto-loop iteration, not executed.',
    inputSchema: {
      type: 'object',
      properties: { request_id: identifier },
      required: ['request_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]
export function isWorkspaceGroupMessageTool(name: string): boolean {
  return WORKSPACE_GROUP_MESSAGE_TOOLS.some((tool) => tool.name === name)
}
export function validateWorkspaceGroupMessageArguments(name: string, raw: unknown): Record<string, unknown> {
  const tool = WORKSPACE_GROUP_MESSAGE_TOOLS.find((item) => item.name === name)
  if (!tool) throw new Error(`Unknown group message tool: ${name}`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Arguments must be an object')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input))
    if (!Object.hasOwn(tool.inputSchema.properties!, key)) throw new Error(`Unknown field: ${key}`)
  for (const key of tool.inputSchema.required ?? [])
    if (!Object.hasOwn(input, key)) throw new Error(`${key} is required`)
  if (name === 'send_workspace_group_message') {
    parseGroupMessageInput({ requestId: input.request_id, workspaceIds: input.workspace_ids, content: input.content })
  } else if (name === 'get_workspace_group_message') {
    if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.request_id))
      throw new Error('Invalid request_id')
  } else {
    if (input.dev_server_running !== undefined && typeof input.dev_server_running !== 'boolean')
      throw new Error('Invalid dev_server_running')
    for (const key of ['tags', 'statuses']) {
      const value = input[key]
      if (value === undefined) continue
      if (
        !Array.isArray(value) ||
        value.length > (key === 'tags' ? 200 : statuses.length) ||
        new Set(value).size !== value.length ||
        value.some(
          (item) =>
            typeof item !== 'string' ||
            !item.trim() ||
            item.length > 200 ||
            (key === 'statuses' && !statuses.includes(item)),
        )
      )
        throw new Error(`Invalid ${key}`)
    }
    if (
      input.limit !== undefined &&
      (typeof input.limit !== 'number' ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_GROUP_MESSAGE_RECIPIENTS)
    )
      throw new Error('Invalid limit')
    if (
      input.offset !== undefined &&
      (typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0)
    )
      throw new Error('Invalid offset')
  }
  return input
}
