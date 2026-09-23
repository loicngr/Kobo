import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const workspace = { type: 'string', minLength: 1, maxLength: 200, description: 'Workspace ID from list_workspaces.' }
const session = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Session ID from list_workspace_sessions.',
}
function tool(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  readOnly = true,
): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
  }
}

export const WORKSPACE_DISCOVERY_TOOL = tool(
  'list_workspaces',
  'Discover Kōbō workspaces and their current status.',
  {
    include_archived: { type: 'boolean' },
  },
  [],
)

export const WORKSPACE_DIALOGUE_TOOLS: Tool[] = [
  tool('get_workspace', 'Read workspace metadata, tasks and current agent session.', { workspace_id: workspace }, [
    'workspace_id',
  ]),
  tool(
    'list_workspace_sessions',
    'List the sessions of a workspace to select a conversation.',
    { workspace_id: workspace },
    ['workspace_id'],
  ),
  tool(
    'read_workspace_messages',
    'Read a bounded chronological page of conversation fragments. Start without after_cursor; continue with nextCursor. Reuse the final cursor to poll for new replies. Concatenate assistant fragments with the same messageId and sessionId.',
    {
      workspace_id: workspace,
      session_id: session,
      after_cursor: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum source events scanned (default 100).' },
    },
    ['workspace_id'],
  ),
  tool(
    'send_workspace_message',
    'Send a message to an agent, resuming it if needed. Returns acceptance, not the agent reply; read_workspace_messages retrieves replies. Uses the configured permission mode and pauses active auto-loop. Do not retry blindly after an ambiguous connection failure. Do not send to your own workspace.',
    {
      workspace_id: workspace,
      session_id: session,
      content: { type: 'string', minLength: 1, maxLength: 100_000 },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Generate once per intended message; reuse on retries to prevent duplicate dispatch, including after restart. Reuse with different content/session is rejected.',
      },
    },
    ['workspace_id', 'content'],
    false,
  ),
  tool(
    'get_workspace_questions',
    'Read pending questions and whether a human tool approval is blocking the workspace.',
    { workspace_id: workspace },
    ['workspace_id'],
  ),
  tool(
    'answer_workspace_question',
    'Answer the current pending question using its exact tool_call_id. Answer keys are question IDs for Codex, question text for Claude. Tool permission requests require human approval in Kōbō.',
    {
      workspace_id: workspace,
      tool_call_id: { type: 'string', minLength: 1, maxLength: 200 },
      answers: { type: 'object', minProperties: 1, additionalProperties: { type: 'string' } },
    },
    ['workspace_id', 'tool_call_id', 'answers'],
    false,
  ),
]

export const EXTERNAL_MCP_TOOLS = [WORKSPACE_DISCOVERY_TOOL, ...WORKSPACE_DIALOGUE_TOOLS]

/** The low-level MCP server checks the envelope; validate tool arguments here. */
export function validateDialogueArguments(name: string, value: unknown): Record<string, unknown> {
  const definition = EXTERNAL_MCP_TOOLS.find((entry) => entry.name === name)
  if (!definition) throw new Error(`Unknown tool '${name}'`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object')
  const args = value as Record<string, unknown>
  const properties = definition.inputSchema.properties as Record<
    string,
    { type: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }
  >
  for (const key of definition.inputSchema.required ?? [])
    if (!Object.hasOwn(args, key)) throw new Error(`${key} is required`)
  for (const [key, input] of Object.entries(args)) {
    const property = properties[key]
    if (!Object.hasOwn(properties, key)) throw new Error(`Unknown argument '${key}'`)
    if (property.type === 'string') {
      if (typeof input !== 'string' || !input.trim() || input.length > (property.maxLength ?? 100_000))
        throw new Error(`${key} must be a non-empty string within its length limit`)
    } else if (property.type === 'boolean') {
      if (typeof input !== 'boolean') throw new Error(`${key} must be a boolean`)
    } else if (property.type === 'integer') {
      if (
        typeof input !== 'number' ||
        !Number.isInteger(input) ||
        input < property.minimum! ||
        input > property.maximum!
      )
        throw new Error(`${key} is outside its allowed integer range`)
    } else if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length === 0 ||
      Object.values(input).some((answer) => typeof answer !== 'string' || answer.length > 100_000)
    ) {
      throw new Error(`${key} must be a non-empty object of string answers`)
    }
  }
  return args
}
