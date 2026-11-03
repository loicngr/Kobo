import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { StartReviewRequest } from './review.js'

const fields = {
  engine: 'engine',
  model: 'model',
  reasoning_effort: 'reasoningEffort',
  agent_permission_mode: 'agentPermissionMode',
  additional_instructions: 'additionalInstructions',
  new_session: 'newSession',
  return_to_session: 'returnToSession',
} as const

export const START_CODE_REVIEW_TOOL: Tool = {
  name: 'start_code_review',
  description:
    'Start a code review with the same options and lifecycle as the Kōbō review dialog. Choose engine, model, reasoning effort, permissions and additional instructions. new_session defaults to true; false permits reusing an idle session when configuration is unchanged. A running primary gets a separate parallel reviewer. return_to_session optionally sends the report to the original session; it requires a resumable source. Omitted LLM options inherit the workspace configuration, with the same engine-change defaults and permission restrictions as the UI. Reviews inspect committed and uncommitted changes in the live worktree. Do not retry an uncertain or timed-out launch automatically: inspect workspace sessions first.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' },
      engine: { type: 'string', enum: ['claude-code', 'codex', 'mistral-vibe'] },
      model: { type: 'string', minLength: 1, maxLength: 200 },
      reasoning_effort: { type: 'string', minLength: 1, maxLength: 200 },
      agent_permission_mode: { type: 'string', enum: ['plan', 'bypass', 'strict', 'interactive'] },
      additional_instructions: { type: 'string', maxLength: 20_000 },
      new_session: { type: 'boolean', default: true },
      return_to_session: { type: 'boolean', default: false },
    },
    required: ['workspace_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}

export const INTERNAL_START_CODE_REVIEW_TOOL: Tool = {
  ...START_CODE_REVIEW_TOOL,
  description: `${START_CODE_REVIEW_TOOL.description} Bound to the calling agent's workspace; omit workspace_id.`,
  inputSchema: { ...START_CODE_REVIEW_TOOL.inputSchema, required: [] },
}

/** Validate both transports before routing to the review dialog's handler. */
export function validateCodeReviewArguments(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tool arguments must be an object')
  const input = raw as Record<string, unknown>
  const properties = START_CODE_REVIEW_TOOL.inputSchema.properties as Record<
    string,
    { type: string; minLength?: number; maxLength?: number; enum?: string[] }
  >
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown field: ${key}`)
    const property = properties[key]!
    if (property.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
    } else if (
      typeof value !== 'string' ||
      (property.minLength && !value.trim()) ||
      (property.maxLength && value.length > property.maxLength) ||
      (property.enum && !property.enum.includes(value)) ||
      value.includes('\0')
    )
      throw new Error(`Invalid ${key}`)
  }
  if (typeof input.workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.workspace_id))
    throw new Error('A single workspace_id is required')
  return input
}

export function codeReviewRequest(input: Record<string, unknown>): StartReviewRequest {
  return Object.fromEntries([
    ['newSession', true],
    ...Object.entries(fields)
      .filter(([key]) => Object.hasOwn(input, key))
      .map(([key, target]) => [target, input[key]]),
  ]) as StartReviewRequest
}
