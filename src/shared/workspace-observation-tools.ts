import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const workspace = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' }
const session = { ...workspace, description: 'Exact review session ID returned by get_code_review_status.' }
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  readOnly = true,
): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { workspace_id: workspace, ...properties },
      required: ['workspace_id', ...required],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: !readOnly,
    },
  }
}
const returnFields = {
  review_type: {
    type: 'string',
    enum: ['parallel', 'return'],
    description: 'Select the parallel reviewer or the sequential review return.',
  },
  session_id: session,
}
export const WORKSPACE_OBSERVATION_TOOLS: Tool[] = [
  tool(
    'get_code_review_status',
    'Read the parallel review and sequential review-return status, including exact reviewer session IDs. Null means no tracked review; use list_workspace_sessions for ordinary reviews without a return.',
  ),
  tool(
    'stop_code_review',
    'Stop only the exact parallel reviewer, without stopping the primary session. Does not stop an ordinary primary review. Do not automatically retry an uncertain result.',
    { session_id: session },
    ['session_id'],
    false,
  ),
  tool(
    'retry_code_review_return',
    'Retry delivery of an existing review report to its original session, using the same guards as the UI. Inspect status first; never automatically retry an uncertain delivery.',
    returnFields,
    ['review_type', 'session_id'],
    false,
  ),
  tool(
    'cancel_code_review_return',
    'Cancel the pending return of a review report using the UI lifecycle. This does not delete its report or stop the primary session.',
    returnFields,
    ['review_type', 'session_id'],
    false,
  ),
  tool(
    'list_agent_options',
    'Discover registered engines, model IDs, reasoning efforts and permission modes from the UI catalogues, plus current workspace selections. Catalogues do not guarantee provider account access. Select engine=mistral-vibe to discover native options in this workspace; model and agent_permission_mode optionally select the discovery context.',
    {
      engine: { type: 'string', enum: ['claude-code', 'codex', 'mistral-vibe'] },
      model: { type: 'string', minLength: 1, maxLength: 200 },
      agent_permission_mode: { type: 'string', enum: ['plan', 'bypass', 'strict', 'interactive'] },
    },
  ),
  tool(
    'get_setup_script_status',
    'Read the latest setup attempt outcome and bounded persisted output. preparing includes agent shutdown; a preparation failure has a null exitCode and an error. Unknown means no trustworthy completion record (legacy run, restart or expired history), never success. Logs may contain script secrets: do not repeat them unnecessarily. Use run_id and after_id from the response to paginate a fixed run; no automatic polling.',
    {
      run_id: workspace,
      after_id: workspace,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  ),
  tool(
    'list_workspace_tags',
    'List the configured tag catalogue and tags attached to this workspace. Names are case-sensitive. Does not enumerate other workspaces or change tags.',
  ),
]
export const INTERNAL_WORKSPACE_OBSERVATION_TOOLS = WORKSPACE_OBSERVATION_TOOLS.map(
  (definition): Tool => ({
    ...definition,
    description: `${definition.description} Bound to the calling workspace; omit workspace_id.`,
    inputSchema: {
      ...definition.inputSchema,
      required: definition.inputSchema.required?.filter((key) => key !== 'workspace_id'),
    },
  }),
)
export function isWorkspaceObservationTool(name: string): boolean {
  return WORKSPACE_OBSERVATION_TOOLS.some((definition) => definition.name === name)
}
export function validateWorkspaceObservationArguments(name: string, raw: unknown): Record<string, unknown> {
  const definition = WORKSPACE_OBSERVATION_TOOLS.find((item) => item.name === name)
  if (!definition || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tool arguments')
  const input = raw as Record<string, unknown>
  const properties = definition.inputSchema.properties as Record<
    string,
    {
      type: string
      minLength?: number
      maxLength?: number
      pattern?: string
      enum?: string[]
      minimum?: number
      maximum?: number
    }
  >
  for (const key of definition.inputSchema.required ?? [])
    if (!Object.hasOwn(input, key)) throw new Error(`Missing ${key}`)
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown field: ${key}`)
    const field = properties[key]!
    if (field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.minimum! || value > field.maximum!)
        throw new Error(`Invalid ${key}`)
    } else if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.includes('\0') ||
      value.length > (field.maxLength ?? 200) ||
      (field.enum && !field.enum.includes(value)) ||
      (field.pattern && !new RegExp(field.pattern).test(value))
    )
      throw new Error(`Invalid ${key}`)
  }
  if (
    name === 'list_agent_options' &&
    (input.model !== undefined || input.agent_permission_mode !== undefined) &&
    input.engine !== 'mistral-vibe'
  )
    throw new Error('Native options require engine=mistral-vibe')
  if (input.after_id !== undefined && input.run_id === undefined) throw new Error('after_id requires run_id')
  return input
}
