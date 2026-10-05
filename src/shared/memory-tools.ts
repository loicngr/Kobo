import { MEMORY_BODY_MAX_CHARS, MEMORY_PAGE_SIZE_MAX, MEMORY_TITLE_MAX_CHARS } from './memory.js'

export type MemoryToolName =
  | 'list_memory_scopes'
  | 'list_memories'
  | 'read_memory'
  | 'search_memories'
  | 'list_memory_operations'
  | 'remember'

export interface MemoryToolDefinition {
  name: MemoryToolName
  description: string
  inputSchema: { type: 'object'; properties: Record<string, object>; required: string[] }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }
}

export const MEMORY_TOOL_DEFINITIONS: MemoryToolDefinition[] = [
  {
    name: 'list_memory_scopes',
    description: 'List the global, project and workspace memory scopes available to this workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', pattern: '^\\d+$' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_PAGE_SIZE_MAX },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'list_memories',
    description: 'List applicable memories, or one of their exact scope IDs, with bounded pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', minLength: 1 },
        cursor: { type: 'string', pattern: '^\\d+$' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_PAGE_SIZE_MAX },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'read_memory',
    description: 'Read one memory by its exact scope and entry IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', minLength: 1 },
        entry_id: { type: 'string', minLength: 1 },
        cursor: {
          type: 'string',
          pattern: '^\\d+\\.\\d+$',
          description: 'Opaque revision-and-code-point offset cursor from the prior fragment.',
        },
        repeat: { type: 'boolean', description: 'Explicitly reread an unchanged fragment and spend budget again.' },
      },
      required: ['scope_id', 'entry_id'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'search_memories',
    description: 'Search memories in one exact applicable scope with bounded pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', minLength: 1 },
        query: { type: 'string', minLength: 1, maxLength: 200 },
        cursor: { type: 'string', pattern: '^\\d+$' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_PAGE_SIZE_MAX },
      },
      required: ['scope_id', 'query'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'list_memory_operations',
    description: 'List the bounded, content-free operation journal for one applicable scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', minLength: 1 },
        cursor: { type: 'string', pattern: '^\\d+$' },
        limit: { type: 'integer', minimum: 1, maximum: MEMORY_PAGE_SIZE_MAX },
      },
      required: ['scope_id'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'remember',
    description:
      'Create or update a concise memory; current mode may deny, apply, or propose the change. Available even when the retrieval budget is exhausted; never echoes the saved body.',
    inputSchema: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', minLength: 1 },
        expected_generation: { type: 'integer', minimum: 0 },
        key: { type: 'string', minLength: 1, maxLength: 80 },
        title: { type: 'string', minLength: 1, maxLength: MEMORY_TITLE_MAX_CHARS },
        body: { type: 'string', minLength: 1, maxLength: MEMORY_BODY_MAX_CHARS },
        entry_id: { type: 'string', minLength: 1 },
        expected_revision: { type: 'integer', minimum: 1 },
      },
      required: ['scope_id', 'expected_generation', 'key', 'title', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]
const toolNames = new Set<string>(MEMORY_TOOL_DEFINITIONS.map((tool) => tool.name))
const allowedKeys: Record<MemoryToolName, readonly string[]> = {
  list_memory_scopes: ['cursor', 'limit'],
  list_memories: ['scope_id', 'cursor', 'limit'],
  read_memory: ['scope_id', 'entry_id', 'cursor', 'repeat'],
  search_memories: ['scope_id', 'query', 'cursor', 'limit'],
  list_memory_operations: ['scope_id', 'cursor', 'limit'],
  remember: ['scope_id', 'expected_generation', 'key', 'title', 'body', 'entry_id', 'expected_revision'],
}
const requiredKeys: Record<MemoryToolName, readonly string[]> = {
  list_memory_scopes: [],
  list_memories: [],
  read_memory: ['scope_id', 'entry_id'],
  search_memories: ['scope_id', 'query'],
  list_memory_operations: ['scope_id'],
  remember: ['scope_id', 'expected_generation', 'key', 'title', 'body'],
}

export function isMemoryToolName(name: string): name is MemoryToolName {
  return toolNames.has(name)
}

/** External clients explicitly select a persisted scope or an existing workspace view. */
export const EXTERNAL_MEMORY_TOOL_DEFINITIONS: MemoryToolDefinition[] = MEMORY_TOOL_DEFINITIONS.map((tool) => {
  const properties = { ...tool.inputSchema.properties }
  properties.memory_context_id = {
    type: 'string',
    minLength: 12,
    maxLength: 128,
    description: 'Reuse the opaque response-budget handle returned by Kōbō.',
  }
  if (tool.name === 'list_memory_scopes') {
    properties.workspace_id = { type: 'string', minLength: 1 }
    properties.cursor = { type: 'string', pattern: '^\\d+$' }
    properties.limit = { type: 'integer', minimum: 1, maximum: MEMORY_PAGE_SIZE_MAX }
  } else if (
    tool.name === 'list_memories' ||
    tool.name === 'search_memories' ||
    tool.name === 'list_memory_operations'
  ) {
    properties.workspace_id = { type: 'string', minLength: 1 }
  }
  return {
    ...tool,
    description:
      tool.name === 'list_memory_scopes'
        ? 'List selectable existing scopes, or the exact global/project/workspace scopes applicable to an existing workspace.'
        : tool.description,
    inputSchema: {
      ...tool.inputSchema,
      properties,
      required: tool.inputSchema.required.filter(
        (key) => !(key === 'scope_id' && tool.name !== 'read_memory' && tool.name !== 'remember'),
      ),
    },
  }
})

/** Validate transport-independent snake_case arguments and reject caller provenance. */
export function validateMemoryToolArguments(
  name: string,
  value: unknown,
  allowWorkspaceView = false,
): Record<string, unknown> {
  if (!isMemoryToolName(name)) throw new TypeError('Unknown memory tool')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Arguments must be an object')
  const args = value as Record<string, unknown>
  const allowed = allowWorkspaceView
    ? EXTERNAL_MEMORY_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.inputSchema.properties
    : undefined
  const unexpected = Object.keys(args).find((key) => !(allowed ? key in allowed : allowedKeys[name].includes(key)))
  if (unexpected) throw new TypeError(`Unexpected argument: ${unexpected}`)
  const required = allowWorkspaceView
    ? (EXTERNAL_MEMORY_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema.required ?? [])
    : requiredKeys[name]
  const missing = required.find((key) => args[key] === undefined)
  if (missing) throw new TypeError(`Missing required argument: ${missing}`)
  for (const key of ['scope_id', 'workspace_id', 'entry_id'] as const) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim()))
      throw new TypeError(`Invalid ${key}`)
  }
  if (
    args.cursor !== undefined &&
    (typeof args.cursor !== 'string' ||
      !(name === 'read_memory' ? /^\d+\.\d+$/.test(args.cursor) : /^\d+$/.test(args.cursor)))
  )
    throw new TypeError('Invalid cursor')
  if (args.repeat !== undefined && (name !== 'read_memory' || typeof args.repeat !== 'boolean'))
    throw new TypeError('Invalid repeat flag')
  if (
    allowWorkspaceView &&
    args.memory_context_id !== undefined &&
    (typeof args.memory_context_id !== 'string' ||
      args.memory_context_id.length < 12 ||
      args.memory_context_id.length > 128)
  )
    throw new TypeError('Invalid memory_context_id')
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > MEMORY_PAGE_SIZE_MAX)
  )
    throw new TypeError('Invalid page size')
  if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200))
    throw new TypeError('Invalid search query')
  for (const key of ['expected_generation', 'expected_revision'] as const) {
    if (
      args[key] !== undefined &&
      (!Number.isSafeInteger(args[key]) || (args[key] as number) < (key === 'expected_generation' ? 0 : 1))
    )
      throw new TypeError(`Invalid ${key}`)
  }
  for (const key of ['key', 'title', 'body'] as const) {
    const max = key === 'key' ? 80 : key === 'title' ? MEMORY_TITLE_MAX_CHARS : MEMORY_BODY_MAX_CHARS
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > max))
      throw new TypeError(`Invalid ${key}`)
  }
  if (
    name === 'remember' &&
    args.entry_id !== undefined &&
    (args.expected_revision === undefined || args.key === undefined)
  )
    throw new TypeError('Updating a memory requires entry_id, expected_revision, and key')
  if (name === 'remember' && args.expected_revision !== undefined && args.entry_id === undefined)
    throw new TypeError('expected_revision requires entry_id')
  if (allowWorkspaceView && name !== 'list_memory_scopes') {
    const hasScope = typeof args.scope_id === 'string' && args.scope_id.length > 0
    const hasWorkspace = typeof args.workspace_id === 'string' && args.workspace_id.length > 0
    if (hasScope === hasWorkspace) throw new TypeError('Specify exactly one scope_id or workspace_id')
    if (name === 'read_memory' || name === 'remember') {
      if (!hasScope) throw new TypeError(`${name} requires an explicit scope_id`)
    }
  }
  return args
}
