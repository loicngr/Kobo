import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, validateAttachments } from './attachments.js'

/** Base64 expansion of the shared upload limit, plus bounded JSON metadata. */
export const MAX_MCP_CREATION_REQUEST_BYTES = Math.ceil(MAX_ATTACHMENTS_BYTES / 3) * 4 + 1024 * 1024

type Schema = {
  type: 'object' | 'string' | 'boolean' | 'array' | ['object', 'null']
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: false
  minLength?: number
  maxLength?: number
  maxItems?: number
  enum?: string[]
  items?: Schema
  description?: string
}
const string = (maxLength = 200, minLength = 1): Schema => ({ type: 'string', minLength, maxLength })
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const effort = choice('auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max')
const engine = choice('claude-code', 'codex')
const path = string(4096)
const url = string(4096)
const titles: Schema = { type: 'array', items: string(20_000), maxItems: 500 }
const properties: Record<string, Schema> = {
  name: string(1000),
  project_path: path,
  source_branch: string(1024),
  working_branch: string(1024),
  engine,
  model: string(),
  reasoning_effort: effort,
  brainstorm_model: string(),
  brainstorm_reasoning_effort: effort,
  description: string(200_000, 0),
  tags: { type: 'array', items: string(200), maxItems: 100 },
  tasks: titles,
  acceptance_criteria: titles,
  agent_permission_mode: choice('plan', 'bypass', 'strict', 'interactive'),
  auto_loop: { type: 'boolean' },
  auto_loop_session_mode: choice('per_task', 'continuous'),
  skip_setup_script: { type: 'boolean' },
  auto_loop_final_review: {
    ...object({ engine, model: string(), reasoning_effort: effort, additional_instructions: string(20_000, 0) }, [
      'engine',
      'model',
      'reasoning_effort',
    ]),
    type: ['object', 'null'],
  },
  workflow_policy: object({
    commit: choice('manual', 'automatic'),
    push: choice('manual', 'automatic'),
    publish: choice('manual', 'automatic'),
  }),
  notion_url: {
    ...url,
    description:
      'Import this Notion ticket before launching the agent. Requires an enabled, configured Notion integration.',
  },
  notion_page_id: {
    ...string(),
    description:
      'Optional stored Notion page identifier. Does not import content on its own; provide notion_url to import the ticket.',
  },
  sentry_url: url,
  pr_url: url,
  worktree_path: path,
  comparison_id: string(),
  creation_id: string(),
  attachments: {
    type: 'array',
    maxItems: MAX_ATTACHMENTS,
    items: object(
      { name: string(255), mime_type: string(200, 0), data_base64: string(Math.ceil(MAX_ATTACHMENTS_BYTES / 3) * 4) },
      ['name', 'mime_type', 'data_base64'],
    ),
  },
  pr_checkout: object(
    {
      fingerprint: string(),
      decisions: object({
        existingWorkspace: choice('open', 'continue'),
        archivedWorkspace: choice('unarchive', 'continue'),
        purgedWorktree: choice('restore'),
        orphanWorktree: choice('attach', 'create-elsewhere'),
        pathCollision: object({ worktreePath: path }, ['worktreePath']),
        localChanges: choice('stash', 'commit', 'discard', 'keep'),
        ongoingOperation: choice('abort', 'cancel'),
        divergence: choice('fast-forward', 'rebase', 'reset-hard', 'keep'),
      }),
    },
    ['fingerprint', 'decisions'],
  ),
}
const schemas = {
  create_workspace: object(properties, ['name', 'project_path']),
  diagnose_workspace_pr: object({ project_path: path, pr_url: url }, ['project_path', 'pr_url']),
}
export const WORKSPACE_CREATION_TOOLS: Tool[] = [
  {
    name: 'create_workspace',
    description:
      'Create a Kōbō workspace with the same configuration as the create form, including final review, workflow policy, imports and inline base64 attachments (10 files, 50 MiB total). Plain creation requires source_branch and working_branch; worktree_path requires source_branch. A pr_url derives canonical branches and diagnoses checkout first. Unsafe or ambiguous checkout returns requiresAction and a fingerprint: repeat with explicit pr_checkout decisions. Never silently discards local work. Existing workspaces can be opened or explicitly unarchived; no duplicate is created. skip_setup_script defaults to true for PR checkout. Project must be configured in Kōbō.',
    inputSchema: schemas.create_workspace as Tool['inputSchema'],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'diagnose_workspace_pr',
    description:
      'Read the canonical PR and local checkout state for a configured project. Returns report, pr and fingerprint for explicit create_workspace pr_checkout decisions; creates no workspace and applies no checkout changes.',
    inputSchema: schemas.diagnose_workspace_pr as Tool['inputSchema'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
]

export function isWorkspaceCreationTool(name: string): boolean {
  return Object.hasOwn(schemas, name)
}

function validate(schema: Schema, value: unknown, label: string): void {
  if (value === null && Array.isArray(schema.type)) return
  if (schema.type === 'object' || Array.isArray(schema.type)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    const input = value as Record<string, unknown>
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(schema.properties!, key)) throw new Error(`Unknown field ${label}.${key}`)
      validate(schema.properties![key]!, input[key], `${label}.${key}`)
    }
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(input, key)) throw new Error(`${label}.${key} is required`)
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems!)
      throw new Error(`${label} must be an array with at most ${schema.maxItems} entries`)
    for (const item of value) validate(schema.items!, item, label)
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  } else {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.minLength && !value.trim()) ||
      (schema.enum && !schema.enum.includes(value))
    )
      throw new Error(`Invalid ${label}`)
  }
}

/** Validates before dispatch, including uploads before a PR checkout can mutate Git. */
export function validateWorkspaceCreationArguments(name: string, input: unknown): Record<string, unknown> {
  if (!isWorkspaceCreationTool(name)) throw new Error(`Unknown workspace creation tool: ${name}`)
  validate(schemas[name as keyof typeof schemas], input, name)
  const value = input as Record<string, unknown>
  for (const key of ['notion_url', 'sentry_url', 'pr_url']) {
    if (value[key] !== undefined) {
      const parsed = new URL(value[key] as string)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error(`Invalid ${key}`)
    }
  }
  if (name === 'create_workspace') {
    const { attachments: _attachments, ...metadataFields } = value
    // Keep room for multipart file headers within the downstream 1 MiB allowance.
    if (new TextEncoder().encode(JSON.stringify(metadataFields)).byteLength > 960 * 1024)
      throw new Error('Workspace creation metadata exceeds 960 KiB')
    if (!value.pr_url && (!value.source_branch || (!value.worktree_path && !value.working_branch)))
      throw new Error('source_branch and working_branch are required unless using a PR or existing worktree')
    if (value.pr_checkout && !value.pr_url) throw new Error('pr_checkout requires pr_url')
    const files = (value.attachments ?? []) as Array<{ name: string; mime_type: string; data_base64: string }>
    const metadata = files.map((file) => {
      if (/[/\\]/.test(file.name) || file.name === '.' || file.name === '..')
        throw new Error('Attachment name must be a filename, not a path')
      const data = file.data_base64
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        throw new Error('Attachment data_base64 must be canonical base64')
      // Reject non-zero pad bits too, before the server allocates decoded buffers.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      if (
        (data.endsWith('==') && (alphabet.indexOf(data.at(-3)!) & 15) !== 0) ||
        (!data.endsWith('==') && data.endsWith('=') && (alphabet.indexOf(data.at(-2)!) & 3) !== 0)
      )
        throw new Error('Attachment data_base64 must be canonical base64')
      return {
        name: file.name,
        type: file.mime_type,
        size: (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
      }
    })
    const error = validateAttachments(metadata)
    if (error) throw new Error(`Invalid attachments: ${error}`)
  }
  return value
}
